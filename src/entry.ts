import { APP_METHODS, ENGINE_METHODS, PROTOCOL_VERSION, type WireMessage, type WirePort } from './protocol'
import { safeMediaSource } from './media-source'
import { Rpc, RpcError } from './rpc'
import { WaSession } from './session'
import type { KeyStore, SilentLogger, SocketConfig, WaLib, WaSocket } from './lib-types'

/**
 * Utility-process entry. Wires Electron's `parentPort` to the session and adapts the
 * real Baileys to the narrow `WaLib` the session needs. Loaded by the app with
 * `utilityProcess.fork(<path to this bundle>)`; talks to nothing but the port and
 * WhatsApp's servers.
 */

declare const __ENGINE_VERSION__: string

interface ParentPort {
  on(event: 'message', cb: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!parentPort) throw new Error('wa-baileys must run as an Electron utility process')

const port: WirePort = {
  post: (m: WireMessage) => parentPort.postMessage(m),
  onMessage: (cb) => parentPort.on('message', (e) => cb(e.data as WireMessage))
}

const FETCH_VERSION_TIMEOUT_MS = 5000

async function loadLib(): Promise<WaLib> {
  const b = await import('baileys')
  // Narrowing cast: Baileys' socket type is far larger than the slice the session uses.
  const adapt = (sock: unknown): WaSocket => {
    const s = sock as WaSocket & { signalRepository?: { lidMapping?: { getLIDForPN(pn: string): Promise<string | null> } } }
    s.lidForPn = (pn) => s.signalRepository?.lidMapping?.getLIDForPN(pn) ?? Promise.resolve(null)
    return s
  }
  return {
    engineVersion: __ENGINE_VERSION__,
    makeSocket: (config: SocketConfig) =>
      adapt(b.makeWASocket(config as unknown as Parameters<typeof b.makeWASocket>[0])),
    initCreds: () => b.initAuthCreds() as unknown as ReturnType<WaLib['initCreds']>,
    cacheKeys: (keys: KeyStore, logger: SilentLogger) =>
      b.makeCacheableSignalKeyStore(keys as never, logger as never) as unknown as KeyStore,
    serialize: (value) => JSON.stringify(value, b.BufferJSON.replacer),
    deserialize: (type, text) => {
      const value = JSON.parse(text, b.BufferJSON.reviver) as unknown
      return type === 'app-state-sync-key' && value
        ? b.proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>)
        : value
    },
    downloadMedia: async (ref, maxBytes) => {
      // The reference came from the sender: only WhatsApp's own hosts may be fetched (see media-source.ts).
      const source = safeMediaSource(ref)
      if (!source) throw new RpcError('expired', 'Endereço de mídia não confiável.')
      const stream = await b.downloadContentFromMessage({ mediaKey: Buffer.from(ref.mediaKey, 'base64'), ...source }, ref.type)
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of stream) {
        size += chunk.length
        if (size > maxBytes) throw new RpcError('too-large', 'A mídia passa do tamanho permitido.')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    },
    fetchVersion: async () => {
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), FETCH_VERSION_TIMEOUT_MS))
      const res = await Promise.race([b.fetchLatestWaWebVersion(), timeout])
      return res && Array.isArray(res.version) ? (res.version as [number, number, number]) : null
    }
  }
}

async function main(): Promise<void> {
  const rpc = new Rpc(port)
  const lib = await loadLib()
  const session = new WaSession({ lib, rpc, emit: (e) => rpc.emit(e) })

  const methods = new Set<string>(ENGINE_METHODS)
  rpc.handle(async (method, args) => {
    if (!methods.has(method)) throw new RpcError('unsupported', `unknown method ${method}`)
    switch (method) {
      case 'start':
        await session.start((args as { pairingPhone?: string } | null)?.pairingPhone)
        return null
      case 'stop':
        await session.stop()
        return null
      case 'logout':
        await session.logout()
        return null
      case 'sendText':
        return session.sendText(args as Parameters<WaSession['sendText']>[0])
      case 'revoke':
        await session.revoke(args as Parameters<WaSession['revoke']>[0])
        return null
      case 'presence':
        await session.presence(args as Parameters<WaSession['presence']>[0])
        return null
      case 'subscribe':
        await session.subscribe(args as Parameters<WaSession['subscribe']>[0])
        return null
      case 'pairingCode':
        await session.requestPairing(args as Parameters<WaSession['requestPairing']>[0])
        return null
      case 'sendMedia':
        return session.sendMedia(args as Parameters<WaSession['sendMedia']>[0])
      case 'downloadMedia':
        return session.downloadMedia(args as Parameters<WaSession['downloadMedia']>[0])
      case 'online':
        await session.setOnline(args as Parameters<WaSession['setOnline']>[0])
        return null
      case 'markRead':
        await session.markRead(args as Parameters<WaSession['markRead']>[0])
        return null
      case 'lookup':
        return session.lookup(args as Parameters<WaSession['lookup']>[0])
      default:
        return session.profilePic(args as Parameters<WaSession['profilePic']>[0])
    }
  })
  void APP_METHODS
  rpc.ready('wa-baileys', lib.engineVersion, PROTOCOL_VERSION)
}

// A stray rejection inside the library must not kill a live session; a real crash
// exits and the app restarts the engine with backoff.
process.on('unhandledRejection', () => undefined)
process.on('uncaughtException', () => process.exit(1))
void main().catch(() => process.exit(1))
