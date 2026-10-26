import { loadAuth, type AuthProxy } from './auth-proxy'
import { deliveryJid, normalizeJid, phoneFromJid } from './jid'
import type { AppCalls, EngineCalls, EngineErrorCode } from './protocol'
import { RpcError } from './rpc'
import { wireDataEvents } from './session-events'
import { SessionCalls } from './session-calls'
import { decideClose } from './close-policy'
import { socketConfig } from './socket-config'
import type { WaSocket } from './lib-types'
import type { SessionDeps } from './session-deps'

/** One linked-device session: the socket, the reconnect policy and the app's calls. Baileys is injected (`WaLib`); nothing is logged. */

const MAX_BACKOFF_MS = 30_000
const PAIRING_CODE_TTL_MS = 120_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

export class WaSession {
  private sock: WaSocket | null = null
  private auth: AuthProxy | null = null
  private gen = 0
  private stopped = true
  private open = false
  private attempt = 0
  private qrAttempt = 0
  private pairingPhone: string | undefined
  private codeRequested = false
  private version: [number, number, number] | null | undefined
  private readonly calls: SessionCalls
  private badSessionStreak = 0
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly wait: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.random = deps.random ?? Math.random
    this.calls = new SessionCalls({
      live: () => this.live(),
      jidOf: (to) => this.jidOf(to),
      wait: (ms) => this.wait(ms),
      now: () => this.now(),
      downloadMedia: (ref, max) => deps.lib.downloadMedia(ref, max)
    })
  }

  async start(pairingPhone?: string): Promise<void> {
    if (this.sock && !this.stopped) return
    this.stopped = false
    this.pairingPhone = pairingPhone
    this.attempt = 0
    this.qrAttempt = 0
    this.codeRequested = false
    this.deps.emit({ type: 'connection', status: 'starting' })
    await this.openSocket()
  }

  async stop(): Promise<void> {
    this.stopped = true
    const auth = this.auth
    this.teardown()
    await auth?.drain() // the session must be fully saved before the app kills this process
    this.deps.emit({ type: 'connection', status: 'closed' })
  }

  async logout(): Promise<void> {
    const sock = this.sock
    this.stopped = true
    try {
      if (sock && this.open) await sock.logout()
    } catch {
      /* the device may already be unlinked on the phone */
    }
    const auth = this.auth
    this.teardown()
    await auth?.drain()
    await this.wipe()
    this.deps.emit({ type: 'connection', status: 'closed' })
  }

  private teardown(): void {
    this.gen++
    this.open = false
    this.calls.resetOnline()
    const sock = this.sock
    this.sock = null
    try {
      sock?.end(undefined)
    } catch {
      /* already closed */
    }
  }

  private async wipe(): Promise<void> {
    this.auth = null
    await this.deps.rpc.call<AppCalls, 'auth:clear'>('auth:clear', null)
  }

  private async openSocket(): Promise<void> {
    const gen = ++this.gen
    try {
      this.auth ??= await loadAuth(this.deps.rpc, this.deps.lib)
      if (this.version === undefined) this.version = await this.deps.lib.fetchVersion().catch(() => null)
      if (gen !== this.gen) return
      const auth = this.auth
      const sock = this.deps.lib.makeSocket(
        socketConfig(this.deps.lib, auth, this.version ?? null, (id) => this.calls.sentContent(id))
      )
      this.sock = sock
      sock.ev.on('creds.update', (u) => {
        if (gen === this.gen && isObj(u)) void auth.saveCreds(u)
      })
      sock.ev.on('connection.update', (u) => {
        if (gen === this.gen && isObj(u)) void this.onConnection(sock, u)
      })
      wireDataEvents(
        sock,
        (e) => {
          if (gen === this.gen) this.deps.emit(e)
        },
        {
          own: () => ({ jid: normalizeJid(sock.user?.id), lid: normalizeJid(sock.user?.lid) }),
          seen: (id, jid) => this.calls.noteChat(id, jid)
        }
      )
    } catch (e) {
      this.fail('network', String((e as Error).message ?? e))
    }
  }

  private fail(code: EngineErrorCode, message: string): void {
    this.stopped = true
    this.teardown()
    this.deps.emit({ type: 'connection', status: 'error', error: { code, message } })
  }

  private async onConnection(sock: WaSocket, u: Obj): Promise<void> {
    const emit = this.deps.emit
    if (typeof u.qr === 'string') await this.onQr(sock, u.qr)
    if (u.connection === 'connecting' && !this.codeRequested && this.qrAttempt === 0) {
      emit({ type: 'connection', status: 'connecting' })
    }
    if (u.connection === 'open') {
      this.open = true
      this.attempt = 0
      this.badSessionStreak = 0
      this.qrAttempt = 0
      const id = sock.user?.id
      emit({
        type: 'connection',
        status: 'connected',
        ownPhone: id ? phoneFromJid(id.replace(/:\d+@/, '@')) : null,
        ownName: sock.user?.name ?? null
      })
      await this.deps.rpc.call<AppCalls, 'auth:paired'>('auth:paired', { paired: true })
    }
    if (u.connection === 'close') await this.onClose(u.lastDisconnect)
  }

  private async onQr(sock: WaSocket, qr: string): Promise<void> {
    if (this.pairingPhone) {
      if (this.codeRequested || this.auth?.state.creds.registered) return
      this.codeRequested = true
      this.qrAttempt = 1
      try {
        const code = await sock.requestPairingCode(this.pairingPhone)
        this.deps.emit({ type: 'connection', status: 'qr' })
        this.deps.emit({ type: 'qr', qr: null, pairingCode: code, expiresAt: this.now() + PAIRING_CODE_TTL_MS, attempt: 1 })
      } catch (e) {
        this.fail('network', String((e as Error).message ?? e))
      }
      return
    }
    this.qrAttempt++
    if (this.qrAttempt === 1) this.deps.emit({ type: 'connection', status: 'qr' })
    const ttl = this.qrAttempt === 1 ? 60_000 : 20_000
    this.deps.emit({ type: 'qr', qr, pairingCode: null, expiresAt: this.now() + ttl, attempt: this.qrAttempt })
  }

  private async onClose(last: unknown): Promise<void> {
    this.open = false
    if (this.stopped) return
    const err = isObj(last) && isObj(last.error) ? last.error : null
    const output = err && isObj(err.output) ? err.output : null
    const code = output && typeof output.statusCode === 'number' ? output.statusCode : 0
    const message = err && typeof err.message === 'string' ? err.message : ''
    const registered = this.auth?.state.creds.registered === true

    if (code === 500) this.badSessionStreak++
    const action = decideClose({ code, message, registered, badSessionStreak: this.badSessionStreak })
    if (action === 'logged-out') {
      this.stopped = true
      this.teardown()
      await this.deps.rpc.call<AppCalls, 'auth:paired'>('auth:paired', { paired: false })
      await this.wipe()
      this.deps.emit({
        type: 'connection',
        status: 'logged-out',
        error: { code: 'logged-out', message: 'O aparelho foi desconectado no celular.' }
      })
    } else if (action === 'reopen') await this.openSocket()
    else if (action === 'restricted') this.fail('account-restricted', 'O WhatsApp restringiu esta conta temporariamente.')
    else if (action === 'replaced') this.fail('unknown', 'A sessão foi aberta em outro lugar e esta foi encerrada.')
    else if (action === 'qr-timeout') this.fail('qr-timeout', 'O QR code expirou. Gere outro para tentar de novo.')
    else this.reconnect()
  }

  private reconnect(): void {
    this.attempt++
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempt - 1))
    const delay = Math.round(base * (0.75 + this.random() * 0.5))
    this.deps.emit({ type: 'connection', status: 'reconnecting', attempt: this.attempt })
    this.teardownKeepState()
    this.schedule(() => {
      if (!this.stopped) void this.openSocket()
    }, delay)
  }

  private teardownKeepState(): void {
    this.gen++
    const sock = this.sock
    this.sock = null
    try {
      sock?.end(undefined)
    } catch {
      /* already closed */
    }
  }

  // --- calls ---

  private live(): WaSocket {
    if (!this.sock || !this.open) throw new RpcError('not-connected', 'Não conectado ao WhatsApp')
    return this.sock
  }

  private jidOf(to: EngineCalls['sendText']['args']['to']): string {
    const jid = deliveryJid(to)
    if (!jid) throw new RpcError('bad-request', 'Destinatário sem endereço')
    return jid
  }

  sendText(args: EngineCalls['sendText']['args']): Promise<EngineCalls['sendText']['ret']> {
    return this.calls.sendText(args)
  }

  sendMedia(args: EngineCalls['sendMedia']['args']): Promise<EngineCalls['sendMedia']['ret']> {
    return this.calls.sendMedia(args)
  }

  downloadMedia(args: EngineCalls['downloadMedia']['args']): Promise<EngineCalls['downloadMedia']['ret']> {
    return this.calls.downloadMedia(args)
  }

  revoke(args: EngineCalls['revoke']['args']): Promise<void> {
    return this.calls.revoke(args)
  }

  presence(args: EngineCalls['presence']['args']): Promise<void> {
    return this.calls.presence(args)
  }

  subscribe(args: EngineCalls['subscribe']['args']): Promise<void> {
    return this.calls.subscribe(args)
  }

  /** The user asked for a pairing code while the QR was on screen ("use a code instead"). */
  async requestPairing(args: EngineCalls['pairingCode']['args']): Promise<void> {
    const sock = this.sock
    if (!sock || this.stopped || this.auth?.state.creds.registered) throw new RpcError('bad-request', 'Não há pareamento em andamento.')
    this.pairingPhone = args.phone
    this.codeRequested = true
    const code = await sock.requestPairingCode(args.phone)
    this.qrAttempt++
    this.deps.emit({ type: 'qr', qr: null, pairingCode: code, expiresAt: this.now() + PAIRING_CODE_TTL_MS, attempt: this.qrAttempt })
  }

  setOnline(args: EngineCalls['online']['args']): Promise<void> {
    return this.calls.setOnline(args)
  }

  markRead(args: EngineCalls['markRead']['args']): Promise<void> {
    return this.calls.markRead(args)
  }

  lookup(args: EngineCalls['lookup']['args']): Promise<EngineCalls['lookup']['ret']> {
    return this.calls.lookup(args)
  }

  profilePic(args: EngineCalls['profilePic']['args']): Promise<string | null> {
    return this.calls.profilePic(args)
  }
}
