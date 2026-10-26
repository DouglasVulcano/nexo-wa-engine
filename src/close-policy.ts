import type { SilentLogger } from './lib-types'

/** Baileys / WhatsApp disconnect status codes the session reacts to. */
export const CODE = {
  loggedOut: 401,
  forbidden: 403,
  timedOut: 408,
  connectionReplaced: 440,
  badSession: 500,
  restartRequired: 515
} as const

/** Consecutive `badSession` closes before the session is considered really broken. */
export const BAD_SESSION_LIMIT = 3

const noop = (): void => undefined
/** Nothing the library says is ever logged: message content must not reach a log. */
export const silentLogger: SilentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop
}

export type CloseAction = 'logged-out' | 'reopen' | 'restricted' | 'replaced' | 'qr-timeout' | 'reconnect'

/**
 * What to do when the socket closes. `badSessionStreak` already counts this close. Pure: the
 * session turns the answer into events and timers.
 */
export function decideClose(i: { code: number; message: string; registered: boolean; badSessionStreak: number }): CloseAction {
  // Baileys maps any unknown stream error to 500: transient. Only 401 (or repeated 500) is a dead session.
  if (i.code === CODE.loggedOut || (i.code === CODE.badSession && i.badSessionStreak >= BAD_SESSION_LIMIT)) return 'logged-out'
  if (i.code === CODE.restartRequired) return 'reopen' // expected right after a successful pairing
  if (i.code === CODE.forbidden) return 'restricted'
  if (i.code === CODE.connectionReplaced) return 'replaced'
  if (!i.registered && i.code === CODE.timedOut && /qr/i.test(i.message)) return 'qr-timeout'
  return 'reconnect'
}
