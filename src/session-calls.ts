import type { EngineCalls } from './protocol'
import { RpcError } from './rpc'
import type { WaSocket } from './lib-types'

/**
 * Outgoing messages of a session, split from `session.ts`: text, media, and the two small memories
 * that go with sending (what was sent, for Baileys' retry `getMessage`; which address each message
 * lives on, so read receipts and deletes use the right chat id, `@lid` or phone).
 */

const SENT_MEMORY = 200
const ARRIVED_MEMORY = 2000
/** Largest media the engine will upload (the app caps lower per kind). */
const MAX_UPLOAD_BYTES = 70 * 1024 * 1024
const noop = (): void => undefined

export interface CallsContext {
  live(): WaSocket
  jidOf(to: EngineCalls['sendText']['args']['to']): string
  wait(ms: number): Promise<void>
  now(): number
  downloadMedia(ref: EngineCalls['downloadMedia']['args']['ref'], maxBytes: number): Promise<Uint8Array>
}

export class SessionCalls {
  private readonly sent = new Map<string, unknown>()
  private readonly arrivedOn = new Map<string, string>()
  private online = false

  constructor(private readonly ctx: CallsContext) {}

  /** Content of a message we sent, for Baileys' retry requests. */
  sentContent(id: string): unknown {
    return this.sent.get(id)
  }

  /** The chat address a message id was seen on. */
  addressOf(id: string): string | undefined {
    return this.arrivedOn.get(id)
  }

  /** A new socket always starts offline. */
  resetOnline(): void {
    this.online = false
  }

  noteChat(id: string, jid: string): void {
    this.arrivedOn.set(id, jid)
    if (this.arrivedOn.size > ARRIVED_MEMORY) this.arrivedOn.delete(this.arrivedOn.keys().next().value as string)
  }

  private remember(id: string, content: unknown): void {
    this.sent.set(id, content)
    if (this.sent.size > SENT_MEMORY) this.sent.delete(this.sent.keys().next().value as string)
  }

  private result(res: { key?: { id?: string | null }; messageTimestamp?: unknown } | undefined, fallbackId: string): { id: string; ts: number } {
    const ts = res?.messageTimestamp ? Number(res.messageTimestamp) * 1000 : this.ctx.now()
    return { id: res?.key?.id ?? fallbackId, ts: Number.isFinite(ts) && ts > 0 ? ts : this.ctx.now() }
  }

  async sendText(args: EngineCalls['sendText']['args']): Promise<EngineCalls['sendText']['ret']> {
    const sock = this.ctx.live()
    const jid = this.ctx.jidOf(args.to)
    const { text, options } = args
    if (options.composingMs && options.composingMs > 0) {
      await sock.sendPresenceUpdate('composing', jid)
      await this.ctx.wait(options.composingMs)
    }
    const quoted = options.quoted
      ? {
          key: { remoteJid: jid, id: options.quoted.id, fromMe: options.quoted.fromMe },
          message: { conversation: options.quoted.preview }
        }
      : undefined
    this.remember(options.messageId, { conversation: text })
    this.noteChat(options.messageId, jid)
    const res = await sock.sendMessage(jid, { text }, { messageId: options.messageId, ...(quoted ? { quoted } : {}) })
    if (options.composingMs) await sock.sendPresenceUpdate('paused', jid).catch(noop)
    return this.result(res, options.messageId)
  }

  async sendMedia(args: EngineCalls['sendMedia']['args']): Promise<EngineCalls['sendMedia']['ret']> {
    const sock = this.ctx.live()
    const jid = this.ctx.jidOf(args.to)
    if (args.data.length === 0 || args.data.length > MAX_UPLOAD_BYTES) throw new RpcError('too-large', 'Arquivo fora do tamanho permitido.')
    const data = Buffer.from(args.data)
    const caption = args.caption ?? undefined
    const thumb = args.thumbnail ? Buffer.from(args.thumbnail).toString('base64') : undefined
    const content: Record<string, unknown> =
      args.kind === 'image'
        ? { image: data, mimetype: args.mime, ...(caption ? { caption } : {}), ...(thumb ? { jpegThumbnail: thumb } : {}) }
        : args.kind === 'document'
          ? { document: data, mimetype: args.mime, fileName: args.fileName ?? 'arquivo', ...(caption ? { caption } : {}) }
          : { audio: data, mimetype: args.kind === 'voice' ? 'audio/ogg; codecs=opus' : args.mime, ptt: args.kind === 'voice' }
    if (args.composingMs && args.composingMs > 0) {
      await sock.sendPresenceUpdate(args.kind === 'voice' ? 'recording' : 'composing', jid)
      await this.ctx.wait(args.composingMs)
    }
    this.noteChat(args.messageId, jid)
    const res = await sock.sendMessage(jid, content, { messageId: args.messageId })
    if (args.composingMs) await sock.sendPresenceUpdate('paused', jid).catch(noop)
    return this.result(res, args.messageId)
  }

  async downloadMedia(args: EngineCalls['downloadMedia']['args']): Promise<EngineCalls['downloadMedia']['ret']> {
    this.ctx.live()
    try {
      return { data: await this.ctx.downloadMedia(args.ref, args.maxBytes) }
    } catch (e) {
      if (e instanceof RpcError) throw e
      // The CDN answers 404/410 once the media is gone; any other failure is a plain failure.
      const status = Number((e as { output?: { statusCode?: number } }).output?.statusCode ?? 0)
      throw new RpcError(status === 404 || status === 410 ? 'expired' : 'failed', 'Não foi possível baixar a mídia.')
    }
  }

  async revoke(args: EngineCalls['revoke']['args']): Promise<void> {
    const jid = this.addressOf(args.messageId) ?? this.ctx.jidOf(args.to)
    await this.ctx.live().sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: args.messageId } })
  }

  async presence(args: EngineCalls['presence']['args']): Promise<void> {
    await this.ctx.live().sendPresenceUpdate(args.presence, this.ctx.jidOf(args.to))
  }

  async subscribe(args: EngineCalls['subscribe']['args']): Promise<void> {
    await this.ctx.live().presenceSubscribe(this.ctx.jidOf(args.to))
  }

  /** Presence is only delivered while we are `available`, but being available mutes the phone: the app decides when. */
  async setOnline(args: EngineCalls['online']['args']): Promise<void> {
    const sock = this.ctx.live()
    if (this.online === args.online) return
    this.online = args.online
    await sock.sendPresenceUpdate(args.online ? 'available' : 'unavailable')
  }

  async markRead(args: EngineCalls['markRead']['args']): Promise<void> {
    const jid = this.ctx.jidOf(args.to)
    if (args.ids.length === 0) return
    // Answer on the address each message arrived on (an @lid chat is not its phone JID).
    await this.ctx.live().readMessages(args.ids.map((id) => ({ remoteJid: this.addressOf(id) ?? jid, id, fromMe: false })))
  }

  async lookup(args: EngineCalls['lookup']['args']): Promise<EngineCalls['lookup']['ret']> {
    const sock = this.ctx.live()
    const found = (await sock.onWhatsApp(args.phone))?.find((r) => r.exists)
    if (!found) return { exists: false, jid: null, lid: null }
    const lid = await sock.lidForPn?.(found.jid).catch(() => null)
    return { exists: true, jid: found.jid, lid: lid ?? null }
  }

  async profilePic(args: EngineCalls['profilePic']['args']): Promise<string | null> {
    try {
      return (await this.ctx.live().profilePictureUrl(this.ctx.jidOf(args.to), 'preview')) ?? null
    } catch {
      return null // no picture, privacy setting or rate limit: all mean "none"
    }
  }
}
