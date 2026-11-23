// Wallet side of the DApp Connector v4 (API 4.1.0, ledger 9). Requests arrive from the in-app browser (native bridge) or the desktop
// harness, tagged with the page's origin by the transport (never by the page). Reads need a connection; anything
// that moves funds asks the user first, one sheet at a time. Signing keys never leave the session (what a proof server is sent: docs/SECURITY.md).
import * as ledger from '@midnightntwrk/ledger-v9'
import { WalletSession } from '../core/wallet'
import { API_BASE, diagnosticsOn, loadEndpoints } from '../core/net'
import { parseAddress } from '../core/send'
import { addConnection, isConnected } from './connections'
import { dec, enc, fromB64, fromHex, toHex } from './codec'
import { proverPost } from '../core/prover'
import { addDappEntry, describePays, type DappNote } from './log'
import { NotConfirmedYet } from '../core/sendWait'
import { deficits, ownClaims, refusal, type Amount, type Lane } from './guard'

export type { Amount, Lane } from './guard'
export type Ask =
  | { kind: 'connect'; origin: string }
  | { kind: 'balance'; origin: string; pays: Amount[]; complete: boolean; fee: bigint; payFees: boolean }
  | { kind: 'transfer'; origin: string; outputs: Array<Amount & { recipient: string }>; payFees: boolean }
  | { kind: 'intent'; origin: string; pays: Amount[]; receives: Array<Amount & { recipient: string }>; payFees: boolean }
  | { kind: 'submit'; origin: string }
  | { kind: 'sign'; origin: string; text: string | null; bytes: number }

type ErrorCode = 'InternalError' | 'Rejected' | 'InvalidRequest' | 'PermissionRejected' | 'Disconnected'
export class ApiError extends Error {
  constructor(readonly code: ErrorCode, readonly reason: string) { super(reason) }
}

/** https only, plus loopback http for local development. */
export function originAllowed(origin: string): boolean {
  try {
    const u = new URL(origin)
    if (u.origin !== origin) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))
  } catch { return false }
}

const APPROVED_TTL_MS = 11 * 60_000

