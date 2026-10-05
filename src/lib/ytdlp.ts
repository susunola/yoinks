import {spawn, type ChildProcess} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'

const YOINKS_DIR = path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/**
 * Resolve a usable yt-dlp binary: system install first, then a previously
 * downloaded copy, then download the standalone binary from GitHub releases.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'])) {
    refreshYtDlp(local)
    return local
  }

  onStatus('first run: fetching yt-dlp…')
  await fs.mkdir(YOINKS_DIR, {recursive: true})

  const url = `${RELEASE_BASE}/${ytDlpAssetName()}`
  const response = await fetch(url, {signal})
  if (!response.ok || !response.body) {
    throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
  }

  const tmp = `${local}.download`
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
  await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, local)
  return local
}

let ffmpegLookup: Promise<string | undefined> | undefined

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. Returns undefined if neither exists — yt-dlp
 * still works for single-file formats without it. Cached for the process.
 */
export function findFfmpeg(): Promise<string | undefined> {
  ffmpegLookup ??= locateFfmpeg()
  return ffmpegLookup
}

async function locateFfmpeg(): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'])) return undefined // on PATH, yt-dlp finds it itself
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return ffmpegPath
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return undefined
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000

/** Refresh a managed binary in the background once it is a week old. Never blocks a download. */
export function refreshYtDlp(binary: string): void {
  if (binary === 'yt-dlp') return
  void (async () => {
    try {
      const stat = await fs.stat(binary)
      if (Date.now() - stat.mtimeMs < STALE_MS) return
      const child = spawn(binary, ['-U'], {stdio: 'ignore'})
      child.on('close', code => {
        if (code === 0) void fs.utimes(binary, new Date(), new Date()).catch(() => undefined)
      })
    } catch {
      // a missing binary is ensureYtDlp's problem, not the background refresh
    }
  })()
}

export async function forgetInfoJson(infoJsonPath?: string): Promise<void> {
  if (!infoJsonPath) return
  await fs.rm(infoJsonPath, {force: true}).catch(() => undefined)
}

export function shouldRetryWithoutInfo(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /expired|403|401|unable to download|http error|fragment|signature/i.test(message)
}

export type VideoInfo = {
  title: string
  uploader?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type ProbeResult = {
  info: VideoInfo
  /** Raw -J output saved to disk so downloads can skip re-extraction via --load-info-json. */
  infoJsonPath: string
}

export async function probe(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, ['-J', '--no-playlist', '--no-warnings', url], {signal})
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(Buffer.concat(errors).toString()) || `yt-dlp exited with code ${code}`))
      } else {
        resolve(Buffer.concat(chunks).toString())
      }
    })
  })

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  const infoJsonPath = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    const audioId = bestAudio?.format_id
    const format = muxed || !audioId ? best.format_id : `${best.format_id}+${audioId}/${best.format_id}`
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: ['-f', format, '--merge-output-format', 'mp4'],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `audio only · mp3${audioSizeLabel}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

let activeChild: ChildProcess | undefined

function killActive(): void {
  const child = activeChild
  if (!child?.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      // not a process-group leader — fall through
    }
  }
  child.kill('SIGTERM')
}

process.on('exit', killActive)

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
    infoJsonPath?: string
    choice: DownloadChoice
    outDir: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '--concurrent-fragments',
    '8',
    '-o',
    path.join(opts.outDir, '%(title).60s [%(id)s].%(ext)s'),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    void fs.mkdir(opts.outDir, {recursive: true}).then(
      () => {
        const child = spawn(opts.ytdlp, args, {signal, detached: process.platform !== 'win32'})
        activeChild = child
        const onAbort = () => killActive()
        signal?.addEventListener('abort', onAbort, {once: true})

        let stderr = ''
        let filepath = ''
        let part = 0
        let totalParts = 1
        let lastDownloaded = 0
        let lastEmit = 0
        let buffer = ''
        // every file yt-dlp writes this run, so a cancel can clean up after itself
        const destinations: string[] = []

        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line) continue
            if (line.startsWith(PROGRESS_PREFIX)) {
              const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
              const downloadedBytes = toNumber(downloaded) ?? 0
              if (downloadedBytes < lastDownloaded) part++
              lastDownloaded = downloadedBytes
              const now = Date.now()
              const totalBytes = toNumber(total) ?? toNumber(totalEstimate)
              if (now - lastEmit < 150 && downloadedBytes !== totalBytes) continue
              lastEmit = now
              handlers.onProgress({
                downloadedBytes,
                totalBytes,
                speed: toNumber(speed),
                eta: toNumber(eta),
                part,
                totalParts,
              })
            } else if (line.includes('Downloading 1 format(s):')) {
              // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
              totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
            } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
              const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
              const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
              const target = merging ?? extracting
              if (target) destinations.push(target)
              handlers.onProcessing()
            } else if (line.startsWith('[download] Destination: ')) {
              destinations.push(line.slice('[download] Destination: '.length))
            } else if (path.isAbsolute(line)) {
              filepath = line
            }
          }
        })
        child.stderr.on('data', chunk => (stderr += chunk))
        child.on('error', reject)
        child.on('close', code => {
          activeChild = undefined
          signal?.removeEventListener('abort', onAbort)
          if (signal?.aborted) {
            // cancelled on purpose — don't leave half-written files behind
            void removePartials(destinations)
            reject(new Error('Download cancelled.'))
            return
          }
          if (code === 0 && filepath) {
            resolve(filepath)
          } else {
            reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
          }
        })
      },
      reject,
    )
  })
}

function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`])
      .map(file => fs.rm(file, {force: true})),
  )
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
