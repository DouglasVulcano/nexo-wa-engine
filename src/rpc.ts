import type { EngineEvent, WireMessage, WirePort } from './protocol'



export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export type CallHandler = (method: string, args: unknown) => Promise<unknown>

/** Request/response over a `WirePort`; calls time out and reject when the link closes. */
export class Rpc {
  private next = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private handler: CallHandler | null = null

  constructor(
    private readonly port: WirePort,
    private readonly timeoutMs = 30_000
  ) {
    port.onMessage((m) => this.receive(m))
  }

  handle(handler: CallHandler): void {
    this.handler = handler
  }

  emit(event: EngineEvent): void {
    this.port.post({ t: 'event', event })
  }

  ready(engine: string, version: string, protocol: number): void {
    this.port.post({ t: 'ready', protocol, engine, version })
  }

  call<M extends { [P in keyof M]: { args: unknown; ret: unknown } }, K extends keyof M & string>(method: K, args: M[K]['args']): Promise<M[K]['ret']> {
    const rid = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new RpcError('timeout', 'timeout'))
      }, this.timeoutMs)
      this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.port.post({ t: 'call', rid, method, args })
    })
  }

  private receive(m: WireMessage): void {
    if (m.t === 'ret') {
      const p = this.pending.get(m.rid)
      if (!p) return
      this.pending.delete(m.rid)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.value)
      else p.reject(new RpcError(m.code, m.message))
    } else if (m.t === 'call') {
      void this.answer(m.rid, m.method, m.args)
    }
  }

  private async answer(rid: number, method: string, args: unknown): Promise<void> {
    try {
      if (!this.handler) throw new RpcError('unsupported', 'no handler')
      const value = await this.handler(method, args)
      this.port.post({ t: 'ret', rid, ok: true, value: value ?? null })
    } catch (e) {
      const code = e instanceof RpcError ? e.code : 'unknown'
      this.port.post({ t: 'ret', rid, ok: false, code, message: String((e as Error).message ?? e) })
    }
  }
}
