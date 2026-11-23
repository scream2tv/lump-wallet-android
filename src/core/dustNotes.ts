// What a wallet on this device has to remember about its fee energy (DUST) sync, per wallet (core/scope.ts).
//
// A wallet's DUST side may only skip chain history when nothing in that history can be the wallet's. Fee energy
// from NIGHT on Cardano begins on Midnight about half a day after the registration, whether or not the app is open,
// so a wallet that is or was registered never skips: it replays. `replay` is that mark, and it is never taken back.
//
// `search`: the fee energy history is being read again (it was skipped once: an early build jumped over it, or the
// wallet was brought along with a date after its registration). While a search is under way nothing may replace
// this device's DUST state: no jump to a newer snapshot, no other device's state.
import { FIRST, scoped } from './scope'

const REPLAY = 'lump.dust.replay.v1', SEARCH = 'lump.dust.search.v1'

/**
 * at: when it began. why: the wallet found by itself that fee energy was missing, or the person asked in Settings.
 * all: everything is read again, not only the fee energy. tx: the Cardano registration it was started for.
 * from: the DUST event it started at (for the progress line). done: when it ended (the note stays, so the wallet
 * does not search for the same registration twice).
 */
export type DustSearchNote = { at: number; why: 'auto' | 'asked'; all?: boolean; tx?: string | null; from?: string; done?: number }

export const mustReplayDust = (walletId: string = FIRST): boolean => { try { return localStorage.getItem(scoped(REPLAY, walletId)) === '1' } catch { return false } }
export function noteReplayDust(walletId: string = FIRST) { try { localStorage.setItem(scoped(REPLAY, walletId), '1') } catch { /* no storage: the check is made again next time */ } }

export function readDustSearch(walletId: string = FIRST): DustSearchNote | null {
  try {
    const j = JSON.parse(localStorage.getItem(scoped(SEARCH, walletId)) ?? 'null') as DustSearchNote | null
    return j && Number.isFinite(j.at) && (j.why === 'auto' || j.why === 'asked') ? j : null
  } catch { return null }
}
export function writeDustSearch(note: DustSearchNote | null, walletId: string = FIRST) {
  try { if (note) localStorage.setItem(scoped(SEARCH, walletId), JSON.stringify(note)); else localStorage.removeItem(scoped(SEARCH, walletId)) } catch { /* no storage */ }
}
/** The search still under way for this wallet, if any. */
export const dustSearching = (walletId: string = FIRST): DustSearchNote | null => { const n = readDustSearch(walletId); return n && !n.done ? n : null }

/** The wallet is removed from this device. */
export function forgetDustNotes(walletId: string = FIRST) {
  try { localStorage.removeItem(scoped(REPLAY, walletId)); localStorage.removeItem(scoped(SEARCH, walletId)) } catch { /* no storage */ }
}
