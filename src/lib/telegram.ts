import {createRequire} from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import {stdin as input, stdout as output} from 'node:process'
import type {DownloadProgress} from './ytdlp.js'
import type {TelegramLink} from './telegram-url.js'

const require = createRequire(import.meta.url)

const YOINKS_DIR = path.join(os.homedir(), '.yoinks')
const SESSION_FILE = path.join(YOINKS_DIR, 'telegram.session')
const CONFIG_FILE = path.join(YOINKS_DIR, 'telegram.json')

type TelegramConfig = {apiId: number; apiHash: string}

type TelegramMessage = {
  message?: string
  groupedId?: bigint
  file?: {name?: string; ext?: string}
  media?: unknown
  downloadMedia: (params?: {
    outputFile?: string
    progressCallback?: (downloaded: bigint, total: bigint) => void
  }) => Promise<string | Buffer | undefined>
}

type TelegramClientLike = {
  connect: () => Promise<void>
  destroy: () => Promise<void>
  checkAuthorization: () => Promise<boolean>
  getEntity: (entity: string) => Promise<unknown>
  getMessages: (entity: unknown, params: {ids: number[]}) => Promise<TelegramMessage[]>
  downloadMedia: (
    message: TelegramMessage,
    params?: {outputFile?: string; progressCallback?: (downloaded: bigint, total: bigint) => void},
  ) => Promise<string | Buffer | undefined>
  invoke: (request: unknown) => Promise<{chat?: {id?: bigint; title?: string}; chats?: Array<{id?: bigint; title?: string}>}>
  start: (params: {
    phoneNumber: () => Promise<string>
    phoneCode: () => Promise<string>
    password: () => Promise<string>
    onError: (error: Error) => void
  }) => Promise<void>
  session: {save: () => string}
}

export function telegramLoginHint(): string {
  return 'private Telegram link needs a login. Run yoinks --telegram-login once, then paste it again.'
}

export async function hasTelegramSession(): Promise<boolean> {
  try {
    const [session, config] = await Promise.all([fs.readFile(SESSION_FILE, 'utf8'), fs.readFile(CONFIG_FILE, 'utf8')])
    if (!session.trim()) return false
    const parsed = JSON.parse(config) as Partial<TelegramConfig>
    return Number.isInteger(parsed.apiId) && Boolean(parsed.apiHash)
  } catch {
    return false
  }
}

export async function logoutTelegram(): Promise<void> {
  await Promise.allSettled([fs.rm(SESSION_FILE, {force: true}), fs.rm(CONFIG_FILE, {force: true})])
}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({input, output})
  try {
    return (await rl.question(prompt)).trim()
  } finally {
    rl.close()
  }
}

async function writeSecret(file: string, contents: string): Promise<void> {
  await fs.mkdir(YOINKS_DIR, {recursive: true})
  await fs.writeFile(file, contents, {mode: 0o600})
  await fs.chmod(file, 0o600)
}

function loadGram() {
  const {TelegramClient, Api} = require('teleproto') as {
    TelegramClient: new (session: unknown, apiId: number, apiHash: string, opts: unknown) => TelegramClientLike
    Api: {
      messages: {
        CheckChatInvite: new (params: {hash: string}) => unknown
        ImportChatInvite: new (params: {hash: string}) => unknown
      }
    }
  }
  const {StringSession} = require('teleproto/sessions') as {
    StringSession: new (value: string) => unknown
  }
  return {TelegramClient, StringSession, Api}
}

function clientOptions(): {connectionRetries: number; baseLogger?: unknown} {
  try {
    const {Logger} = require('teleproto/extensions/Logger') as {Logger: new (level: string) => unknown}
    return {connectionRetries: 5, baseLogger: new Logger('none')}
  } catch {
    return {connectionRetries: 5}
  }
}

