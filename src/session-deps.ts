import type { WaLib } from './lib-types'
import type { EngineEvent } from './protocol'
import type { Rpc } from './rpc'

/** What a session needs from its host: the library, the link to the app and the clock/timers (injected for tests). */
export interface SessionDeps {
  lib: WaLib
  rpc: Rpc
  emit: (event: EngineEvent) => void
  now?: () => number
  /** Injected for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown
  wait?: (ms: number) => Promise<void>
  random?: () => number
}
