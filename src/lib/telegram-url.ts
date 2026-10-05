export type TelegramLink =
  | {kind: 'private-message'; chatId: string; messageId: number}
  | {kind: 'invite'; hash: string}
  | {kind: 'public-message'; username: string; messageId: number}

function telegramHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  return host === 't.me' || host === 'telegram.me' || host === 'telegram.dog'
}

/**
 * Classify a t.me link. Public posts stay on yt-dlp; private-message and
 * invite links need the saved user session.
 */
export function parseTelegramLink(input: string): TelegramLink | undefined {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!telegramHost(url.hostname)) return undefined

  const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part))
  if (parts.length === 0) return undefined

  const head = parts[0]!
  if (head.startsWith('+') && head.length > 1) return {kind: 'invite', hash: head.slice(1)}
  if (head === 'joinchat' && parts[1]) return {kind: 'invite', hash: parts[1]}
  if (head === 'c' && parts[1] && parts[2] && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
    return {kind: 'private-message', chatId: parts[1], messageId: Number(parts[2])}
  }
  // t.me/<username>/<id> — public embed, yt-dlp first
  if (parts[1] && /^\d+$/.test(parts[1]) && !['s', 'share', 'addstickers', 'addemoji', 'proxy'].includes(head)) {
    return {kind: 'public-message', username: head, messageId: Number(parts[1])}
  }
  return undefined
}

export function telegramSessionRequired(link: TelegramLink): boolean {
  return link.kind !== 'public-message'
}
