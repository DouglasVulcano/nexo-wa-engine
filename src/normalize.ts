import { addressFrom, isOneToOneJid, normalizeJid } from './jid'
import type { EngineMessage, MediaInfo, MediaRef, MessageKind, MessageStatus, PeerAddress, Presence, Quoted } from './protocol'

/**
 * Baileys message -> normalized `EngineMessage`. Works on structural shapes (not
 * Baileys types) so it is testable without the library.
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface RawMessage {
  key: {
    remoteJid?: string | null
    fromMe?: boolean | null
    id?: string | null
    participant?: string | null
    /** Alternate address of the chat (PN for a LID chat), Baileys 7. */
    remoteJidAlt?: string | null
  }
  message?: unknown
  messageTimestamp?: unknown
  status?: number | null
  pushName?: string | null
}

export type Normalized =
  | { type: 'message'; message: EngineMessage }
  | { type: 'delete'; peer: PeerAddress; messageId: string }

/** number | string | Long-like ({low, high} or toNumber()) -> number; 0 when unreadable. */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') return Number(v) || 0
  if (isObj(v)) {
    if (typeof v.toNumber === 'function') return (v.toNumber as () => number)()
    if (typeof v.low === 'number') return v.low + (typeof v.high === 'number' ? v.high * 4294967296 : 0)
  }
  return 0
}

/** Baileys timestamps are seconds; tolerate values already in ms. */
export function toMillis(v: unknown): number {
  const n = toNumber(v)
  if (n <= 0) return Date.now()
  return n > 1e12 ? n : n * 1000
}

/** proto Status: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED. */
export function mapStatus(n: number | null | undefined): MessageStatus {
  switch (n) {
    case 0:
      return 'failed'
    case 2:
      return 'sent'
    case 3:
      return 'delivered'
    case 4:
      return 'read'
    case 5:
      return 'played'
    default:
      return 'pending'
  }
}

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage'
]

/** Peels the wrapper envelopes (disappearing, view-once, captioned document). */
export function unwrapContent(content: unknown): Obj | null {
  let cur = isObj(content) ? content : null
  for (let i = 0; cur && i < 5; i++) {
    const w = WRAPPERS.find((k) => isObj(cur?.[k]))
    const inner = w ? (cur[w] as Obj).message : null
    if (!isObj(inner)) break
    cur = inner
  }
  return cur
}

const SKIPPED = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'editedMessage'
])

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Short text for a quoted message or a list preview. */
export function previewOf(content: unknown): string {
  const c = unwrapContent(content)
  if (!c) return ''
  const ext = isObj(c.extendedTextMessage) ? c.extendedTextMessage : null
  const text = str(c.conversation) ?? str(ext?.text)
  if (text) return text.slice(0, 200)
  for (const [key, label] of [
    ['imageMessage', '[imagem]'],
    ['videoMessage', '[vídeo]'],
    ['audioMessage', '[áudio]'],
    ['documentMessage', '[documento]'],
    ['stickerMessage', '[figurinha]']
  ] as const) {
    const m = c[key]
    if (isObj(m)) return str(m.caption)?.slice(0, 200) ?? label
  }
  return ''
}

function mediaOf(m: Obj, withName: boolean): MediaInfo {
  const seconds = toNumber(m.seconds)
  const bytes = toNumber(m.fileLength)
  return {
    mime: str(m.mimetype) ?? 'application/octet-stream',
    fileName: withName ? str(m.fileName) : null,
    bytes: bytes > 0 ? bytes : null,
    seconds: seconds > 0 ? seconds : null
  }
}

const b64 = (v: unknown): string | null => {
  if (typeof v === 'string') return v || null
  if (v instanceof Uint8Array) return v.length ? Buffer.from(v).toString('base64') : null
  return null
}

function refOf(type: MediaRef['type'], m: Obj): MediaRef | null {
  const mediaKey = b64(m.mediaKey)
  const directPath = str(m.directPath)
  const url = str(m.url)
  if (!mediaKey || (!directPath && !url)) return null
  const len = toNumber(m.fileLength)
  return {
    type,
    mime: str(m.mimetype) ?? 'application/octet-stream',
    mediaKey,
    directPath,
    url,
    fileEncSha256: b64(m.fileEncSha256),
    fileSha256: b64(m.fileSha256),
    fileLength: len > 0 ? len : null
  }
}

