import type { PeerAddress } from './protocol'

const PN = 's.whatsapp.net'
const LID = 'lid'

/** `5511999990000:12@s.whatsapp.net` -> without the device part; `@c.us` -> PN server. */
export function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid) return null
  const at = jid.lastIndexOf('@')
  if (at < 1) return null
  let user = jid.slice(0, at)
  let server = jid.slice(at + 1)
  const colon = user.indexOf(':')
  if (colon >= 0) user = user.slice(0, colon)
  if (server === 'c.us') server = PN
  return user ? `${user}@${server}` : null
}

export const isPnJid = (jid: string | null | undefined): boolean => !!jid && jid.endsWith(`@${PN}`)
export const isLidJid = (jid: string | null | undefined): boolean => !!jid && jid.endsWith(`@${LID}`)
/** Groups, broadcasts, status, newsletters, bots: never a 1:1 contact. */
export const isOneToOneJid = (jid: string | null | undefined): boolean => isPnJid(jid) || isLidJid(jid)

export const phoneFromJid = (jid: string | null | undefined): string | null =>
  jid && isPnJid(jid) ? jid.slice(0, jid.indexOf('@')) : null

/** Peer from the chat JID plus the alternate (PN for a LID chat, LID for a PN chat). */
export function addressFrom(remote: string | null | undefined, alt?: string | null): PeerAddress {
  const addr: PeerAddress = { jid: null, lid: null, phone: null }
  for (const raw of [remote, alt]) {
    const j = normalizeJid(raw)
    if (isPnJid(j) && !addr.jid) addr.jid = j
    else if (isLidJid(j) && !addr.lid) addr.lid = j
  }
  addr.phone = phoneFromJid(addr.jid)
  return addr
}

/** JID to deliver to: PN when known, else LID. */
export const deliveryJid = (a: PeerAddress): string | null =>
  a.jid ?? a.lid ?? (a.phone ? `${a.phone}@${PN}` : null)