/** Bridge trace → our wallet server (api/dapp-log): method, outcome, duration, wallet phase. Fire-and-forget; never throws. */
function trace(origin: string, method: string, outcome: string, ms: number, phase: string, snap?: any) {
  if (!diagnosticsOn()) return
  try {
    const p = (x: any) => (x ? `${x.applied}/${x.highest}${x.connected ? '' : ' (disconnected)'}` : null)
    const sync = snap ? { mode: snap.startMode ?? null, from: snap.resumedFrom ?? null, shielded: p(snap.shielded), dust: p(snap.dust), readyIn: snap.readyForTxAt ? Math.max(0, Math.round((snap.readyForTxAt - Date.now()) / 1000)) : null } : undefined
    const body = JSON.stringify({ at: new Date().toISOString(), origin, method, outcome: outcome.slice(0, 200), ms, phase, sync })
    void fetch(`${API_BASE}api/dapp-log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {})
  } catch { /* tracing must never affect the call */ }
}
const BLOB_PIECE_MAX = 512 * 1024
const BLOB_MAX_PIECES = 127            // 63.5 MB per key
const BLOB_BUDGET = 97 * 1024 * 1024   // finished circuit keys kept for the current site
const BLOB_PARTIALS = 5                // unfinished uploads at once (a proof needs 3)
const BLOB_PARTIAL_BUDGET = 67 * 1024 * 1024

export class DappHost {
  /** sealed transactions this wallet produced after an approval: submitting them asks nothing more */
  private approved = new Map<string, { origin: string; until: number; note?: DappNote }>()
  /** sends on their way, by transaction: one per transaction, however often a site asks */
  private sending = new Map<string, { origin: string; done: Promise<null> }>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private session: WalletSession, private ask: (a: Ask) => Promise<boolean>) {}

  /** One wire message in, one wire message out (see provider.js). Never throws. */
  async handleRaw(origin: string, raw: string): Promise<string> {
    let id: unknown = null
    let method = '?'
    const t0 = Date.now()
    try {
      const msg = JSON.parse(raw)
      id = msg?.id
      if (typeof msg?.method !== 'string' || !Array.isArray(msg?.params)) throw new ApiError('InvalidRequest', 'malformed request')
      method = msg.method
      trace(origin, method, 'start', 0, this.session.snap.phase, this.session.snap)
      const result = await this.handle(origin, msg.method, dec(msg.params) as unknown[])
      trace(origin, method, 'ok', Date.now() - t0, this.session.snap.phase, this.session.snap)
      return JSON.stringify({ id, result: enc(result ?? null) })
    } catch (e: any) {
      const err = e instanceof ApiError ? e : new ApiError('InternalError', shortReason(e))
      if (!(e instanceof ApiError)) console.warn('[dapp]', e)
      trace(origin, method, `${err.code}: ${err.reason}`, Date.now() - t0, this.session.snap.phase, this.session.snap)
      return JSON.stringify({ id, error: { code: err.code, reason: err.reason } })
    }
  }

  async handle(origin: string, method: string, params: unknown[]): Promise<unknown> {
    if (!originAllowed(origin)) throw new ApiError('PermissionRejected', 'this site cannot connect')
    const net = loadEndpoints()
    if (method === 'connect') {
      const networkId = String(params[0] ?? '')
      if (networkId !== net.networkId) throw new ApiError('InvalidRequest', `this wallet is on ${net.networkId}, not '${networkId}'`)
      if (isConnected(origin, this.session.walletId)) return null
      return this.serial(async () => {
        if (isConnected(origin, this.session.walletId)) return null
        if (!(await this.ask({ kind: 'connect', origin }))) throw new ApiError('Rejected', 'connection declined')
        addConnection(origin, this.session.walletId)
        return null
      })
    }
    if (method === 'getConnectionStatus') {
      return isConnected(origin, this.session.walletId) ? { status: 'connected', networkId: net.networkId } : { status: 'disconnected' }
    }
    if (!isConnected(origin, this.session.walletId)) throw new ApiError('Disconnected', 'not connected: call connect first')

    const s = this.session.snap
    switch (method) {
      case 'getShieldedBalances': return Object.fromEntries(s.balances.shielded)
      case 'getUnshieldedBalances': return Object.fromEntries(s.balances.unshielded)
      case 'getDustBalance': return { cap: s.balances.dustCap, balance: s.balances.dust }
      case 'getShieldedAddresses': {
        const k = this.session.shieldedKeys()
        return { shieldedAddress: s.shieldedAddress, shieldedCoinPublicKey: k.coin, shieldedEncryptionPublicKey: k.enc }
      }
      case 'getUnshieldedAddress': return { unshieldedAddress: s.unshieldedAddress }
      case 'getDustAddress': return { dustAddress: s.dustAddress }
      case 'getTxHistory': return this.txHistory(params)
      case 'getConfiguration':
        return { indexerUri: net.indexerUrl, indexerWsUri: net.indexerWsUrl, substrateNodeUri: net.nodeWs, proverServerUri: net.prover, networkId: net.networkId }
      case 'hintUsage': return null
      case 'getProvingProvider': return null
      case 'blobHas': return this.blobHas(origin, params)
      case 'blobPut': return this.blobPut(origin, params)
      case 'proverCheck': return this.proverCheck(origin, params)
      case 'proverProve': return this.proverProve(origin, params)
      case 'balanceUnsealedTransaction': return this.balance(origin, params, false)
      case 'balanceSealedTransaction': return this.balance(origin, params, true)
      case 'makeTransfer': return this.makeTransfer(origin, params)
      case 'submitTransaction': return this.submit(origin, params)
      case 'makeIntent': return this.makeIntent(origin, params)
      case 'signData': return this.signData(origin, params)
    }
    throw new ApiError('InvalidRequest', `unknown method ${method}`)
  }

  /**
   * getTxHistory(pageNumber, pageSize): the wallet's own transactions, newest first. The wallet knows a transaction's
   * overall result, not each segment's, so the execution status names segment 0 (and segment 1 for a partial success).
   */
  private async txHistory(params: unknown[]) {
    const pageNumber = Number(params[0] ?? 0), pageSize = Number(params[1] ?? 20)
    if (!Number.isInteger(pageNumber) || pageNumber < 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ApiError('InvalidRequest', 'pageNumber must be 0 or more and pageSize 1..100')
    const time = (e: { timestamp?: Date; lifecycle: { status: string; submittedAt?: Date } }) => (e.timestamp ?? e.lifecycle.submittedAt)?.getTime?.() ?? 0
    const all = (await this.session.txHistory()).slice().sort((a, b) => time(b) - time(a))
    return all.slice(pageNumber * pageSize, (pageNumber + 1) * pageSize).map((e) => {
      if (e.lifecycle.status === 'pending') return { txHash: e.hash, txStatus: { status: 'pending' } }
      if (e.lifecycle.status === 'rejected') return { txHash: e.hash, txStatus: { status: 'discarded' } }
      const executionStatus = e.status === 'FAILURE' ? { 0: 'Failure' } : e.status === 'PARTIAL_SUCCESS' ? { 0: 'Success', 1: 'Failure' } : { 0: 'Success' }
      return { txHash: e.hash, txStatus: { status: 'finalized', executionStatus } }
    })
  }

  /** prompts and fund-moving work run one at a time */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  /** Remember an approved result for submitTransaction; if the dApp never submits it, release its coins. */
  private remember(hex: string, origin: string, note?: DappNote) {
    const key = hex.toLowerCase()
    this.approved.set(key, { origin, until: Date.now() + APPROVED_TTL_MS, note })
    // never while it is being sent: a transaction handed to the network may be in a block, and its coins are not ours to release
    setTimeout(() => { if (!this.sending.has(key) && this.approved.delete(key)) void this.session.releaseSealed(fromHex(key)) }, APPROVED_TTL_MS)
  }

  /** dev harness dry runs: drop a balanced transaction instead of submitting it */
  async release(hex: string) {
    const key = hex.toLowerCase().replace(/^0x/, '')
    if (this.sending.has(key)) return
    this.approved.delete(key)
    await this.session.releaseSealed(fromHex(key))
  }

  private async balance(origin: string, params: unknown[], sealed: boolean) {
    const bytes = txBytes(params[0])
    const payFees = (params[1] as { payFees?: boolean } | undefined)?.payFees ?? true
    let tx: any
    try { tx = ledger.Transaction.deserialize('signature', 'proof', sealed ? 'binding' : 'pre-binding', bytes) }
    catch { throw new ApiError('InvalidRequest', `not a ${sealed ? 'sealed' : 'unsealed'} transaction`) }
    // Before any sheet: the wallet's signature on a site's transaction covers every coin of this wallet in it, so a
    // transaction that brings such coins along is not balanced at all (dapp/guard.ts). The session checks again at
    // the point of signing.
    let why: string | null
    try { why = refusal(ownClaims(tx, this.session.verifyingKey())) } catch { why = 'this transaction could not be read in full' }
    if (why) throw new ApiError('InvalidRequest', why)
    const { pays, complete } = deficits(tx)
    let fee = 0n
    try { if (payFees) fee = await this.session.feeOf(bytes, sealed) } catch {}
    return this.serial(async () => {
      if (!(await this.ask({ kind: 'balance', origin, pays, complete, fee, payFees }))) throw new ApiError('Rejected', 'declined in the wallet')
      await this.session.whenCanTransact({ needDust: payFees })
      // described now: an NFT that leaves with this transaction can no longer be named afterwards
      const note: DappNote = { origin, kind: 'transaction', pays: describePays(pays), fee: String(fee) }
      const out = toHex(await this.session.dappBalance(bytes, sealed, payFees))
      this.remember(out, origin, note)
      return { tx: out }
    })
  }

  private async makeTransfer(origin: string, params: unknown[]) {
    const raw = params[0]
    const payFees = (params[1] as { payFees?: boolean } | undefined)?.payFees ?? true
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 17) throw new ApiError('InvalidRequest', 'desiredOutputs must be a non-empty list')
    const outputs = raw.map((o: any) => {
      const lane: Lane = o?.kind === 'shielded' ? 'private' : o?.kind === 'unshielded' ? 'public' : (() => { throw new ApiError('InvalidRequest', 'kind must be shielded or unshielded') })()
      const type = String(o?.type ?? '').toLowerCase().replace(/^0x/, '')
      if (!/^[0-9a-f]{64}$/.test(type)) throw new ApiError('InvalidRequest', 'type must be a 32-byte hex token type')
      const value = typeof o?.value === 'bigint' ? o.value : (() => { throw new ApiError('InvalidRequest', 'value must be a bigint') })()
      if (value <= 0n) throw new ApiError('InvalidRequest', 'value must be positive')
      const to = parseAddress(String(o?.recipient ?? ''))
      if ('error' in to || to.lane !== lane) throw new ApiError('InvalidRequest', `recipient is not a ${o.kind} mainnet address`)
      return { lane, type, value, recipient: to.bech32, address: to.address }
    })
    return this.serial(async () => {
      if (!(await this.ask({ kind: 'transfer', origin, outputs, payFees }))) throw new ApiError('Rejected', 'declined in the wallet')
      await this.session.whenCanTransact({ needDust: payFees })
      const note: DappNote = { origin, kind: 'transaction', pays: describePays(outputs), fee: '0' }
      const out = toHex(await this.session.dappTransfer(outputs, payFees))
      this.remember(out, origin, note)
      return { tx: out }
    })
  }

  /**
   * makeIntent(desiredInputs, desiredOutputs, { intentId, payFees }): ONE unbalanced intent that offers our coins (the
   * inputs, change back to us) and asks for the outputs, signed but NOT bound, so the site can merge it into a
   * transaction of its own (a swap, a launchpad buy) and submit that. Nothing is proved when the site pays the fee: a
   * bare intent has no circuits. The sheet shows exactly what can leave the wallet: the inputs, no more.
   */
  private async makeIntent(origin: string, params: unknown[]) {
    const rawIn = params[0], rawOut = params[1]
    const opts = (params[2] ?? {}) as { intentId?: number | 'random'; payFees?: boolean }
    if (!Array.isArray(rawIn) || rawIn.length === 0 || rawIn.length > 8) throw new ApiError('InvalidRequest', 'desiredInputs must be a non-empty list')
    if (!Array.isArray(rawOut) || rawOut.length > 8) throw new ApiError('InvalidRequest', 'desiredOutputs must be a list')
    const amount = (o: any, what: string): Amount => {
      const lane: Lane = o?.kind === 'shielded' ? 'private' : o?.kind === 'unshielded' ? 'public' : (() => { throw new ApiError('InvalidRequest', `${what} kind must be shielded or unshielded`) })()
      const type = String(o?.type ?? '').toLowerCase().replace(/^0x/, '')
      if (!/^[0-9a-f]{64}$/.test(type)) throw new ApiError('InvalidRequest', `${what} type must be a 32-byte hex token type`)
      const value = typeof o?.value === 'bigint' ? o.value : (() => { throw new ApiError('InvalidRequest', `${what} value must be a bigint`) })()
      if (value <= 0n) throw new ApiError('InvalidRequest', `${what} value must be positive`)
      return { lane, type, value }
    }
    const pays = rawIn.map((o: any) => amount(o, 'input'))
    // a shielded input is a zswap spend of ours (plus change): proved here with our prover (a sell on a launchpad)
    const shieldedIn = pays.some((a) => a.lane === 'private')
    const receives = rawOut.map((o: any) => {
      const a = amount(o, 'output')
      const to = parseAddress(String(o?.recipient ?? ''))
      if ('error' in to || to.lane !== a.lane) throw new ApiError('InvalidRequest', `recipient is not a ${o.kind} mainnet address`)
      return { ...a, recipient: to.bech32, address: to.address }
    })
    const intentId: number | 'random' = opts.intentId === 'random' ? 'random' : Number.isInteger(opts.intentId) && (opts.intentId as number) >= 1 && (opts.intentId as number) <= 65535 ? (opts.intentId as number) : (() => { throw new ApiError('InvalidRequest', "intentId must be 'random' or 1..65535") })()
    const payFees = opts.payFees === true
    return this.serial(async () => {
      if (!(await this.ask({ kind: 'intent', origin, pays, receives, payFees }))) throw new ApiError('Rejected', 'declined in the wallet')
      await this.session.whenCanTransact({ needDust: payFees })
      // a fee of ours (DUST spend) or a shielded input (zswap spend + change) needs proofs: our prover, built-in keys (nothing of the site's)
      const prover = payFees || shieldedIn ? {
        check: async (pre: Uint8Array) => ledger.parseCheckResult(await this.proverPost('/check', ledger.createCheckPayload(pre, undefined))),
        prove: async (pre: Uint8Array, _k: string, overwrite?: bigint) => this.proverPost('/prove', ledger.createProvingPayload(pre, overwrite, undefined)),
      } : null
      const note: DappNote = { origin, kind: 'trade', pays: describePays(pays), fee: '0' }
      const out = toHex(await this.session.dappMakeIntent(pays, receives, intentId, payFees, prover))
      addDappEntry(note, undefined, this.session.walletId)
      return { tx: out }
    })
  }

  /**
   * signData(data, { encoding, keyType: 'unshielded' }): a signature by the key behind the public address over
   * "midnight_signed_message:<size>:" followed by the data (DApp Connector specification). The prefix keeps a signed
   * message from ever being a transaction; the sheet shows what is signed.
   */
  private async signData(origin: string, params: unknown[]) {
    const data = params[0]
    const opts = (params[1] ?? {}) as { encoding?: string; keyType?: string }
    if (typeof data !== 'string' || data.length > 262_144) throw new ApiError('InvalidRequest', 'data must be a string of at most 256 KB')
    if (opts.keyType !== 'unshielded') throw new ApiError('InvalidRequest', "keyType must be 'unshielded'")
    let bytes: Uint8Array
    try {
      bytes = opts.encoding === 'text' ? new TextEncoder().encode(data) : opts.encoding === 'hex' ? fromHex(data) : opts.encoding === 'base64' ? fromB64(data) : (() => { throw new Error('encoding') })()
    } catch { throw new ApiError('InvalidRequest', "encoding must be 'hex', 'base64' or 'text', and the data must match it") }
    return this.serial(async () => {
      if (!(await this.ask({ kind: 'sign', origin, text: opts.encoding === 'text' ? data : null, bytes: bytes.length }))) throw new ApiError('Rejected', 'declined in the wallet')
      const head = new TextEncoder().encode(`midnight_signed_message:${bytes.length}:`)
      const message = new Uint8Array(head.length + bytes.length)
      message.set(head); message.set(bytes, head.length)
      const { signature, verifyingKey } = await this.session.dappSign(message)
      return { scheme: 'schnorr_bip340', data, signature, verifyingKey }
    })
  }

  private async submit(origin: string, params: unknown[]) {
    const bytes = txBytes(params[0])
    const hex = toHex(bytes)
    // A transaction is sent once. A second request for it while the first is on its way gets that one's result (a site
    // that asks again); another site is refused. Two sends of one transaction could end with one of them releasing
    // coins the other got into a block.
    const going = this.sending.get(hex)
    if (going) {
      if (going.origin !== origin) throw new ApiError('InvalidRequest', 'this transaction is already being sent')
      return going.done
    }
    const ok = this.approved.get(hex)
    const preApproved = !!ok && ok.origin === origin && ok.until > Date.now()
    // The sheet, when one is needed, waits its turn. The send does not hold the line: a network that is slow to answer,
    // or never answers, must not keep the next approval from showing.
    const done = (async (): Promise<null> => {
      if (!preApproved) await this.serial(async () => { if (!(await this.ask({ kind: 'submit', origin }))) throw new ApiError('Rejected', 'declined in the wallet') })
      return this.send(bytes, hex, preApproved ? ok?.note : undefined)
    })()
    // nothing has waited between the look at `sending` above and this entry: the transaction is claimed, sheet and all,
    // before any other request can run
    this.sending.set(hex, { origin, done })
    const over = () => {
      if (this.sending.get(hex)?.done === done) this.sending.delete(hex)
      // An approval whose time ran out while this request held the transaction (a sheet left open, then declined): the
      // timer left it alone then, so what it booked is released now. A transaction that was sent has no approval left.
      const kept = this.approved.get(hex)
      if (kept && kept.until <= Date.now() && this.approved.delete(hex)) void this.session.releaseSealed(bytes).catch(() => {})
    }
    done.then(over, over)
    return done
  }

  /** The send itself (see submit): never inside the approval line, and never twice at once for one transaction. */
  private async send(bytes: Uint8Array, hex: string, note?: DappNote): Promise<null> {
    // the wallet's own record of what it sent for a site (Activity shows it)
    const sent = () => {
      this.approved.delete(hex)
      if (note) addDappEntry(note, undefined, this.session.walletId)
    }
    try {
      await this.session.submitSealed(bytes)
    } catch (e: any) {
      if (e instanceof NotConfirmedYet) {
        // handed to the network and not seen in a block yet: it counts as sent, and the site is told exactly that
        sent()
        throw new ApiError('InternalError', e.message)
      }
      // refused: what it booked was released with the refusal; an approval past its time goes with it
      const kept = this.approved.get(hex)
      if (kept && kept.until <= Date.now()) this.approved.delete(hex)
      throw new ApiError('InvalidRequest', shortReason(e))
    }
    sent()
    return null
  }

  // ---- circuit key blobs: content-addressed (sha256 hex), uploaded in pieces ----
  // The cache belongs to ONE site: the in-app browser shows one site at a time, and the moment another origin
  // touches it, everything is dropped. So no site can see which keys another site uploaded (which dApps you use)
  // or disturb its uploads, and the hard limits below are also the global limits.
  private blobOrigin = ''
  private blobs = new Map<string, Uint8Array>()
  private partial = new Map<string, { parts: Array<Uint8Array | undefined>; got: number }>()
  private partialBytes = 0

  private blobScope(origin: string) {
    if (origin === this.blobOrigin) return
    this.blobs.clear(); this.partial.clear(); this.partialBytes = 0
    this.blobOrigin = origin
  }

  private blobHas(origin: string, params: unknown[]): string[] {
    const ids = params[0]
    if (!Array.isArray(ids) || ids.length > 7 || !ids.every((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x))) throw new ApiError('InvalidRequest', 'ids must be sha256 hex')
    this.blobScope(origin)
    // refresh LRU order of the ones we have
    for (const id of ids) { const b = this.blobs.get(id); if (b) { this.blobs.delete(id); this.blobs.set(id, b) } }
    return ids.filter((id) => !this.blobs.has(id))
  }

  private async blobPut(origin: string, params: unknown[]) {
    const [id, k, total, piece] = params as [string, number, number, Uint8Array]
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id) || !Number.isInteger(k) || !Number.isInteger(total) || total < 1 || total > BLOB_MAX_PIECES || k < 0 || k >= total || !(piece instanceof Uint8Array) || piece.length > BLOB_PIECE_MAX)
      throw new ApiError('InvalidRequest', 'bad blob piece')
    this.blobScope(origin)
    if (this.blobs.has(id)) return null
    let p = this.partial.get(id)
    if (!p || p.parts.length !== total) {
      if (p) this.dropPartial(id)
      if (this.partial.size >= BLOB_PARTIALS) throw new ApiError('InvalidRequest', 'too many unfinished uploads')
      p = { parts: new Array(total).fill(undefined), got: 0 }
      this.partial.set(id, p)
    }
    if (!p.parts[k]) {
      if (this.partialBytes + piece.length > BLOB_PARTIAL_BUDGET) { this.dropPartial(id); throw new ApiError('InvalidRequest', 'circuit key too large') }
      p.parts[k] = piece.slice(); p.got++; this.partialBytes += piece.length
    }
    if (p.got < total) return null
    const parts = p.parts as Uint8Array[]
    this.dropPartial(id)
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
    let off = 0
    for (const x of parts) { out.set(x, off); off += x.length }
    const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', out)))
    if (digest !== id) throw new ApiError('InvalidRequest', 'blob does not match its hash')
    if (origin !== this.blobOrigin) return null   // another site took over while hashing
    this.blobs.set(id, out)
    // bounded: drop least recently used keys beyond the budget (never the one just finished)
    let used = [...this.blobs.values()].reduce((n, b) => n + b.length, 0)
    for (const [kid, b] of this.blobs) { if (used <= BLOB_BUDGET || kid === id) break; this.blobs.delete(kid); used -= b.length }
    return null
  }

  private dropPartial(id: string) {
    const p = this.partial.get(id)
    if (!p) return
    for (const x of p.parts) if (x) this.partialBytes -= x.length
    this.partial.delete(id)
  }

  /** a key given inline (bytes) or by the id of a blob this site uploaded */
  private blob(origin: string, v: unknown): Uint8Array | undefined {
    if (v instanceof Uint8Array) return v
    if (typeof v === 'string') {
      const b = origin === this.blobOrigin ? this.blobs.get(v) : undefined
      if (!b) throw new ApiError('InvalidRequest', 'circuit key not uploaded')
      return b
    }
    return undefined
  }

  // proving: the dApp supplies its circuit keys, our prover does the work; nothing secret is involved
  private async proverCheck(origin: string, params: unknown[]) {
    const [pre, , ir] = params as [Uint8Array, string, unknown]
    if (!(pre instanceof Uint8Array)) throw new ApiError('InvalidRequest', 'preimage must be bytes')
    const res = await this.proverPost('/check', ledger.createCheckPayload(pre, this.blob(origin, ir)))
    return ledger.parseCheckResult(res).map((x) => (x === undefined ? null : x))
  }

  private async proverProve(origin: string, params: unknown[]) {
    const [pre, , overwrite, keys] = params as [Uint8Array, string, bigint | undefined | null, any]
    if (!(pre instanceof Uint8Array)) throw new ApiError('InvalidRequest', 'preimage must be bytes')
    let material: { proverKey: Uint8Array; verifierKey: Uint8Array; ir: Uint8Array } | undefined
    if (keys) {
      const proverKey = this.blob(origin, keys.proverKey), verifierKey = this.blob(origin, keys.verifierKey), ir = this.blob(origin, keys.ir)
      if (proverKey && verifierKey && ir) material = { proverKey, verifierKey, ir }
    }
    return this.proverPost('/prove', ledger.createProvingPayload(pre, typeof overwrite === 'bigint' ? overwrite : undefined, material))
  }

  private async proverPost(path: string, body: Uint8Array): Promise<Uint8Array> {
    try { return await proverPost(path as '/prove' | '/check', body) } catch (e) { throw new ApiError('InternalError', String((e as Error)?.message ?? e)) }
  }
}

function txBytes(v: unknown): Uint8Array {
  if (typeof v !== 'string') throw new ApiError('InvalidRequest', 'transaction must be a hex string')
  try { return fromHex(v) } catch { throw new ApiError('InvalidRequest', 'transaction must be a hex string') }
}

function shortReason(e: unknown): string {
  const m = String((e as any)?.reason ?? (e as any)?.message ?? e)
  return m.length > 237 ? m.slice(0, 233) + '…' : m
}
