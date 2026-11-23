// What this wallet approved for a site and saw sent: the wallet's own record, kept on the device only. The chain's
// public record shows a purchase as "USDM left", and shows nothing of a transaction that moves only private coins (an
// NFT put up for sale); this says which site it was for and what left the wallet, named as the wallet named it then.
import type { Amount } from './host'
import { loadCachedNfts } from '../core/nfts'

import { scoped } from '../core/scope'

const KEY = 'lump.dapp.activity.v1'
const KEEP = 211

export type DappPay = { type: string; value: string; lane: 'public' | 'private'; nft?: string; collection?: string }
/** kind 'transaction': the wallet sent it. 'trade': an offer the site completed in a transaction of its own. */
export type DappEntry = { at: number; origin: string; kind: 'transaction' | 'trade'; pays: DappPay[]; fee: string }
export type DappNote = Omit<DappEntry, 'at'>

/** The amounts as the wallet shows them now (an NFT by its name: once it has left, the name could not be looked up). */
export function describePays(pays: Amount[]): DappPay[] {
  let nfts: ReturnType<typeof loadCachedNfts> = []
  try { nfts = loadCachedNfts() } catch { /* names are a nicety */ }
  return pays.map((a) => {
    const n = a.value === 1n ? nfts.find((x) => x.type === a.type && x.lane === a.lane) : undefined
    return { type: a.type, value: String(a.value), lane: a.lane, ...(n ? { nft: n.name, collection: n.collection } : {}) }
  })
}

const listeners = new Set<() => void>()
export const onDappEntries = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** A wallet's entries: the wallet in use when no id is given (the screens); a site's host gives its own wallet's id. */
export function listDappEntries(walletId?: string): DappEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(scoped(KEY, typeof walletId === 'string' ? walletId : undefined)) ?? '[]')
    return Array.isArray(v) ? v.filter((e) => e && typeof e.at === 'number' && typeof e.origin === 'string' && Array.isArray(e.pays)) : []
  } catch { return [] }
}

export function addDappEntry(note: DappNote, at = Date.now(), walletId?: string) {
  try {
    localStorage.setItem(scoped(KEY, walletId), JSON.stringify([{ ...note, at }, ...listDappEntries(walletId)].slice(0, KEEP)))
  } catch { /* no room: the transaction itself is unaffected */ }
  listeners.forEach((fn) => { try { fn() } catch {} })
}

/** A wallet's entries (that wallet is leaving the device). Each wallet has its own (core/scope.ts). */
export function forgetDappEntries(walletId: string) { try { localStorage.removeItem(scoped(KEY, walletId)) } catch {} }
