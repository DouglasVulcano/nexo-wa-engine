/**
 * Nexo <-> engine message protocol, version 1. The ONLY contract between the app
 * and this component: the app forks the bundle as a utility process and talks to
 * it over a message port. Documented in ../PROTOCOL.md. This file is the engine's
 * own copy; the app keeps another (src/main/services/contacts/wa-protocol.ts) and a
 * test keeps `PROTOCOL_VERSION` and the method lists in sync. Never import from
 * the app here.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) DSV Software. This file is the shared message protocol between Nexo
 * (proprietary) and the WhatsApp engine (GPL-3.0). It is licensed under the MIT
 * license in both repositories, so that sharing it makes neither side inherit the
 * other's license.
 */

export const PROTOCOL_VERSION = 1

export type MessageKind = 'text' | 'image' | 'document' | 'audio' | 'voice' | 'video' | 'sticker' | 'other'
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed'
export type Presence = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'

/** Who a conversation is with: any of the three may be unknown. */
export interface PeerAddress {
  jid: string | null
  lid: string | null
  phone: string | null
}

export interface MediaInfo {
  mime: string
  fileName: string | null
  bytes: number | null
  seconds: number | null
}

/**
 * What the engine needs to download a received media later (WhatsApp keeps it on its CDN for a
 * while). It stays in the app's database next to the message, never goes to the renderer.
 */
export interface MediaRef {
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  mime: string
  /** Base64 of the media key. */
  mediaKey: string
  directPath: string | null
  url: string | null
  fileEncSha256: string | null
  fileSha256: string | null
  fileLength: number | null
}

export interface Quoted {
  id: string
  fromMe: boolean
  preview: string
}

export interface EngineMessage {
  id: string
  peer: PeerAddress
  fromMe: boolean
  /** Epoch ms. */
  ts: number
  kind: MessageKind
  text: string | null
  media: MediaInfo | null
  mediaRef: MediaRef | null
  quoted: Quoted | null
  status: MessageStatus
  pushName: string | null
  /** History sync or offline delivery: no unread bump, no notification. */
  history: boolean
}

export type ConnectionStatus =
  | 'starting'
  | 'qr'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'logged-out'
  | 'error'

export type EngineErrorCode =
  | 'network'
  | 'qr-timeout'
  | 'logged-out'
  | 'account-restricted'
  | 'process-crash'
  | 'unknown'

export type EngineEvent =
  | {
      type: 'connection'
      status: ConnectionStatus
      ownPhone?: string | null
      ownName?: string | null
      attempt?: number
      error?: { code: EngineErrorCode; message: string } | null
    }
  | { type: 'qr'; qr: string | null; pairingCode: string | null; expiresAt: number; attempt: number }
  | { type: 'message'; message: EngineMessage }
  | { type: 'status'; peer: PeerAddress; messageId: string; status: MessageStatus }
  | { type: 'delete'; peer: PeerAddress; messageId: string }
  | { type: 'presence'; peer: PeerAddress; presence: Presence; lastSeen: number | null }
  | { type: 'identity'; jid: string | null; lid: string | null }
  /** `fromBook`: the name is the one saved in the phone's address book (not the person's own push name). */
  | { type: 'contact-update'; peer: PeerAddress; name: string | null; fromBook: boolean }
  | { type: 'sync'; progress: number | null }

export interface SendTextOptions {
  messageId: string
  quoted?: { id: string; fromMe: boolean; preview: string }
  /** Show "typing" this long before delivering. */
  composingMs?: number
}

export type OutgoingKind = 'image' | 'document' | 'audio' | 'voice'

/** Calls the app makes into the engine. */
export interface EngineCalls {
  start: { args: { pairingPhone?: string }; ret: null }
  stop: { args: null; ret: null }
  logout: { args: null; ret: null }
  sendText: { args: { to: PeerAddress; text: string; options: SendTextOptions }; ret: { id: string; ts: number } }
  revoke: { args: { to: PeerAddress; messageId: string }; ret: null }
  presence: { args: { to: PeerAddress; presence: 'composing' | 'recording' | 'paused' }; ret: null }
  subscribe: { args: { to: PeerAddress }; ret: null }
  sendMedia: {
    args: {
      to: PeerAddress
      kind: OutgoingKind
      data: Uint8Array
      mime: string
      fileName: string | null
      caption: string | null
      /** Small JPEG for the preview of an image (the engine has no image library). */
      thumbnail: Uint8Array | null
      messageId: string
      composingMs?: number
    }
    ret: { id: string; ts: number }
  }
  /** Downloads a received media; fails with `too-large` past `maxBytes` and `expired` when WhatsApp no longer has it. */
  downloadMedia: { args: { ref: MediaRef; maxBytes: number }; ret: { data: Uint8Array } }
  /** Appear online (`available`) or not: needed to receive presence, but it mutes the notifications of the phone. */
  online: { args: { online: boolean }; ret: null }
  /** While the QR is showing, switch to a pairing code for this phone; the code arrives as a `qr` event. */
  pairingCode: { args: { phone: string }; ret: null }
  markRead: { args: { to: PeerAddress; ids: string[] }; ret: null }
  lookup: { args: { phone: string }; ret: { exists: boolean; jid: string | null; lid: string | null } | null }
  profilePic: { args: { to: PeerAddress }; ret: string | null }
}

export const ENGINE_METHODS = [
  'start',
  'stop',
  'logout',
  'sendText',
  'revoke',
  'presence',
  'subscribe',
  'online',
  'sendMedia',
  'downloadMedia',
  'pairingCode',
  'markRead',
  'lookup',
  'profilePic'
] as const

export interface AuthEntry {
  scope: string
  name: string
  /** null deletes the entry. */
  value: string | null
}

/** Calls the engine makes into the app: persistence of the Signal state (encrypted by the app). */
export interface AppCalls {
  'auth:get': { args: { scope: string; names: string[] }; ret: Record<string, string> }
  'auth:set': { args: { entries: AuthEntry[] }; ret: null }
  'auth:clear': { args: null; ret: null }
  'auth:paired': { args: { paired: boolean }; ret: null }
}

export const APP_METHODS = ['auth:get', 'auth:set', 'auth:clear', 'auth:paired'] as const

export type WireMessage =
  | { t: 'ready'; protocol: number; engine: string; version: string }
  | { t: 'call'; rid: number; method: string; args: unknown }
  | { t: 'ret'; rid: number; ok: true; value: unknown }
  | { t: 'ret'; rid: number; ok: false; code: string; message: string }
  | { t: 'event'; event: EngineEvent }

/** Minimal duplex port: Electron `parentPort` in the engine, `UtilityProcess` in the app. */
export interface WirePort {
  post(message: WireMessage): void
  onMessage(cb: (message: WireMessage) => void): void
}
