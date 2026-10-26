import type { AuthProxy } from './auth-proxy'
import { silentLogger } from './close-policy'
import type { SocketConfig, WaLib } from './lib-types'

/**
 * Baileys socket options (D-104): linked-device identity, silent logger, 1:1 addresses only, no
 * history sync and no link previews (which would fetch URLs found in messages: nothing here
 * reaches out except to WhatsApp).
 */
export function socketConfig(
  lib: WaLib,
  auth: AuthProxy,
  version: [number, number, number] | null,
  sentContent: (id: string) => unknown
): SocketConfig {
  return {
    auth: { creds: auth.state.creds, keys: lib.cacheKeys(auth.state.keys, silentLogger) },
    ...(version ? { version } : {}),
    browser: ['Nexo', 'Chrome', '1.0.0'],
    logger: silentLogger,
    getMessage: async (key) => (key.id ? sentContent(key.id) : undefined),
    shouldIgnoreJid: (jid) => !/@(s\.whatsapp\.net|lid)$/.test(jid),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  }
}
