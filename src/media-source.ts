/**
 * Where a received media may be fetched from. The `url` and `directPath` come from the sender's
 * message, so they are attacker-controlled: Baileys builds `https://<host><directPath>` and even
 * takes the HOST from `url`, which would let a crafted message make this process request any
 * address (SSRF: loopback services, the cloud metadata endpoint, internal hosts). Only WhatsApp's
 * own media hosts are accepted, and a `directPath` is never allowed to change the authority.
 */

const HOST_SUFFIX = '.whatsapp.net'
/** Leading slash, then path characters only: no `@`, backslash, whitespace or control characters. */
const SAFE_PATH = /^\/[A-Za-z0-9._~\/%+=&?,:-]{1,2048}$/

export interface MediaSource {
  directPath?: string
  url?: string
}

export function isWhatsAppMediaUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  const host = u.hostname.toLowerCase()
  return host.endsWith(HOST_SUFFIX) && host.length > HOST_SUFFIX.length
}

export function isSafeDirectPath(p: string): boolean {
  return SAFE_PATH.test(p) && !p.includes('..') && !p.startsWith('//')
}

/** The only source the downloader may use for this reference, or null when none is trustworthy. */
export function safeMediaSource(ref: { directPath: string | null; url: string | null }): MediaSource | null {
  // A direct path always wins and always goes to the default media host: the `url` is not even
  // passed along, since the library would take the host from it.
  if (ref.directPath !== null && ref.directPath !== '') return isSafeDirectPath(ref.directPath) ? { directPath: ref.directPath } : null
  if (ref.url && isWhatsAppMediaUrl(ref.url)) return { url: ref.url }
  return null
}