export async function loginTelegram(): Promise<void> {
  if (!input.isTTY) throw new Error('yoinks --telegram-login needs an interactive terminal.')
  console.log('Create an app at https://my.telegram.org to get an api_id and api_hash.')
  console.log('The session stays in ~/.yoinks and is only used for chats this account can already open.')
  const apiId = Number.parseInt(await ask('api_id: '), 10)
  if (!Number.isInteger(apiId) || apiId <= 0) throw new Error('api_id must be a positive integer.')
  const apiHash = await ask('api_hash: ')
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) throw new Error('api_hash should be the 32-character hex from my.telegram.org.')
  const phoneNumber = await ask('phone number (international, e.g. +15551212): ')
  if (!phoneNumber.startsWith('+')) throw new Error('phone number must include the country code, like +15551212.')

  const {TelegramClient, StringSession} = loadGram()
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, clientOptions())
  await client.start({
    phoneNumber: async () => phoneNumber,
    phoneCode: () => ask('code from Telegram: '),
    password: () => ask('2FA password (empty if you have none): '),
    onError: error => console.error(error.message),
  })
  await writeSecret(CONFIG_FILE, `${JSON.stringify({apiId, apiHash})}\n`)
  await writeSecret(SESSION_FILE, client.session.save())
  await client.destroy()
  console.log('saved Telegram session to ~/.yoinks/telegram.session')
}

async function readConfig(): Promise<TelegramConfig> {
  const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) as Partial<TelegramConfig>
  if (!Number.isInteger(parsed.apiId) || !parsed.apiHash) throw new Error(telegramLoginHint())
  return {apiId: parsed.apiId, apiHash: parsed.apiHash}
}

async function openClient(signal?: AbortSignal): Promise<TelegramClientLike> {
  if (signal?.aborted) throw new Error('Download cancelled.')
  const {TelegramClient, StringSession} = loadGram()
  const config = await readConfig()
  const saved = await fs.readFile(SESSION_FILE, 'utf8')
  const client = new TelegramClient(new StringSession(saved.trim()), config.apiId, config.apiHash, clientOptions())
  const onAbort = () => void client.destroy()
  signal?.addEventListener('abort', onAbort, {once: true})
  try {
    await client.connect()
    if (!(await client.checkAuthorization())) throw new Error('Telegram session expired. Run yoinks --telegram-login again.')
    return client
  } catch (error) {
    signal?.removeEventListener('abort', onAbort)
    await client.destroy().catch(() => undefined)
    throw error
  }
}

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return (cleaned || 'telegram-file').slice(0, 80)
}

async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename
  for (let index = 0; index < 100; index++) {
    const candidate = path.join(dir, index === 0 ? filename : `${stem}-${index + 1}${ext}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

function chatLabel(chat: {id?: bigint; title?: string} | undefined): string {
  if (!chat) return 'that chat'
  const title = chat.title || 'that chat'
  const id = chat.id?.toString()
  if (!id) return title
  const bare = id.startsWith('-100') ? id.slice(4) : id.replace(/^-/, '')
  return `${title}. paste https://t.me/c/${bare}/<message id> to download one file`
}

export async function acceptTelegramInvite(hash: string, signal?: AbortSignal): Promise<string> {
  const client = await openClient(signal)
  try {
    const {Api} = loadGram()
    const checked = await client.invoke(new Api.messages.CheckChatInvite({hash}))
    if (checked.chat) return `already in ${chatLabel(checked.chat)}`
    const imported = await client.invoke(new Api.messages.ImportChatInvite({hash}))
    return `joined ${chatLabel(imported.chats?.[0])}`
  } finally {
    await client.destroy().catch(() => undefined)
  }
}

export async function downloadTelegram(
  link: Exclude<TelegramLink, {kind: 'invite'}>,
  outDir: string,
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const client = await openClient(signal)
  let lastEmit = 0
  try {
    const entity =
      link.kind === 'private-message' ? await client.getEntity(`-100${link.chatId}`) : await client.getEntity(link.username)
    const messages = await client.getMessages(entity, {ids: [link.messageId]})
    const message = messages[0]
    if (!message?.media) throw new Error('that message has no downloadable media, or this account cannot see it.')
    await fs.mkdir(outDir, {recursive: true})
    const filename = safeName(message.file?.name || `telegram-${link.messageId}${message.file?.ext || ''}`)
    const dest = await uniquePath(outDir, filename)
    const saved = await message.downloadMedia({
      outputFile: dest,
      progressCallback: (downloaded, total) => {
        const now = Date.now()
        if (now - lastEmit < 150 && downloaded !== total) return
        lastEmit = now
        onProgress({
          downloadedBytes: Number(downloaded),
          totalBytes: total > 0n ? Number(total) : undefined,
          part: 0,
          totalParts: 1,
        })
      },
    })
    if (signal?.aborted) throw new Error('Download cancelled.')
    if (typeof saved === 'string') return saved
    if (Buffer.isBuffer(saved)) {
      await fs.writeFile(dest, saved)
      return dest
    }
    return dest
  } finally {
    await client.destroy().catch(() => undefined)
  }
}
