import type { MediaRef } from './protocol'

/**
 * The slice of Baileys the session uses, as structural types. `entry.ts` adapts the
 * real library to this; tests pass a fake. Keeping it narrow is what lets the
 * session logic be tested with mocked sockets and swapped across Baileys versions.
 */

export interface KeyStore {
  get(type: string, ids: string[]): Promise<Record<string, unknown>>
  set(data: Record<string, Record<string, unknown> | undefined>): Promise<void>
}

export interface AuthState {
  creds: Record<string, unknown> & { registered?: boolean }
  keys: KeyStore
}

export interface SilentLogger {
  level: string
  child(obj: Record<string, unknown>): SilentLogger
  trace(...a: unknown[]): void
  debug(...a: unknown[]): void
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
}

export interface SocketConfig {
  auth: AuthState
  version?: [number, number, number]
  browser: [string, string, string]
  logger: SilentLogger
  getMessage: (key: { id?: string | null }) => Promise<unknown>
  shouldIgnoreJid: (jid: string) => boolean
  markOnlineOnConnect: false
  syncFullHistory: false
  generateHighQualityLinkPreview: false
}

export interface MessageKey {
  remoteJid?: string | null
  id?: string | null
  fromMe?: boolean | null
}

export interface WaSocket {
  ev: { on(event: string, cb: (data: unknown) => void): void }
  user?: { id: string; name?: string; lid?: string }
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
    options?: { messageId?: string; quoted?: unknown }
  ): Promise<{ key?: MessageKey; messageTimestamp?: unknown } | undefined>
  sendPresenceUpdate(type: string, toJid?: string): Promise<void>
  presenceSubscribe(jid: string): Promise<void>
  readMessages(keys: MessageKey[]): Promise<void>
  onWhatsApp(...phones: string[]): Promise<Array<{ jid: string; exists: boolean }> | undefined>
  profilePictureUrl(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>
  requestPairingCode(phone: string): Promise<string>
  logout(): Promise<void>
  end(error?: Error): void
  lidForPn?(pn: string): Promise<string | null>
}

export interface WaLib {
  /** Downloads and decrypts a received media, stopping at `maxBytes` (throws `too-large`). */
  downloadMedia(ref: MediaRef, maxBytes: number): Promise<Uint8Array>
  makeSocket(config: SocketConfig): WaSocket
  initCreds(): AuthState['creds']
  cacheKeys(keys: KeyStore, logger: SilentLogger): KeyStore
  /** JSON (de)serialization that survives Buffers. */
  serialize(value: unknown): string
  deserialize(type: string, text: string): unknown
  /** Latest WhatsApp Web version, or null to use the library default. */
  fetchVersion(): Promise<[number, number, number] | null>
  engineVersion: string
}
