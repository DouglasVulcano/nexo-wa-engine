import { addressFrom, isLidJid, isOneToOneJid, normalizeJid } from './jid'
import { mapPresence, mapStatus, normalizeMessage, peerOfKey, toMillis, type OwnIdentity, type RawMessage } from './normalize'
import type { EngineEvent, MessageStatus } from './protocol'
import type { WaSocket } from './lib-types'

/**
 * Maps the Baileys data events (everything except connection and creds) to
 * normalized engine events. Raw payloads stop here: only EngineEvent leaves.
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])

interface RawKey {
  remoteJid?: string | null
  id?: string | null
  fromMe?: boolean | null
  remoteJidAlt?: string | null
}

export interface EventHooks {
  /** Who we are logged in as (for quote authorship). */
  own(): OwnIdentity
  /** The chat JID a message id travelled on, to answer on the same address (read receipts, revoke). */
  seen(messageId: string, chatJid: string): void
}

function emitMessages(emit: (e: EngineEvent) => void, raws: Obj[], history: boolean, hooks: EventHooks): void {
  for (const raw of raws) {
    const key = isObj(raw.key) ? (raw.key as RawKey) : null
    if (key?.id && key.remoteJid) hooks.seen(key.id, key.remoteJid)
    const n = normalizeMessage(raw as unknown as RawMessage, history, hooks.own())
    if (!n) continue
    if (n.type === 'delete') emit({ type: 'delete', peer: n.peer, messageId: n.messageId })
    else {
      emit({ type: 'message', message: n.message })
      const { jid, lid } = n.message.peer
      if (jid && lid) emit({ type: 'identity', jid, lid })
    }
  }
}

const RECEIPT_STATUS: Array<[string, MessageStatus]> = [
  ['playedTimestamp', 'played'],
  ['readTimestamp', 'read'],
  ['receiptTimestamp', 'delivered']
]

export function wireDataEvents(sock: WaSocket, emit: (e: EngineEvent) => void, hooks: EventHooks): void {
  sock.ev.on('messages.upsert', (data) => {
    if (!isObj(data)) return
    emitMessages(emit, list(data.messages), data.type !== 'notify', hooks)
  })

  sock.ev.on('messaging-history.set', (data) => {
    if (!isObj(data)) return
    emitMessages(emit, list(data.messages), true, hooks)
    const progress = typeof data.progress === 'number' ? data.progress : null
    // Baileys 7 often never sends `isLatest`; a chunk at 100% is the end of the sync too.
    const done = data.isLatest === true || (progress !== null && progress >= 100)
    emit({ type: 'sync', progress: done ? null : progress })
  })

  sock.ev.on('messages.update', (data) => {
    for (const item of list(data)) {
      const key = isObj(item.key) ? (item.key as RawKey) : null
      const update = isObj(item.update) ? item.update : null
      const peer = key ? peerOfKey({ ...key, remoteJidAlt: key.remoteJidAlt }) : null
      if (!key?.id || !peer || !update) continue
      if (update.messageStubType === 1) emit({ type: 'delete', peer, messageId: key.id })
      else if (key.fromMe && typeof update.status === 'number') {
        emit({ type: 'status', peer, messageId: key.id, status: mapStatus(update.status) })
      }
    }
  })

  sock.ev.on('message-receipt.update', (data) => {
    for (const item of list(data)) {
      const key = isObj(item.key) ? (item.key as RawKey) : null
      const receipt = isObj(item.receipt) ? item.receipt : null
      const peer = key ? peerOfKey(key) : null
      if (!key?.id || !key.fromMe || !peer || !receipt) continue
      const hit = RECEIPT_STATUS.find(([field]) => receipt[field] != null)
      if (hit) emit({ type: 'status', peer, messageId: key.id, status: hit[1] })
    }
  })

  sock.ev.on('presence.update', (data) => {
    if (!isObj(data) || typeof data.id !== 'string' || !isObj(data.presences)) return
    if (!isOneToOneJid(normalizeJid(data.id))) return
    const peer = addressFrom(data.id)
    const entries = Object.entries(data.presences)
    const chat = normalizeJid(data.id)
    const mine = entries.find(([jid]) => normalizeJid(jid) === chat) ?? entries[0]
    if (!mine || !isObj(mine[1])) return
    const seen = mine[1].lastSeen
    emit({
      type: 'presence',
      peer,
      presence: mapPresence(mine[1].lastKnownPresence),
      lastSeen: seen ? toMillis(seen) : null
    })
  })

  const onContacts = (data: unknown): void => {
    for (const c of list(data)) {
      const id = typeof c.id === 'string' ? c.id : null
      const lid = typeof c.lid === 'string' ? c.lid : isLidJid(id) ? id : null
      const jid = typeof c.phoneNumber === 'string' ? c.phoneNumber : typeof c.jid === 'string' ? c.jid : id
      const peer = addressFrom(jid, lid)
      if (!isOneToOneJid(peer.jid ?? peer.lid)) continue
      const saved = typeof c.name === 'string' && c.name ? c.name : null
      const name = saved ?? (typeof c.notify === 'string' && c.notify ? c.notify : null)
      emit({ type: 'contact-update', peer, name, fromBook: saved !== null })
      if (peer.jid && peer.lid) emit({ type: 'identity', jid: peer.jid, lid: peer.lid })
    }
  }
  sock.ev.on('contacts.upsert', onContacts)
  sock.ev.on('contacts.update', onContacts)

  sock.ev.on('lid-mapping.update', (data) => {
    if (!isObj(data)) return
    const jid = normalizeJid(typeof data.pn === 'string' ? data.pn : null)
    const lid = normalizeJid(typeof data.lid === 'string' ? data.lid : null)
    if (jid && lid) emit({ type: 'identity', jid, lid })
  })
}
