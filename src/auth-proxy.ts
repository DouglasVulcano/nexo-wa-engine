import type { AppCalls } from './protocol'
import type { AuthState, KeyStore, WaLib } from './lib-types'
import type { Rpc } from './rpc'

/**
 * Auth state backed by the app (D-106). The engine has no disk, no vault and no
 * database: every read and write of credentials and Signal keys is an RPC to the
 * app, which encrypts and stores it. Writes are serialized to keep their order.
 */

const CREDS_SCOPE = 'creds'
const CREDS_NAME = 'creds'

export interface AuthProxy {
  state: AuthState
  /** Merges a partial update into the in-memory creds and persists them. */
  saveCreds(update?: Record<string, unknown>): Promise<void>
  /** Resolves when every queued write reached the app (call before stopping). */
  drain(): Promise<void>
}

export async function loadAuth(rpc: Rpc, lib: WaLib): Promise<AuthProxy> {
  const stored = await rpc.call<AppCalls, 'auth:get'>('auth:get', { scope: CREDS_SCOPE, names: [CREDS_NAME] })
  const raw = stored[CREDS_NAME]
  const creds = raw ? (lib.deserialize(CREDS_SCOPE, raw) as AuthState['creds']) : lib.initCreds()

  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job)
    chain = run.catch(() => undefined)
    return run
  }

  const keys: KeyStore = {
    async get(type, ids) {
      const wire = await rpc.call<AppCalls, 'auth:get'>('auth:get', { scope: type, names: ids })
      const out: Record<string, unknown> = {}
      for (const id of ids) {
        if (wire[id] !== undefined) out[id] = lib.deserialize(type, wire[id])
      }
      return out
    },
    set(data) {
      const entries = Object.entries(data).flatMap(([type, byId]) =>
        Object.entries(byId ?? {}).map(([name, value]) => ({
          scope: type,
          name,
          value: value === null || value === undefined ? null : lib.serialize(value)
        }))
      )
      if (entries.length === 0) return Promise.resolve()
      return enqueue(async () => {
        await rpc.call<AppCalls, 'auth:set'>('auth:set', { entries })
      })
    }
  }

  const saveCreds = (update?: Record<string, unknown>): Promise<void> => {
    if (update) Object.assign(creds, update)
    return enqueue(async () => {
      await rpc.call<AppCalls, 'auth:set'>('auth:set', {
        entries: [{ scope: CREDS_SCOPE, name: CREDS_NAME, value: lib.serialize(creds) }]
      })
    })
  }

  const drain = async (): Promise<void> => {
    await chain.catch(() => undefined)
  }

  return { state: { creds, keys }, saveCreds, drain }
}
