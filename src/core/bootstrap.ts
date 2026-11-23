// Bootstrap snapshots: the server keeps a coin-less wallet at the chain tip and publishes its serialized
// shielded + DUST states (public Merkle frontiers and sync offsets, nothing wallet-specific). A wallet created
// after a snapshot can graft its own public keys onto it and sync from there instead of from genesis.
//
// Rule: a snapshot must predate the wallet's first possible transaction, or incoming coins would be skipped.
// New wallet -> the latest snapshot. Imported wallet -> the daily snapshot before its creation day, if any.
//
// A snapshot's offsets are event ids of the indexer it was built against (`indexer`, see net.ts indexerId): only a
// snapshot from the wallet's own indexer is usable.
//
// Format v2 (ledger 9, wallet SDK 2): `shielded` and `dust` are the bot's serialized sub-wallet states with its own
// identity removed (shielded: publicKeys, coinHashes; dust: publicKey, pendingDust). Everything else is carried as
// the SDK wrote it (state, protocolVersion, offset, networkId, version, writtenBy, syncKind, …), so a field a later
// SDK adds travels with the snapshot. v1 snapshots were written by the ledger-8 SDK and are not readable any more.
import { API_BASE } from './net'

type PublicState = { state: string; protocolVersion: unknown; offset: unknown; networkId: string } & Record<string, unknown>
export type Bootstrap = {
  v: 2
  savedAt: string
  /** indexerId() of the indexer this state was synced against */
  indexer?: string
  shielded: PublicState
  dust: PublicState
}

const base = () => `${API_BASE}api/bootstrap`
import { FIRST, scoped } from './scope'

const BIRTHDAY_KEY = 'lump.birthday.v1'
/** identity fields: always the wallet's own, never the snapshot's */
const SHIELDED_OWN = ['publicKeys', 'coinHashes'], DUST_OWN = ['publicKey', 'pendingDust']

/** The snapshot for `day`, or null when there is none or it was built against another indexer than `indexer`. */
export async function fetchBootstrap(day: 'latest' | string, indexer: string): Promise<Bootstrap | null> {
  try {
    const r = await fetch(day === 'latest' ? base() : `${base()}/${day}`, { cache: 'no-store' })
    if (!r.ok) return null
    const b = (await r.json()) as Bootstrap
    if (!(b?.v === 2 && typeof b.shielded?.state === 'string' && typeof b.dust?.state === 'string')) return null
    if (b.indexer !== indexer) { console.info(`bootstrap ${day}: built against ${b.indexer ?? 'another indexer'}, not ${indexer}; ignored`); return null }
    // a snapshot that still carried an identity would hand this wallet somebody else's keys or coins
    if (SHIELDED_OWN.some((k) => k in b.shielded) || DUST_OWN.some((k) => k in b.dust)) return null
    return b
  } catch { return null }
}

export async function fetchBootstrapDays(): Promise<string[]> {
  try { const r = await fetch(`${base()}/days`, { cache: 'no-store' }); return r.ok ? ((await r.json()) as string[]) : [] } catch { return [] }
}

// ---- the public DUST state of earlier days (tools/dust-days.mjs): where a wallet reads its fee energy history from
// when that history began before the snapshot it would otherwise start at ----
const DAY = /^\d{4}-\d{2}-\d{2}$/
async function fetchDustDays(): Promise<string[]> {
  try { const r = await fetch(`${base()}/dust-days`, { cache: 'no-store' }); return r.ok ? ((await r.json()) as string[]).filter((d) => DAY.test(d)) : [] } catch { return [] }
}
async function fetchDustDay(day: string, indexer: string): Promise<PublicState | null> {
  try {
    const r = await fetch(`${base()}/dust/${day}`, { cache: 'no-store' })
    if (!r.ok) return null
    const b = (await r.json()) as { v?: number; indexer?: string; dust?: PublicState }
    if (!(b?.v === 2 && typeof b.dust?.state === 'string') || b.indexer !== indexer) return null
    if (DUST_OWN.some((k) => k in b.dust!)) return null
    return b.dust
  } catch { return null }
}
/**
 * The newest public DUST state from a day BEFORE the UTC day of `since` (ms epoch): replaying from it misses
 * nothing that happened at or after `since`. A day's state is one taken during that day, so only earlier days
 * qualify. null: none is kept that old (the wallet then starts at the ledger-9 fork).
 */
export async function dustStateBefore(since: number, indexer: string): Promise<{ day: string; dust: PublicState } | null> {
  const limit = new Date(since).toISOString().slice(0, 10)
  const [full, dustOnly] = await Promise.all([fetchBootstrapDays(), fetchDustDays()])
  const days = [...new Set([...full, ...dustOnly])].filter((d) => DAY.test(d) && d < limit).sort().reverse()
  for (const day of days.slice(0, 4)) {
    const dust = full.includes(day) ? (await fetchBootstrap(day, indexer))?.dust ?? null : await fetchDustDay(day, indexer)
    if (dust) return { day, dust }
  }
  return null
}
/** This wallet's own DUST identity (from its own coin-less serialized state) on a public DUST state. */
export function graftDustState(dust: PublicState, ownEmptyDust: string): string {
  const du = JSON.parse(ownEmptyDust)
  return JSON.stringify({ ...du, ...dust, ...pick(du, ['publicKey']), pendingDust: [] })
}

/** Latest daily snapshot strictly before the wallet's creation day (UTC), or null when none is old enough. */
export function pickDay(days: string[], birthday: string): string | null {
  const ok = days.filter((d) => d < birthday).sort()
  return ok.length ? ok[ok.length - 1] : null
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]))

/** Graft this wallet's identity (from its own empty serialized states) onto the snapshot's public state. */
export function graft(boot: Bootstrap, emptyShielded: string, emptyDust: string): { shielded: string; dust: string } {
  const sh = JSON.parse(emptyShielded), du = JSON.parse(emptyDust)
  return {
    shielded: JSON.stringify({ ...sh, ...boot.shielded, publicKeys: sh.publicKeys, coinHashes: {} }),
    dust: JSON.stringify({ ...du, ...boot.dust, ...pick(du, ['publicKey']), pendingDust: [] }),
  }
}

/** DUST side only: this wallet's cached (coin-less) DUST identity on the snapshot's current public DUST state. */
export function graftDust(boot: Bootstrap, cachedDust: string): string {
  const du = JSON.parse(cachedDust)
  return JSON.stringify({ ...du, ...boot.dust, ...pick(du, DUST_OWN) })
}

export const todayUtc = () => new Date().toISOString().slice(0, 10)
// each wallet has its own (core/scope.ts); the first wallet's is under the name it always had
export function saveBirthday(day: string, walletId: string = FIRST) { try { localStorage.setItem(scoped(BIRTHDAY_KEY, walletId), day) } catch {} }
export function loadBirthday(walletId: string = FIRST): string | null { try { return localStorage.getItem(scoped(BIRTHDAY_KEY, walletId)) } catch { return null } }
export function clearBirthday(walletId: string = FIRST) { try { localStorage.removeItem(scoped(BIRTHDAY_KEY, walletId)) } catch {} }
