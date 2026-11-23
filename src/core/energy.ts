// Fee energy from NIGHT on Cardano: what the app asks our Cardano door (server/cardano/door.mjs through
// /api/cardano/*), and the two things it has it build: the registration of this wallet's Cardano address for DUST,
// and moving everything on that address out. The door only builds; cardanoTx.ts decides here whether a transaction
// may be signed, and the keys never leave this device.
import { API_BASE } from './net'
import { checkMoveOut, checkRegistration, checkSend, type Checked } from './cardanoTx'
import type { WalletSession } from './wallet'
import { noteReplayDust } from './dustNotes'
import { scoped } from './scope'

export type EnergyState = {
  lovelace: bigint; night: bigint; coins: number; otherTokens: number; needsLovelace: bigint
  /** ADA in coins that hold nothing else: what a send of ADA can use (the rest travels with NIGHT or other tokens) */
  adaFree: bigint
  /** none: not registered · here: to this wallet · elsewhere: to another fee energy address · double: twice (earns nothing) */
  mapped: 'none' | 'here' | 'elsewhere' | 'double'
  /** what Midnight sees for the address's stake key; null when our indexer did not answer */
  midnight: { registered: boolean; night: bigint; capSpeck: bigint } | null
  /** when the address was registered on Cardano (ms epoch) and by which transaction; null when it is not, or unknown */
  registeredAt: number | null
  registeredTx: string | null
}
export type Prepared = { kind: 'register' | 'moveout' | 'send'; id: string; checked: Checked }

const PENDING_KEY = 'lump.energy.registered.v1'
/** Midnight reads Cardano about half a day behind (measured: not yet at 12.1 h, there at 14.6 h). */
export const MIDNIGHT_SEES_AFTER_MS = 14 * 3_600_000

async function call<T>(path: string, body?: unknown, giveUpMs?: number): Promise<T> {
  let r: Response
  // a look at the address gives up after 20 s (the screen says so and asks again by itself); building or handing in a transaction gets 2 minutes
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), giveUpMs ?? (body === undefined ? 20_000 : 120_000))
  try { r = await fetch(`${API_BASE}api/cardano/${path}`, body === undefined ? { cache: 'no-store', signal: stop.signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: stop.signal }) }
  catch { throw new Error('The Cardano service is not answering right now') }
  finally { clearTimeout(timer) }
  let j: Record<string, unknown> | null = null
  try { j = (await r.json()) as Record<string, unknown> } catch { /* not ours */ }
  if (!r.ok || !j) throw new Error(typeof j?.error === 'string' ? j.error.slice(0, 160) : 'The Cardano service is not answering right now')
  return j as T
}
const big = (v: unknown) => { try { return BigInt(String(v ?? '0')) } catch { return 0n } }

/** `dustAddress` '' asks only whether the address is registered at all (then 'elsewhere' means: yes, to some wallet). */
export async function energyState(address: string, dustAddress: string, giveUpMs?: number): Promise<EnergyState> {
  const j = await call<Record<string, unknown>>(`state?address=${encodeURIComponent(address)}${dustAddress ? `&dust=${encodeURIComponent(dustAddress)}` : ''}`, undefined, giveUpMs)
  const m = j.midnight as Record<string, unknown> | null
  const mapped = j.mapped === 'here' || j.mapped === 'elsewhere' || j.mapped === 'double' ? j.mapped : 'none'
  return {
    lovelace: big(j.lovelace), night: big(j.night), coins: Number(j.coins) || 0, otherTokens: Number(j.otherTokens) || 0, needsLovelace: big(j.needsLovelace), adaFree: big(j.adaOnly), mapped,
    midnight: m ? { registered: m.registered === true, night: big(m.night), capSpeck: big(m.cap) } : null,
    registeredAt: Number.isFinite(Number(j.registeredAt)) && Number(j.registeredAt) > 0 ? Number(j.registeredAt) * 1000 : null,
    registeredTx: typeof j.registeredTx === 'string' ? j.registeredTx : null,
  }
}

/** One transaction on the Cardano address: what the address gained (+) or lost (-) in it; what left includes the network fee. */
export type CardanoActivityItem = { tx: string; time: number; lovelace: bigint; night: bigint; others: number; registration: boolean }
/** The address's transactions, newest first (our Cardano service reads them from our own chain index). */
export async function cardanoActivity(address: string): Promise<{ items: CardanoActivityItem[]; more: boolean }> {
  const j = await call<{ items?: unknown; more?: unknown }>(`activity?address=${encodeURIComponent(address)}`)
  const items = (Array.isArray(j.items) ? j.items : []).map((x) => {
    const o = x as Record<string, unknown>
    return { tx: String(o.tx ?? ''), time: Number(o.at) * 1000, lovelace: big(o.lovelace), night: big(o.night), others: Number(o.others) || 0, registration: o.registration === true }
  }).filter((x) => /^[0-9a-f]{64}$/.test(x.tx) && Number.isFinite(x.time))
  return { items, more: j.more === true }
}