function contextOf(c: Obj): Obj | null {
  for (const k of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']) {
    const m = c[k]
    if (isObj(m) && isObj(m.contextInfo)) return m.contextInfo
  }
  return null
}

/** The account this socket is logged in as, to tell who wrote a quoted message. */
export interface OwnIdentity {
  jid: string | null
  lid: string | null
}

/**
 * Who wrote the quoted message: its `participant` against our own JID/LID. When WhatsApp omits
 * it (1:1 chats), assume the other side of the message that quotes it.
 */
function quotedOf(c: Obj, own: OwnIdentity | undefined, messageFromMe: boolean): Quoted | null {
  const ctx = contextOf(c)
  const id = str(ctx?.stanzaId)
  if (!ctx || !id) return null
  const participant = normalizeJid(str(ctx.participant))
  const fromMe = participant === null ? !messageFromMe : participant === own?.jid || participant === own?.lid
  return { id, fromMe, preview: previewOf(ctx.quotedMessage) }
}

interface Extracted {
  kind: MessageKind
  text: string | null
  media: MediaInfo | null
  ref: MediaRef | null
}

function extract(c: Obj): Extracted | null {
  const ext = isObj(c.extendedTextMessage) ? c.extendedTextMessage : null
  const text = str(c.conversation) ?? str(ext?.text)
  if (text) return { kind: 'text', text, media: null, ref: null }
  if (isObj(c.imageMessage)) {
    return { kind: 'image', text: str(c.imageMessage.caption), media: mediaOf(c.imageMessage, false), ref: refOf('image', c.imageMessage) }
  }
  if (isObj(c.videoMessage)) {
    return { kind: 'video', text: str(c.videoMessage.caption), media: mediaOf(c.videoMessage, false), ref: refOf('video', c.videoMessage) }
  }
  if (isObj(c.audioMessage)) {
    return {
      kind: c.audioMessage.ptt === true ? 'voice' : 'audio',
      text: null,
      media: mediaOf(c.audioMessage, false),
      ref: refOf('audio', c.audioMessage)
    }
  }
  if (isObj(c.documentMessage)) {
    return { kind: 'document', text: str(c.documentMessage.caption), media: mediaOf(c.documentMessage, true), ref: refOf('document', c.documentMessage) }
  }
  if (isObj(c.stickerMessage)) return { kind: 'sticker', text: null, media: mediaOf(c.stickerMessage, false), ref: refOf('sticker', c.stickerMessage) }
  const keys = Object.keys(c).filter((k) => !SKIPPED.has(k))
  return keys.length > 0 ? { kind: 'other', text: null, media: null, ref: null } : null
}

/** Peer (the other side of the 1:1 chat) of a key; null for groups, status and broadcasts. */
export function peerOfKey(key: RawMessage['key']): PeerAddress | null {
  if (!isOneToOneJid(normalizeJid(key.remoteJid))) return null
  return addressFrom(key.remoteJid, key.remoteJidAlt)
}

export function normalizeMessage(raw: RawMessage, history: boolean, own?: OwnIdentity): Normalized | null {
  const id = raw.key.id
  const peer = peerOfKey(raw.key)
  if (!id || !peer) return null
  const content = unwrapContent(raw.message)
  if (!content) return null

  const proto = isObj(content.protocolMessage) ? content.protocolMessage : null
  if (proto) {
    const target = isObj(proto.key) ? str(proto.key.id) : null
    // type 0 = REVOKE
    return proto.type === 0 && target ? { type: 'delete', peer, messageId: target } : null
  }

  const x = extract(content)
  if (!x) return null
  const fromMe = raw.key.fromMe === true
  return {
    type: 'message',
    message: {
      id,
      peer,
      fromMe,
      ts: toMillis(raw.messageTimestamp),
      kind: x.kind,
      text: x.text,
      media: x.media,
      mediaRef: x.ref,
      quoted: quotedOf(content, own, fromMe),
      status: fromMe ? mapStatus(raw.status) : 'delivered',
      pushName: fromMe ? null : str(raw.pushName),
      history
    }
  }
}

const PRESENCES = new Set<Presence>(['available', 'unavailable', 'composing', 'recording', 'paused'])
export const mapPresence = (p: unknown): Presence =>
  typeof p === 'string' && PRESENCES.has(p as Presence) ? (p as Presence) : 'unavailable'