// ---- what the Cardano address held when it was last looked at, per wallet: the total on Home counts it from the
// first moment, before the service has answered ----
const HELD_KEY = 'lump.cardano.held.v1'
export type HeldOnCardano = { night: bigint; lovelace: bigint }
export function heldOnCardano(walletId: string): HeldOnCardano | null {
  try {
    const j = JSON.parse(localStorage.getItem(scoped(HELD_KEY, walletId)) ?? 'null') as { night?: string; lovelace?: string } | null
    return j ? { night: big(j.night), lovelace: big(j.lovelace) } : null
  } catch { return null }
}
export function noteHeldOnCardano(walletId: string, st: { night: bigint; lovelace: bigint }) {
  try { localStorage.setItem(scoped(HELD_KEY, walletId), JSON.stringify({ night: String(st.night), lovelace: String(st.lovelace) })) } catch { /* no storage */ }
}
export function forgetHeldOnCardano(walletId: string) { try { localStorage.removeItem(scoped(HELD_KEY, walletId)) } catch { /* no storage */ } }

const me = (s: WalletSession) => { if (!s.cardano) throw new Error('This wallet has no Cardano address'); return s.cardano }

/** Has the door build the registration and checks it. Nothing is signed yet. */
export async function prepareRegistration(s: WalletSession, dustAddress: string): Promise<Prepared> {
  const a = me(s)
  const j = await call<{ cbor: string; id: string }>('register', { address: a.address, dust: dustAddress })
  const checked = checkRegistration(String(j.cbor), a, dustAddress)
  return { kind: 'register', id: checked.idHex, checked }
}

/** Has the door build a send of ADA (an amount, or 'all' that is free) or of NIGHT to `to`, and checks it is exactly that. Nothing is signed yet. */
export async function prepareSend(s: WalletSession, to: string, want: { lovelace: bigint | 'all'; night: bigint }): Promise<Prepared> {
  const a = me(s)
  const j = await call<{ cbor: string; id: string }>('send', { address: a.address, to: to.trim(), ...(want.night > 0n ? { night: String(want.night) } : { lovelace: String(want.lovelace) }) })
  const checked = checkSend(String(j.cbor), a, to, want)
  return { kind: 'send', id: checked.idHex, checked }
}

/** Has the door build "everything on the address goes to `to`" and checks it. Nothing is signed yet. */
export async function prepareMoveOut(s: WalletSession, to: string): Promise<Prepared> {
  const a = me(s)
  const j = await call<{ cbor: string; id: string }>('moveout', { address: a.address, to: to.trim() })
  const checked = checkMoveOut(String(j.cbor), a, to)
  return { kind: 'moveout', id: checked.idHex, checked }
}

/** Signs the id this app computed from the checked bytes (never one a server names) and hands the signatures back. */
export async function signAndSend(s: WalletSession, p: Prepared): Promise<string> {
  const witness = s.cardanoWitness(p.checked.id, p.kind === 'register')
  const j = await call<{ id: string }>('submit', { id: p.id, witness })
  // one note per address: with several wallets, registering a second one must not lose the first one's
  // from here on this wallet's fee energy sync never skips history: what the registration earns begins while the app may be closed
  if (p.kind === 'register') noteReplayDust(s.walletId)
  if (p.kind === 'register') { try { localStorage.setItem(`${PENDING_KEY}.${me(s).address}`, JSON.stringify({ id: String(j.id), at: Date.now(), address: me(s).address })) } catch {} }
  return String(j.id)
}

/** When this device sent a registration for this address (so the screen can say when Midnight will see it). */
export function registeredAt(address: string): number | null {
  try {
    // the note of this address, or the single one an earlier build kept
    const j = JSON.parse(localStorage.getItem(`${PENDING_KEY}.${address}`) ?? localStorage.getItem(PENDING_KEY) ?? 'null') as { at?: number; address?: string } | null
    return j && j.address === address && Number.isFinite(j.at) ? Number(j.at) : null
  } catch { return null }
}

export const fmtAda = (lovelace: bigint, digits = 2) => (Number(lovelace) / 1e6).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
export const fmtNight = (star: bigint) => (Number(star) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })
