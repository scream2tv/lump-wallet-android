// Wallet session: seeds + the SDK facade (shielded / unshielded / DUST sub-wallets) + a small observable
// snapshot the UI renders. Runs unchanged in a browser or the native shell.
// The synced state is cached encrypted (stateStore) so a re-open resumes instead of replaying from genesis.
//
// Ledger 9 (mainnet since 2026-11-06): wallet SDK 2. The SDK reads the chain's ledger-8 history with ledger 8 and
// everything after the fork with ledger 9; every transaction this wallet builds is a ledger-9 transaction.
import { cardanoAccount, cardanoKeys, witnessSet, wipe, type CardanoAccount } from './cardano'
import * as ledger from '@midnightntwrk/ledger-v9'
import { InMemoryTransactionHistoryStorage, ProtocolVersion } from '@midnightntwrk/wallet-sdk'
import { DefaultForkSchedule, WalletEntrySchema, WalletFacade, isAwaiting, mergeWalletEntries, type WalletEntry } from '@midnightntwrk/wallet-sdk/facade'
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded'
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnightntwrk/wallet-sdk/unshielded'
import { DustWallet } from '@midnightntwrk/wallet-sdk/dust'
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk/address-format'
import { firstValueFrom } from 'rxjs'
import { Option } from 'effect'
import { seedsFromMnemonic, type WalletSeeds } from './keys'
import { dustForkOf, indexerId, loadEndpoints } from './net'
import { clearState, loadState, saveState } from './stateStore'
import { FIRST } from './scope'
import { clearBirthday, dustStateBefore, fetchBootstrap, fetchBootstrapDays, graft, graftDust, graftDustState, loadBirthday, pickDay, type Bootstrap } from './bootstrap'
import { dustSearching, mustReplayDust, noteReplayDust, readDustSearch, writeDustSearch } from './dustNotes'
import { energyState } from './energy'
import { NotConfirmedYet, sendSettled } from './sendWait'
import type { ParsedAddress, SendPhase } from './send'
import { provingService } from './prover'
import { partsEstimate, sendInParts } from './split'
import { ahead, fetchHandoff, handoffKeys, offsetsOf, putHandoff, sharingOn, type HandoffKeys, type Offsets, type SyncCache } from './handoff'

export const NIGHT_TYPE = '0'.repeat(64)
export const DUST_DECIMALS = 15
export const NIGHT_DECIMALS = 6

const SAVE_EVERY_MS = 61_000
const SYNC_BATCH = { size: 64, timeout: 1, spacing: 2 }
const STABLE_MS = 3_000
/** the node rejects DUST spends for ~60 s after a catch-up sync (error 170); the UI waits this long before enabling Send */
const LIVE_WAIT_MS = 60_000
/** ledger 9 starts at this protocol version; a DUST state below it is still reading ledger-8 history */
const FORK = BigInt(DefaultForkSchedule.v9)
const TEST_BUILD = import.meta.env.DEV || import.meta.env.VITE_LOCAL === '1'
const TEST_CACHE_KEY = 'lump.test.cache'
/** Device hand-off (src/core/handoff.ts): how often a running wallet looks at the server's copy, and when it shares its own. */
const HAND_EVERY_MS = 47_000
/** another device's state is only taken when it is at least this many events further: a restart has to be worth it */
const HAND_WORTH = 2_000n
/** while syncing, share again after this long if the wallet got this much further; at the tip, every 23 minutes */
const SHARE_SYNCING_MS = 307_000, SHARE_SYNCING_STEP = 5_000n, SHARE_READY_MS = 23 * 60_000

export type Progress = { applied: bigint; highest: bigint; connected: boolean }
/** how this session began: own cache, another device's state (hand-off), a server bootstrap snapshot, or a full replay from genesis */
export type StartMode = 'cache' | 'handoff' | 'bootstrap' | 'genesis'
export type StartOptions = {
  /** first start of a brand-new wallet: safe to begin at the newest snapshot */ fresh?: boolean
  /** which of the device's wallets this is (core/scope.ts): its sync cache and creation date are kept under it */ walletId?: string
  /** Settings, "Scan everything again": what this device has synced for the wallet is dropped and the chain is read from the start */ rescan?: boolean
}
export type Snapshot = {
  phase: 'starting' | 'syncing' | 'ready' | 'error'
  error?: string
  startedAt: number
  startMode: StartMode | null
  resumedFrom: string | null
  /** the DUST sub-wallet resumed from the server's newest snapshot instead of replaying since the cache (coin-less wallets) */
  dustGrafted: boolean
  /** the fee energy history is being read again: since when, from which DUST event, and whether everything is (core/dustNotes.ts) */
  dustSearch: { startedAt: number; from: bigint; all: boolean } | null
  /** a search ended and the wallet still holds no fee energy although Midnight makes some for it */
  dustMissing: boolean
  /** device hand-off: when this session took another device's state, and when it last shared its own (ms epoch) */
  handoff: { receivedAt: number | null; sharedAt: number | null; shareError: string | null }
  readyForTxAt: number | null
  /** shielded + unshielded synced and stable: enough for a dApp transaction whose fee someone else pays (no DUST, no live wait) */
  tradeReady: boolean
  shielded: Progress | null
  dust: Progress | null
  unshieldedAddress: string
  shieldedAddress: string
  dustAddress: string
  balances: {
    unshielded: Map<string, bigint>
    shielded: Map<string, bigint>
    dust: bigint
    dustCap: bigint
    /** when the slowest DUST source reaches its cap (ms epoch), null when nothing generates */
    dustFullAt: number | null
  }
}

type Listener = (s: Snapshot) => void
/**
 * meta: what the DUST sub-wallet held at save time — a coin-less, NIGHT-less wallet may skip the DUST replay on resume.
 * indexer: indexerId() of the indexer the state was synced against; a cache without it, or from another indexer, is
 * dropped (sync offsets are per-indexer event ids). history: the wallet's own transactions, as the SDK serializes them.
 */
type Cache = SyncCache
type History = InMemoryTransactionHistoryStorage<WalletEntry, any>

const encodeAddress = (a: unknown): string => {
  if (!a) return ''
  if (typeof a === 'string') return a
  try { return MidnightBech32m.encode('mainnet', a as never).toString() } catch { return '' }
}

const toMap = (rec: unknown): Map<string, bigint> => {
  const m = new Map<string, bigint>()
  if (!rec) return m
  const entries = rec instanceof Map ? [...rec.entries()] : Object.entries(rec as Record<string, unknown>)
  for (const [k, v] of entries) { try { m.set(String(k).toLowerCase(), BigInt(v as never)) } catch {} }
  return m
}

/**
 * A DUST sub-wallet started from nothing AT THE LEDGER-9 FORK. The SDK finds the fork by asking the indexer, and when
 * that search fails once (a busy indexer is enough) it quietly starts at the first event instead: three quarters of
 * the chain's DUST events replayed for nothing. So where it starts is checked, and the search repeated a few times.
 * After that the full replay is accepted: slow, never wrong.
 */
async function freshDust(cfg: Parameters<typeof DustWallet>[0], seed: Uint8Array) {
  // our own indexer: the position is a known constant, so nothing has to be searched (the SDK's search opens a
  // subscription per step, which is load our indexer is better spared)
  const known = dustForkOf(cfg.indexerClientConnection.indexerHttpUrl)
  if (known) {
    const probe = { dustTimelineStartProbe: async () => Option.some({ cursor: known.cursor, version: ProtocolVersion.ProtocolVersion(known.version) }) }
    const w = await DustWallet({ ...cfg, ...probe } as Parameters<typeof DustWallet>[0]).startWithSeed(seed)
    const s = await firstValueFrom(w.state)
    if (BigInt(s.protocolVersion) >= FORK && s.progress.appliedIndex === known.cursor) return w
    console.info(`DUST start: the known fork position was not taken (at ${s.progress.appliedIndex}, version ${s.protocolVersion}); searching`)
    await w.stop().catch(() => {})
  }
  const Dust = DustWallet({ ...cfg, skipLedgerV8DustHistory: true })
  for (let attempt = 1; ; attempt++) {
    const w = await Dust.startWithSeed(seed)
    const s = await firstValueFrom(w.state)
    if (BigInt(s.protocolVersion) >= FORK || attempt >= 3) { if (attempt > 1) console.info('DUST start: ' + (BigInt(s.protocolVersion) >= FORK ? 'fork found on try ' + attempt : 'fork not found, full replay')); return w }
    await w.stop().catch(() => {})
    await new Promise((r) => setTimeout(r, 1_100 * attempt))
  }
}

const newHistory = (): History => new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries)

export class WalletSession {
  private facade: WalletFacade | null = null
  private seeds: WalletSeeds | null = null
  private keystore: ReturnType<typeof createKeystore> | null = null
  private history: History | null = null
  private stateKey: CryptoKey | null = null
  /** which of the device's wallets this session is (set by start) */
  walletId: string = FIRST
  /** indexerId() of this session's indexer: stamped on every saved cache and exported snapshot */
  private indexer = ''
  private listeners = new Set<Listener>()
  private lastState: any = null
  private dirty = false
  private stateSub: { unsubscribe(): void } | null = null
  private syncedSince = 0
  private tradeSyncedSince = 0
  private timers: ReturnType<typeof setInterval>[] = []
  private saving = false
  /** device hand-off: this wallet's id + key on the server, the tag and offsets of the copy last seen there, what was last shared */
  /** The wallet's Cardano address (same phrase): the NIGHT held there earns this wallet's fee energy. core/cardano.ts */
  cardano: CardanoAccount | null = null
  private cardanoSigner: ((txId: Uint8Array, withStake: boolean) => string) | null = null
  /** Witnesses for a Cardano transaction id. The caller has checked the transaction (core/cardanoTx.ts) and asked the person. */
  cardanoWitness(txId: Uint8Array, withStake: boolean): string {
    if (!this.cardanoSigner) throw new Error('The wallet is locked')
    return this.cardanoSigner(txId, withStake)
  }
  private hand: HandoffKeys | null = null
  private handTag: string | null = null
  private handTheirs: Offsets | null = null
  private handBusy = false
  private swapping = false
  /** fee energy check (checkFeeEnergy): one at a time, and when the last one asked our Cardano service */
  private checking = false
  private checkedAt = 0
  private shared: { at: number; sum: bigint; ready: boolean } | null = null
  private onHide = () => { if (document.visibilityState === 'hidden') void this.save() }
  snap: Snapshot

  constructor() {
    this.snap = {
      phase: 'starting', startedAt: Date.now(), startMode: null, resumedFrom: null, dustGrafted: false, dustSearch: null, dustMissing: false, handoff: { receivedAt: null, sharedAt: null, shareError: null }, readyForTxAt: null, tradeReady: false, shielded: null, dust: null,
      unshieldedAddress: '', shieldedAddress: '', dustAddress: '',
      balances: { unshielded: new Map(), shielded: new Map(), dust: 0n, dustCap: 0n, dustFullAt: null },
    }
  }

  subscribe(fn: Listener) { this.listeners.add(fn); fn(this.snap); return () => { this.listeners.delete(fn) } }
  private emit(patch: Partial<Snapshot>) { this.snap = { ...this.snap, ...patch }; for (const l of this.listeners) l(this.snap) }

  async start(mnemonic: string, stateKey: CryptoKey | null, opts: StartOptions = {}) {
    const net = loadEndpoints()
    this.stateKey = stateKey
    this.walletId = opts.walletId ?? FIRST
    // the Cardano side: its address is public; its keys are derived per signature and wiped again
    try {
      this.cardano = cardanoAccount(mnemonic)
      this.cardanoSigner = (txId, withStake) => { const k = cardanoKeys(mnemonic); try { return witnessSet(k, txId, withStake) } finally { wipe(k) } }
    } catch { this.cardano = null; this.cardanoSigner = null }
    const ix = indexerId(net.indexerUrl)
    this.indexer = ix
    try {
      if (opts.rescan) {
        // everything this device synced for the wallet goes; the chain is read again from the start (funds are on the
        // chain, not here). The note keeps another device's state and the snapshots out until that is done.
        await clearState(this.walletId).catch(() => {})
        clearBirthday(this.walletId)
        noteReplayDust(this.walletId)
        writeDustSearch({ at: Date.now(), why: 'asked', all: true }, this.walletId)
      }
      // a search for this wallet's fee energy that is still under way (begun in this or an earlier session)
      const searching = dustSearching(this.walletId)
      const seeds = seedsFromMnemonic(mnemonic)
      this.seeds = seeds
      const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, net.networkId)
      this.keystore = keystore

      // 1) own encrypted cache  2) server bootstrap snapshot (new wallet: newest; imported: the day before its
      // creation)  3) full replay from genesis
      let cache: Cache | null = stateKey ? await loadState<Cache>(stateKey, this.walletId) : null
      if (cache && cache.indexer !== ix) {
        // synced against another indexer (or the same one before it was re-indexed): its offsets mean nothing here,
        // and resuming would fail ("values inserted non-linearly") or silently skip events. Drop it once; the next
        // save carries this indexer's stamp.
        console.info(`sync cache from ${cache.indexer ?? 'an earlier indexer'} (saved ${cache.saved}), now ${ix}: discarded, resyncing`)
        cache = null
        await clearState(this.walletId).catch(() => {})
      }
      // Test builds only (dev server, or VITE_LOCAL=1): a headless test may hand over sub-wallet states that were
      // synced elsewhere for THIS wallet against THIS indexer, so it does not have to replay the chain. Read once.
      if (!cache && TEST_BUILD) {
        try {
          const raw = localStorage.getItem(TEST_CACHE_KEY)
          if (raw) { localStorage.removeItem(TEST_CACHE_KEY); cache = { ...(JSON.parse(raw) as Cache), indexer: ix }; console.info(`test cache taken (saved ${cache.saved})`) }
        } catch {}
      }
      // Another device of this wallet may be further along (a computer left syncing): take its state when it is.
      // Authenticated by a key only the recovery phrase gives, so it is this wallet's own state, synced elsewhere.
      let fromHandoff = false
      this.hand = await handoffKeys(mnemonic).catch(() => null)
      // not while a search is under way: the other device's state may be the very one that skipped the fee energy
      if (this.hand && !searching) {
        const theirs = await this.betterHandoff(offsetsOf(cache), 6_000)
        if (theirs) { cache = theirs; fromHandoff = true; console.info(`hand-off: starting from another device's state (saved ${theirs.saved})`) }
      }
      let startMode: StartMode = 'genesis'
      let dustGrafted = false
      if (cache) {
        startMode = fromHandoff ? 'handoff' : 'cache'
        // The DUST sub-wallet replays every network DUST event since the cache although a wallet with no DUST coins
        // and no NIGHT (nothing can generate DUST for it) learns nothing from them. Such a wallet resumes its DUST
        // side from the server's newest coin-less snapshot instead and is trade-ready in seconds. A wallet that holds
        // NIGHT or DUST keeps the full replay (a registration or a spend must not be missed).
        // NIGHT on CARDANO generates DUST too (a registration), about half a day after it was registered and whether
        // or not the app is open: a wallet that is or may be registered, or is searching, replays as well.
        if (cache.meta && cache.meta.dustCoins === 0 && cache.meta.night === '0' && (searching || !(await this.dustMayJump()))) {
          console.info(`DUST resume: full replay (${searching ? 'a search for the fee energy is under way' : 'the Cardano address is registered, or that could not be checked'})`)
        } else if (cache.meta && cache.meta.dustCoins === 0 && cache.meta.night === '0') {
          const boot = await fetchBootstrap('latest', ix).catch(() => null)
          const ahead = (a: unknown, b: unknown) => { try { return BigInt(String(a)) > BigInt(String(b)) } catch { return false } }
          let cachedOffset: unknown = null
          try { cachedOffset = JSON.parse(cache.dust).offset } catch {}
          console.info(`DUST resume: cache offset ${String(cachedOffset)} (saved ${cache.saved}), snapshot ${boot ? `offset ${String(boot.dust.offset)} saved ${boot.savedAt}` : 'unavailable'}`)
          if (boot && ahead(boot.dust.offset, cachedOffset)) { cache = { ...cache, dust: graftDust(boot, cache.dust) }; dustGrafted = true }
        } else console.info(`DUST resume: full replay (cache meta ${cache.meta ? JSON.stringify(cache.meta) : 'absent'})`)
      }

      let facade: WalletFacade | null = null
      if (cache) {
        try {
          facade = await this.build(net, keystore, seeds, cache)
        } catch (e: any) {
          // a cache this SDK cannot read (written before ledger 9, or damaged) only costs a fresh sync
          console.info(`${fromHandoff ? 'hand-off' : 'sync cache'} not usable (${String(e?.message ?? e).slice(0, 160)}): discarded, resyncing`)
          cache = null; startMode = 'genesis'; dustGrafted = false
          if (fromHandoff) {
            // the other device's state did not load: this device's own cache is still there and still good
            fromHandoff = false
            const own = stateKey ? await loadState<Cache>(stateKey, this.walletId) : null
            if (own && own.indexer === ix) { try { facade = await this.build(net, keystore, seeds, own); cache = own; startMode = 'cache' } catch { await clearState(this.walletId).catch(() => {}) } }
          } else await clearState(this.walletId).catch(() => {})
        }
      }
      if (!facade) {
        const grafted = await this.bootstrapCache(net, keystore, seeds, opts).catch((e) => { console.warn('bootstrap', e?.message ?? e); return null })
        if (grafted) {
          try { facade = await this.build(net, keystore, seeds, grafted); cache = grafted; startMode = 'bootstrap' }
          catch (e: any) { console.warn('bootstrap snapshot not usable', String(e?.message ?? e).slice(0, 160)) }
        }
      }
      if (!facade) { cache = null; facade = await this.build(net, keystore, seeds, null) }
      if (dustGrafted) console.info('DUST state grafted from the newest snapshot (coin-less wallet): no DUST replay')
      const big0 = (v: unknown) => { try { return BigInt(String(v ?? '0')) } catch { return 0n } }
      this.emit({
        startMode, resumedFrom: cache?.saved ?? null, dustGrafted, handoff: { ...this.snap.handoff, receivedAt: startMode === 'handoff' ? Date.now() : null },
        dustSearch: searching ? { startedAt: searching.at, from: big0(searching.from), all: !!searching.all } : null,
      })

      this.facade = facade
      await facade.start(seeds)
      this.emit({ phase: 'syncing' })
      // a bootstrapped start is only valid once (the newest snapshot moves on); persist it right away. Another
      // device's state is persisted right away too: it is this device's own from here on.
      if (startMode === 'bootstrap' || startMode === 'handoff' || dustGrafted) void this.save()
      this.watch(facade)
      // state() only emits on change: re-evaluate every second so DUST accrual, the stable-sync timer and
      // the first-transaction countdown keep moving
      this.timers.push(setInterval(() => { if (this.dirty) this.evaluate() }, 250))
      this.timers.push(setInterval(() => this.evaluate(), 1_000))
      this.timers.push(setInterval(() => void this.save(), SAVE_EVERY_MS))
      this.timers.push(setInterval(() => void this.handoffTick(), HAND_EVERY_MS))
      this.timers.push(setInterval(() => void this.checkFeeEnergy(), 13_000))
      document.addEventListener('visibilitychange', this.onHide)
    } catch (e: any) {
      this.emit({ phase: 'error', error: String(e?.message ?? e) })
      throw e
    }
  }

  private watch(facade: WalletFacade) {
    this.stateSub = facade.state().subscribe({
      // the SDK emits a state per applied batch (hundreds a second while syncing): keep the newest, map it on a timer
      next: (s: any) => { this.lastState = s; this.dirty = true },
      error: (e: any) => this.emit({ phase: 'error', error: String(e?.message ?? e) }),
    })
  }

  // ---- device hand-off (src/core/handoff.ts) ----

  /**
   * The server's copy of this wallet's state when it is usable here (same indexer) and worth taking over `mine`
   * (null = this device has nothing yet); otherwise null. Remembers the copy's tag and how far it is.
   */
  private async betterHandoff(mine: Offsets | null, ms: number): Promise<Cache | null> {
    if (!this.hand) return null
    const got = await fetchHandoff(this.hand, this.handTag, ms)
    if (!got || got === 'same') return null
    this.handTag = got.tag
    this.handTheirs = got.doc.indexer === this.indexer ? offsetsOf(got.doc.cache) : null
    if (!this.handTheirs) return null
    if (!ahead(this.handTheirs, mine ?? { shielded: 0n, dust: 0n }, HAND_WORTH)) return null
    return { ...got.doc.cache, indexer: this.indexer }
  }

  /** The three sub-wallet states and the history, as they stand now. */
  private async snapshotCache(f: WalletFacade): Promise<Cache> {
    const value: Cache = {
      saved: new Date().toISOString(),
      indexer: this.indexer,
      shielded: await f.shielded.serializeState(),
      unshielded: await f.unshielded.serializeState(),
      dust: await f.dust.serializeState(),
    }
    try { const h = await this.history?.serialize(); if (h) value.history = h as unknown as string } catch {}
    // what the DUST side holds now: decides whether the next start may skip the DUST replay (see start())
    const s = this.lastState
    const coins = Array.isArray(s?.dust?.totalCoins) ? s.dust.totalCoins.length : -1
    if (coins >= 0) value.meta = { dustCoins: coins, night: String(this.snap.balances.unshielded.get(NIGHT_TYPE) ?? 0n) }
    return value
  }

  /**
   * Every 47 s: while this device is still syncing, see whether another device has got further and continue from
   * there; and when sharing is on, store this device's state for the others (never over a copy that is further).
   */
  private async handoffTick(force = false) {
    const f = this.facade
    if (!f || !this.hand || this.handBusy || this.swapping || this.snap.phase === 'starting' || this.snap.phase === 'error') return
    // a search for the fee energy is under way: this device's state is the one being repaired, nothing replaces or copies it
    if (this.snap.dustSearch) return
    this.handBusy = true
    try {
      const syncing = this.snap.phase === 'syncing', ready = this.snap.phase === 'ready'
      const sum = (this.snap.shielded?.applied ?? 0n) + (this.snap.dust?.applied ?? 0n)
      const last = this.shared
      const due = sharingOn() && (force || !last || (ready && !last.ready) || (ready ? Date.now() - last.at >= SHARE_READY_MS : Date.now() - last.at >= SHARE_SYNCING_MS && sum - last.sum >= SHARE_SYNCING_STEP))
      // nothing to look for (at the tip) and nothing to share yet: the server is left alone
      if (!syncing && !due) return
      const before = this.handTag
      const got = await fetchHandoff(this.hand, this.handTag)
      if (got && got !== 'same') { this.handTag = got.tag; this.handTheirs = got.doc.indexer === this.indexer ? offsetsOf(got.doc.cache) : null }
      // 1) a new copy while this device is still syncing, with nothing of its own on the way: is it further?
      if (got && got !== 'same' && this.handTag !== before && this.handTheirs && syncing && !this.hasAwaiting()) {
        const own = await this.snapshotCache(f)
        if (ahead(this.handTheirs, offsetsOf(own) ?? { shielded: 0n, dust: 0n }, HAND_WORTH)) { await this.adopt(own, { ...got.doc.cache, indexer: this.indexer }); return }
      }
      // 2) share this device's state
      if (!due) return
      const own = await this.snapshotCache(f)
      const mine = offsetsOf(own)
      if (!mine) return
      // the server's copy is further than this device (the other one is ahead): leave it
      if (this.handTheirs && ahead(this.handTheirs, mine, 1n)) { this.shared = { at: Date.now(), sum, ready }; return }
      try {
        const put = await putHandoff(this.hand, this.indexer, own)
        this.handTag = put.tag; this.handTheirs = mine
        this.shared = { at: Date.now(), sum, ready }
        this.emit({ handoff: { ...this.snap.handoff, sharedAt: Date.now(), shareError: null } })
      } catch (e: any) {
        this.emit({ handoff: { ...this.snap.handoff, shareError: String(e?.message ?? e).slice(0, 80) } })
      }
    } catch (e: any) {
      console.warn('hand-off', e?.message ?? e)
    } finally {
      this.handBusy = false
    }
  }

  /** Settings: share now (the switch was just turned on, or "Send now"). */
  async shareNow() { await this.handoffTick(true) }

  /**
   * Continue from another device's state in the running session: the facade is rebuilt from `theirs`. If the SDK
   * refuses it, the wallet goes on from `own`, its state of a moment ago; nothing is lost either way.
   */
  private async adopt(own: Cache, theirs: Cache) {
    const seeds = this.seeds, keystore = this.keystore, old = this.facade
    if (!seeds || !keystore || !old) return
    const net = loadEndpoints()
    this.swapping = true
    try {
      try { this.stateSub?.unsubscribe() } catch {}
      this.stateSub = null
      this.facade = null
      await old.stop().catch(() => {})
      let next: WalletFacade, took = true
      try { next = await this.build(net, keystore, seeds, theirs) }
      catch (e: any) {
        console.info(`hand-off not usable (${String(e?.message ?? e).slice(0, 160)}): carrying on`)
        took = false
        next = await this.build(net, keystore, seeds, own)
      }
      // locked or removed while this was under way: stop() found no facade, so this one is not started
      if (this.seeds !== seeds) { await next.stop().catch(() => {}); return }
      this.facade = next
      this.lastState = null; this.dirty = false; this.syncedSince = 0; this.tradeSyncedSince = 0
      await next.start(seeds)
      this.watch(next)
      if (took) {
        console.info(`hand-off: continuing from another device's state (saved ${theirs.saved})`)
        this.emit({ phase: 'syncing', startMode: 'handoff', resumedFrom: theirs.saved, dustGrafted: false, readyForTxAt: null, tradeReady: false, handoff: { ...this.snap.handoff, receivedAt: Date.now() } })
      } else this.emit({ phase: 'syncing', readyForTxAt: null, tradeReady: false })
    } catch (e: any) {
      this.emit({ phase: 'error', error: String(e?.message ?? e) })
    } finally {
      this.swapping = false
    }
    void this.save()
  }

  private configuration(net: ReturnType<typeof loadEndpoints>, history: History) {
    return {
      networkId: net.networkId,
      forks: DefaultForkSchedule,
      costParameters: { feeBlocksMargin: 5 },
      relayURL: new URL(net.nodeWs),
      provingServerUrl: new URL(net.prover),
      indexerClientConnection: { indexerHttpUrl: net.indexerUrl, indexerWsUrl: net.indexerWsUrl },
      txHistoryStorage: history,
      // How many chain events a sub-wallet applies per step, and the pause between steps. The SDK's defaults (10
      // events, 4 ms) hold a long sync to ~140 events a second on this machine; 64 events a step measured ~240-300
      // (test/l9-dust-fast.mjs scratch), and a step still ends within a fraction of a second so the screen stays alive.
      batchUpdates: SYNC_BATCH,
    }
  }

  /**
   * The facade over the three sub-wallets: restored from `cache`, or started from nothing. A DUST sub-wallet that
   * starts from nothing starts at the ledger-9 fork: the chain issued all DUST again there, so the ledger-8 DUST
   * history (three quarters of all DUST events) holds nothing a wallet still needs. Throws when the SDK refuses a
   * cached state; nothing is left running then.
   */
  private async build(net: ReturnType<typeof loadEndpoints>, keystore: ReturnType<typeof createKeystore>, seeds: WalletSeeds, cache: Cache | null): Promise<WalletFacade> {
    let history = newHistory()
    if (cache?.history) { try { history = InMemoryTransactionHistoryStorage.restore(cache.history as never, WalletEntrySchema, mergeWalletEntries) } catch { /* balances do not depend on it */ } }
    const started: Array<{ stop(): Promise<void> }> = []
    const keep = <T extends { stop(): Promise<void> }>(w: T): T => { started.push(w); return w }
    try {
      const facade = await WalletFacade.init({
        configuration: this.configuration(net, history),
        // our own way to the prover: the SDK's client would drop the path of the prover address (src/core/prover.ts)
        provingService: () => provingService() as never,
        shielded: async (cfg) => keep(cache ? ShieldedWallet(cfg).restore(cache.shielded) : await ShieldedWallet(cfg).startWithSeed(seeds.shielded)),
        unshielded: async (cfg) => keep(cache ? UnshieldedWallet(cfg).restore(cache.unshielded) : await UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore))),
        dust: async (cfg) => keep(cache ? DustWallet(cfg).restore(cache.dust) : await freshDust(cfg, seeds.dust)),
      })
      this.history = history
      return facade
    } catch (e) {
      await Promise.all(started.map((w) => w.stop().catch(() => {})))
      throw e
    }
  }

  /**
   * May this wallet's DUST side jump to the newest snapshot instead of replaying? Only when nothing in between can be
   * its own: no NIGHT here (the caller checked), and its Cardano address not registered: asked of our Cardano
   * service now, on Cardano and on Midnight. Any doubt (no answer, no Cardano address) means: replay.
   */
  private async dustMayJump(): Promise<boolean> {
    if (mustReplayDust(this.walletId) || !this.cardano) return false
    try {
      const st = await energyState(this.cardano.address, '', 6_000)
      if (st.mapped !== 'none' || st.midnight?.registered) { noteReplayDust(this.walletId); return false }
      return st.midnight !== null
    } catch { return false }
  }

  /**
   * A wallet that reached the tip holding no fee energy asks, now and then, whether Midnight makes some for it (its
   * Cardano address registered to this wallet, and generating). If so, the wallet skipped it: an earlier build
   * jumped over it, or the wallet was brought along with a date after its registration. It then reads the fee energy
   * history again from before the registration, by itself, once per registration.
   */
  private async checkFeeEnergy() {
    const coins = () => (Array.isArray(this.lastState?.dust?.totalCoins) ? this.lastState.dust.totalCoins.length : -1)
    const idle = () => !!this.facade && !this.swapping && this.snap.phase === 'ready' && !this.snap.dustSearch && coins() === 0
    if (this.checking || !idle() || !this.cardano || !this.snap.dustAddress) return
    // soon after the wallet is up to date, then every ten minutes
    if (Date.now() - this.checkedAt < 600_000) return
    this.checking = true
    try {
      this.checkedAt = Date.now()
      const facade = this.facade
      let st
      try { st = await energyState(this.cardano.address, this.snap.dustAddress, 12_000) }
      catch { this.checkedAt = Date.now() - 540_000; return }   // no answer: again in a minute
      if (st.mapped !== 'none') noteReplayDust(this.walletId)
      const made = st.mapped === 'here' && !!st.midnight?.registered && st.midnight.capSpeck > 0n
      if (!made) { if (this.snap.dustMissing) this.emit({ dustMissing: false }); return }
      const note = readDustSearch(this.walletId)
      // searched for this very registration already: say so instead of searching in circles (Settings can ask again)
      if (note?.done && (note.tx ?? null) === (st.registeredTx ?? null)) { if (!this.snap.dustMissing) this.emit({ dustMissing: true }); return }
      // the fee energy may be arriving this moment: look once more before starting over
      await new Promise((r) => setTimeout(r, 17_000))
      if (this.facade !== facade || !idle()) return
      console.info('fee energy: Midnight makes some for this wallet and the wallet holds none: reading its history again')
      await this.findFeeEnergy(st.registeredAt, 'auto', st.registeredTx)
    } catch (e: any) {
      console.warn('fee energy check', e?.message ?? e)
    } finally {
      this.checking = false
    }
  }

  /**
   * Reads this wallet's fee energy (DUST) history again in the running session. The DUST side starts over from the
   * public state of a day before `since` (ms epoch: when the Cardano address was registered), or from the ledger-9
   * fork when `since` is null or no state that old is kept; the private and public sides stay as they are. Nothing
   * is lost if it cannot be done: the wallet then goes on as it was. Returns whether the search began.
   */
  async findFeeEnergy(since: number | null, why: 'auto' | 'asked', tx: string | null = null): Promise<boolean> {
    const seeds = this.seeds, keystore = this.keystore, old = this.facade
    if (!seeds || !keystore || !old || this.swapping || this.snap.phase === 'starting' || this.hasAwaiting()) return false
    const net = loadEndpoints()
    this.swapping = true
    try {
      // 1) everything the new DUST side needs, while the wallet still runs as it is
      let own: Cache, dust: string
      try {
        own = await this.snapshotCache(old)
        const from = since ? await dustStateBefore(since, this.indexer).catch(() => null) : null
        // this wallet's own DUST identity, at the fork: where a DUST side begins when it begins from nothing
        const blank = await freshDust(this.configuration(net, newHistory()), seeds.dust)
        try { const empty = await blank.serializeState(); dust = from ? graftDustState(from.dust, empty) : empty } finally { await blank.stop().catch(() => {}) }
        console.info(`fee energy search (${why}): from ${from ? `the public state of ${from.day}` : 'the ledger-9 fork'}`)
      } catch (e: any) {
        console.warn('fee energy search could not be prepared', String(e?.message ?? e).slice(0, 160))
        return false
      }
      if (this.seeds !== seeds || this.facade !== old) return false
      let fromOffset = 0n
      try { fromOffset = BigInt(String(JSON.parse(dust).offset ?? 0)) } catch {}
      noteReplayDust(this.walletId)
      writeDustSearch({ at: Date.now(), why, tx, from: String(fromOffset) }, this.walletId)
      // 2) the swap
      try { this.stateSub?.unsubscribe() } catch {}
      this.stateSub = null
      this.facade = null
      await old.stop().catch(() => {})
      let next: WalletFacade, took = true
      try { next = await this.build(net, keystore, seeds, { ...own, dust, meta: undefined }) }
      catch (e: any) {
        console.info(`fee energy search: the fresh DUST state was refused (${String(e?.message ?? e).slice(0, 160)}): carrying on as before`)
        took = false
        next = await this.build(net, keystore, seeds, own)
      }
      // locked or removed while this was under way: stop() found no facade, so this one is not started
      if (this.seeds !== seeds) { await next.stop().catch(() => {}); return false }
      this.facade = next
      this.lastState = null; this.dirty = false; this.syncedSince = 0; this.tradeSyncedSince = 0
      await next.start(seeds)
      this.watch(next)
      if (took) this.emit({ phase: 'syncing', readyForTxAt: null, tradeReady: false, dustGrafted: false, dustMissing: false, dust: null, dustSearch: { startedAt: Date.now(), from: fromOffset, all: false } })
      else { writeDustSearch(null, this.walletId); this.emit({ phase: 'syncing', readyForTxAt: null, tradeReady: false }) }
      return took
    } catch (e: any) {
      this.emit({ phase: 'error', error: String(e?.message ?? e) })
      return false
    } finally {
      this.swapping = false
      void this.save()
    }
  }

  /**
   * Build a cache-shaped triple from a server snapshot: throwaway sub-wallets yield this wallet's own empty
   * serialized states (identity + shapes), the snapshot supplies the public sync state.
   *
   * A wallet brought along may have its Cardano address registered since before the snapshot: its fee energy began
   * then, and a DUST side grafted onto the snapshot would never see it. Such a wallet's DUST side starts from a
   * public state older than the registration, or from the ledger-9 fork. When our Cardano service does not answer,
   * the snapshot is used and checkFeeEnergy finds out later.
   */
  private async bootstrapCache(net: ReturnType<typeof loadEndpoints>, keystore: ReturnType<typeof createKeystore>, seeds: WalletSeeds, opts: StartOptions): Promise<Cache | null> {
    let day: 'latest' | string | null = null
    if (opts.fresh) day = 'latest'
    else {
      const birthday = loadBirthday(this.walletId)
      if (birthday) day = pickDay(await fetchBootstrapDays(), birthday)
    }
    if (!day) return null
    const boot = await fetchBootstrap(day, this.indexer)
    if (!boot) return null
    // null: the snapshot's own DUST state is right. 'fork': start the DUST side from nothing. Else: an older state.
    let dustFrom: Bootstrap['dust'] | 'fork' | null = null
    if (!opts.fresh && this.cardano) {
      const st = await energyState(this.cardano.address, '', 8_000).catch(() => null)
      if (st && (st.mapped !== 'none' || st.midnight?.registered)) {
        noteReplayDust(this.walletId)
        const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
        if (!(st.registeredAt && boot.savedAt.slice(0, 10) < dayOf(st.registeredAt))) {
          const older = st.registeredAt ? await dustStateBefore(st.registeredAt, this.indexer).catch(() => null) : null
          dustFrom = older ? older.dust : 'fork'
          console.info(`bootstrap: the Cardano address is registered since before this snapshot: fee energy is read from ${older ? `the public state of ${older.day}` : 'the ledger-9 fork'}`)
        }
      }
    }
    const cfg = this.configuration(net, newHistory())
    const parts = await Promise.all([
      ShieldedWallet(cfg).startWithSeed(seeds.shielded),
      freshDust(cfg, seeds.dust),
      UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    ])
    try {
      const [emptyShielded, emptyDust, unshielded] = await Promise.all(parts.map((w) => w.serializeState()))
      const g = graft(boot, emptyShielded, emptyDust)
      const dust = dustFrom === 'fork' ? emptyDust : dustFrom ? graftDustState(dustFrom, emptyDust) : g.dust
      return { shielded: g.shielded, dust, unshielded, saved: boot.savedAt }
    } finally {
      await Promise.all(parts.map((w) => w.stop().catch(() => {})))
    }
  }

  // FacadeState: shielded/unshielded expose `balances` (Record<tokenType, bigint>), `address`, `progress`;
  // dust exposes `balance(time)`, `availableCoins` (maxCap, maxCapReachedAt per source), `address`.
  private evaluate() {
    const s = this.lastState
    if (!s) return
    this.dirty = false
    try {
      const now = new Date()
      const prog = (p: any): Progress | null => p ? { applied: BigInt(p.appliedIndex ?? 0), highest: BigInt(p.highestRelevantWalletIndex ?? p.highestIndex ?? 0), connected: !!p.isConnected } : null
      const sh = prog(s.shielded?.progress), du = prog(s.dust?.progress)
      // the unshielded sub-wallet counts transactions, under its own names: { appliedId, highestTransactionId, isConnected }
      const unP: any = s.unshielded?.progress
      const un: Progress | null = unP ? { applied: BigInt(unP.appliedId ?? 0), highest: BigInt(unP.highestTransactionId ?? 0), connected: !!unP.isConnected } : null
      const done = (p: Progress | null) => !!p && p.connected && p.highest > 0n && p.applied + 3n >= p.highest
      // all three sub-wallets must have crossed onto ledger 9 before anything can be built
      const settled = s.protocol?._tag === 'Settled' && BigInt(s.protocol.version ?? 0) >= FORK
      const syncedNow = done(sh) && done(du) && settled
      if (!syncedNow) this.syncedSince = 0
      else if (!this.syncedSince) this.syncedSince = Date.now()
      const ready = syncedNow && Date.now() - this.syncedSince >= STABLE_MS
      const readyForTxAt = this.snap.readyForTxAt ?? (ready ? Date.now() + LIVE_WAIT_MS : null)
      // fee-less dApp transactions (a sponsor pays the DUST) need only the shielded + unshielded sides at the tip:
      // the DUST replay and the post-sync live wait (both node-error-170 guards) do not apply to them
      // (a wallet that never transacted has highestTransactionId 0: connected + caught up is enough there)
      const tradeSyncedNow = done(sh) && (!un || (un.connected && un.applied + 3n >= un.highest)) && BigInt(s.shielded?.protocolVersion ?? 0) >= FORK && BigInt(s.unshielded?.protocolVersion ?? 0) >= FORK
      if (!tradeSyncedNow) this.tradeSyncedSince = 0
      else if (!this.tradeSyncedSince) this.tradeSyncedSince = Date.now()
      const tradeReady = tradeSyncedNow && Date.now() - this.tradeSyncedSince >= STABLE_MS

      let dust = 0n, dustCap = 0n, dustFullAt: number | null = null
      try { dust = BigInt(s.dust.balance(now)) } catch {}
      try {
        for (const info of s.dust.availableCoins as Array<{ maxCap: bigint; maxCapReachedAt: Date }>) {
          dustCap += BigInt(info.maxCap)
          const t = info.maxCapReachedAt?.getTime?.()
          if (t && (dustFullAt == null || t > dustFullAt)) dustFullAt = t
        }
      } catch {}

      // a search for the fee energy ends when the wallet is up to date again; its note stays, marked done
      let dustSearch = this.snap.dustSearch
      if (dustSearch && ready) {
        const note = readDustSearch(this.walletId)
        if (note) writeDustSearch({ ...note, done: Date.now() }, this.walletId)
        const coins = Array.isArray(s.dust?.totalCoins) ? s.dust.totalCoins.length : -1
        console.info(`fee energy search done after ${Math.round((Date.now() - dustSearch.startedAt) / 1000)} s: ${coins} DUST coin(s)`)
        dustSearch = null
        this.checkedAt = 0   // look right away whether it is all there now
        void this.save()
      }
      this.emit({
        phase: ready ? 'ready' : 'syncing',
        dustSearch,
        readyForTxAt,
        tradeReady,
        shielded: sh, dust: du,
        unshieldedAddress: encodeAddress(s.unshielded?.address) || this.snap.unshieldedAddress,
        shieldedAddress: encodeAddress(s.shielded?.address) || this.snap.shieldedAddress,
        dustAddress: encodeAddress(s.dust?.address) || this.snap.dustAddress,
        balances: { unshielded: toMap(s.unshielded?.balances), shielded: toMap(s.shielded?.balances), dust, dustCap, dustFullAt },
      })
    } catch (e: any) {
      console.warn('state mapping', e?.message ?? e)
    }
  }

  /** Persist the three sub-wallet states and the transaction history (encrypted). Cheap to call often; skips while a save is in flight. */
  async save() {
    const f = this.facade
    if (!f || !this.stateKey || this.saving || this.swapping || this.snap.phase === 'starting') return
    this.saving = true
    try {
      await saveState(this.stateKey, await this.snapshotCache(f), this.walletId)
    } catch (e: any) {
      console.warn('state save', e?.message ?? e)
    } finally {
      this.saving = false
    }
  }

  /** Raw state object from the SDK (for debugging field names during development). */
  debugState(): any { return this.lastState }

  /** The wallet's own transactions on both lanes, as the SDK recorded them while syncing (newest last). */
  async txHistory(): Promise<WalletEntry[]> {
    try { return (await this.facade?.getAllFromTxHistory()) ?? [] } catch { return [] }
  }

  /**
   * Public, wallet-independent sync state in the bootstrap snapshot format (see server/state-bot.mjs).
   * Refuses when this wallet has ever held coins: a snapshot must be coin-free to be graftable.
   */
  async exportBootstrap() {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    const sh = JSON.parse(await f.shielded.serializeState()), du = JSON.parse(await f.dust.serializeState())
    const dustCoins = Array.isArray(this.lastState?.dust?.totalCoins) ? this.lastState.dust.totalCoins.length : 0
    if (Object.keys(sh.coinHashes ?? {}).length || dustCoins || (du.pendingDust ?? []).length || this.snap.balances.unshielded.size || this.snap.balances.shielded.size) throw new Error('wallet has coins; not exportable')
    if (BigInt(du.protocolVersion ?? 0) < FORK || BigInt(sh.protocolVersion ?? 0) < FORK) throw new Error('not past the ledger-9 fork yet; not exportable')
    const strip = (o: any, drop: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)))
    return {
      v: 2 as const, savedAt: new Date().toISOString(), indexer: this.indexer,
      shielded: strip(sh, ['publicKeys', 'coinHashes']),
      dust: strip(du, ['publicKey', 'pendingDust']),
    }
  }

  private transfer(tokenType: string, amount: bigint, to: ParsedAddress) {
    return to.lane === 'private'
      ? { type: 'shielded' as const, outputs: [{ type: tokenType, receiverAddress: to.address as never, amount }] }
      : { type: 'unshielded' as const, outputs: [{ type: tokenType, receiverAddress: to.address as never, amount }] }
  }

  private sign = (payload: Uint8Array) => {
    const ks = this.keystore
    if (!ks) throw new Error('wallet not running')
    return ks.signDataAsync(payload)
  }

  /**
   * Fee in DUST units for a transfer: build the (fee-paying) recipe and read its cost with
   * calculateTransactionFee. NOT estimateTransactionFee: that re-balances a recipe that already carries its
   * DUST payment. Building a recipe reserves coins, so the recipe is reverted right after.
   */
  async estimateFee(tokenType: string, amount: bigint, to: ParsedAddress): Promise<bigint> {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    const ttl = new Date(Date.now() + 30 * 60_000)
    const recipe = await f.transferTransaction([this.transfer(tokenType, amount, to)], { ttl, payFees: true })
    try {
      return BigInt(await f.calculateTransactionFee(recipe.transaction))
    } finally {
      await f.revert(recipe).catch(() => {})
    }
  }

  /**
   * Would the node take this transaction? The chain refuses one whose checking would take longer than its size allows
   * (node error 231, OutsideTimeToDismiss): a token held as many small coins runs into it, each coin spent being a
   * signature to check for almost no bytes. The rule is in the ledger library, so it is asked here instead of at the
   * node. `proven`: the finished transaction (the answer the node will give; verified against it 2026-11-21). Not
   * proven: the recipe before proving, with stand-in proofs: an estimate, which can be too kind.
   * A transaction that cannot be read here is let through: the node has the last word either way.
   */
  private fits(tx: { serialize(): Uint8Array }, proven: boolean): boolean {
    let lt: { cost(p: unknown, enforce: boolean): unknown; intents?: Map<number, unknown> }
    try {
      const bytes = tx.serialize()
      lt = (proven ? ledger.Transaction.deserialize('signature', 'proof', 'binding', bytes) : ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytes).mockProve()) as never
    } catch (e) { console.warn('send: the size rule could not be asked', (e as Error)?.message ?? e); return true }
    // test builds only: pretend the chain takes at most this many public coins in one transaction
    const pretend = TEST_BUILD ? (window as unknown as { __lumpSendTest?: { maxInputs?: number } }).__lumpSendTest?.maxInputs : undefined
    if (pretend !== undefined) {
      let n = 0
      for (const it of (lt.intents?.values() ?? []) as Iterable<{ guaranteedUnshieldedOffer?: { inputs: unknown[] }; fallibleUnshieldedOffer?: { inputs: unknown[] } }>) n += (it.guaranteedUnshieldedOffer?.inputs.length ?? 0) + (it.fallibleUnshieldedOffer?.inputs.length ?? 0)
      return n <= pretend
    }
    try { lt.cost(ledger.LedgerParameters.initialParameters(), true); return true } catch { return false }
  }

  /** Before proving: would a transfer of this amount be taken? The recipe is built, asked about and given back. */
  private async probe(tokenType: string, amount: bigint, to: ParsedAddress): Promise<boolean> {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    let recipe
    try { recipe = await f.transferTransaction([this.transfer(tokenType, amount, to)], { ttl: new Date(Date.now() + 30 * 60_000), payFees: true }) }
    catch { return false }   // not enough coins or fee energy for this amount: not a size that fits
    try { return this.fits(recipe.transaction as never, false) } finally { await f.revert(recipe).catch(() => {}) }
  }

  /**
   * What Review shows: the fee of one transfer and how many transfers the amount will take. 1 for nearly every send;
   * more when the token is held as many small coins ("about": later parts spend the smaller coins). 0: it cannot
   * be sent from here at all.
   */
  async planSend(tokenType: string, amount: bigint, to: ParsedAddress): Promise<{ fee: bigint; parts: number }> {
    if (await this.probe(tokenType, amount, to)) return { fee: await this.estimateFee(tokenType, amount, to), parts: 1 }
    // not taken whole: either it does not fit, or it cannot be built at all (then the fee estimate says why)
    const { parts, first } = await partsEstimate((a) => this.probe(tokenType, a, to), amount)
    if (parts === 0) return { fee: await this.estimateFee(tokenType, amount, to), parts: 0 }
    return { fee: await this.estimateFee(tokenType, first, to), parts }
  }

  /**
   * Build → sign (unshielded inputs) → prove + balance (prover) → submit. Fees are paid in DUST.
   * One transfer when the amount fits the chain's size rule, else several, one after the other (core/split.ts);
   * `onPart(sent, left)` after each. Resolves with the ids. On failure the reserved coins are released; when part
   * of the amount already went out the error is a PartialSend that says how much.
   */
  async send(tokenType: string, amount: bigint, to: ParsedAddress, onPhase: (p: SendPhase) => void, onPart?: (sent: number, left: bigint) => void): Promise<string[]> {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    // test builds only: everything but the submit (a dry run of the whole flow with real coins and proofs)
    const dry = TEST_BUILD && (window as unknown as { __lumpSendTest?: { dry?: boolean } }).__lumpSendTest?.dry === true
    const sendPart = async (part: bigint): Promise<{ id: string } | { refused: true }> => {
      onPhase('building')
      const recipe = await f.transferTransaction([this.transfer(tokenType, part, to)], { ttl: new Date(Date.now() + 30 * 60_000), payFees: true })
      try {
        const signed = await f.signRecipe(recipe, this.sign)
        onPhase('proving')
        const tx = await f.finalizeRecipe(signed)
        // the finished transaction, asked the node's own question: one it would refuse is never sent
        if (!this.fits(tx as never, true)) { await f.revert(recipe).catch(() => {}); return { refused: true } }
        onPhase('submitting')
        if (dry) { await f.revert(recipe).catch(() => {}); return { id: `dry-run-${part}` } }
        const id: string = await f.submitTransaction(tx)
        void this.save()
        return { id }
      } catch (e) {
        await f.revert(recipe).catch(() => {})
        throw e
      }
    }
    const ids = await sendInParts({
      amount,
      probe: (a) => this.probe(tokenType, a, to),
      sendPart,
      // the next part needs the last one confirmed: its change, and the fee energy coin it spent
      between: () => (dry ? Promise.resolve() : this.whenCanTransact({ needDust: true, maxPendingMs: 127_000, maxWaitMs: 241_000 })),
      onPart,
    })
    onPhase('done')
    return ids
  }

  // ---- dApp connector (src/dapp/host.ts). Everything below runs only after the user approved it there. ----

  /**
   * Safe to balance a new transaction: synced and stable, past the post-sync live wait (node error 170), and no
   * own transaction still unconfirmed (balancing on a DUST state that has not applied it is also a 170).
   */
  canTransact(needDust = true): boolean {
    const s = this.snap
    if (s.phase === 'error') return false
    // no DUST of ours involved (a sponsor pays): shielded + unshielded at the tip is all that matters
    if (!needDust) return s.tradeReady
    if (s.phase !== 'ready' || !s.readyForTxAt || Date.now() < s.readyForTxAt) return false
    const lifecycle = this.lastState?.lifecycle
    return !(Array.isArray(lifecycle) && lifecycle.some((e: any) => e?.status?._tag === 'Submitted'))
  }

  /**
   * Resolves once canTransact() holds; after maxPendingMs an unconfirmed own transaction no longer blocks.
   * needDust=false (dApp asked payFees:false): skips the DUST replay wait and the 60 s live wait, which guard
   * only our own DUST spends.
   */
  async whenCanTransact({ needDust = true, maxPendingMs = 97_000, maxWaitMs = 181_000 } = {}): Promise<void> {
    const t0 = Date.now()
    for (;;) {
      if (this.canTransact(needDust)) return
      const s = this.snap
      if (s.phase === 'error') throw new Error(s.error ?? 'wallet error')
      if (needDust && s.phase === 'ready' && s.readyForTxAt && Date.now() >= s.readyForTxAt && Date.now() - t0 > maxPendingMs) return
      // never hang a dApp forever: a wallet that is still syncing (or never reaches ready) says so instead
      if (Date.now() - t0 > maxWaitMs) {
        throw new Error(!needDust || s.phase !== 'ready' ? 'wallet is still syncing — wait for Ready, then retry' : 'wallet is not ready to transact yet — retry in a minute')
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  /** true while one of this wallet's own transactions is still on its way (balanced, proven or submitted) */
  hasAwaiting(): boolean {
    const lifecycle = this.lastState?.lifecycle
    return Array.isArray(lifecycle) && lifecycle.some((e: any) => isAwaiting(e))
  }

  /**
   * Coin + encryption public keys of the shielded address (connector getShieldedAddresses), as 64-hex. The
   * connector docs say Bech32m, but dApps in the wild decode only hex here (midnight-js accepts both), so hex it is.
   */
  shieldedKeys(): { coin: string; enc: string } {
    const a = this.lastState?.shielded?.address
    if (!a) throw new Error('wallet not running')
    return { coin: a.coinPublicKeyString(), enc: a.encryptionPublicKeyString() }
  }

  /**
   * Balance a dApp's transaction: add the user's inputs/outputs (and the DUST fee when payFees), sign, prove the
   * balancing part through the prover and return the sealed transaction. Reserved coins are released on failure.
   *   sealed=false: a proven, not yet bound transaction (balanceUnsealedTransaction)
   *   sealed=true:  a finalized transaction                (balanceSealedTransaction)
   */
  async dappBalance(bytes: Uint8Array, sealed: boolean, payFees: boolean): Promise<Uint8Array> {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    const opts = { ttl: new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: (payFees ? 'all' : ['shielded', 'unshielded']) as 'all' | Array<'shielded' | 'unshielded'> }
    const recipe = sealed
      ? await f.balanceFinalizedTransaction(f.adoptTransaction(bytes, 'Finalized'), opts)
      : await f.balanceUnboundTransaction(f.adoptTransaction(bytes, 'Unbound'), opts)
    try {
      const signed = await f.signRecipe(recipe, this.sign)
      const tx = await f.finalizeRecipe(signed)
      // a site's transaction cannot be sent in parts: say what would make it fit instead of letting the node refuse it
      if (!this.fits(tx as never, true)) throw new Error('this wallet would have to spend too many small coins at once for this transaction. Send the token to your own address first (the wallet combines the coins), then try again')
      return tx.serialize()
    } catch (e) {
      await f.revert(recipe).catch(() => {})
      throw e
    }
  }

  /**
   * A dApp's makeIntent(): ONE intent in segment `intentId` ('random' = 2..65535) whose guaranteed offer spends our
   * UTxOs for `inputs` (change back to us) and pays `outputs`; signed, NOT bound (the site merges it into its own
   * transaction). payFees=false: no circuits at all, so nothing goes to the prover; payFees=true or a shielded
   * input: the spends are proved through `prover`. The SDK reserves the spent coins; released on failure, and
   * again after the intent's own ttl if nothing landed (the site may never use it).
   */
  async dappMakeIntent(
    inputs: Array<{ lane: 'public' | 'private'; type: string; value: bigint }>,
    outputs: Array<{ lane: 'public' | 'private'; type: string; value: bigint; address: unknown }>,
    intentId: number | 'random',
    payFees: boolean,
    prover: { check(pre: Uint8Array, k: string): Promise<(bigint | undefined)[]>; prove(pre: Uint8Array, k: string, overwrite?: bigint): Promise<Uint8Array> } | null,
  ): Promise<Uint8Array> {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    const desired: { shielded?: Record<string, bigint>; unshielded?: Record<string, bigint> } = {}
    for (const i of inputs) {
      const k = i.lane === 'public' ? 'unshielded' : 'shielded'
      desired[k] ??= {}
      desired[k]![i.type] = (desired[k]![i.type] ?? 0n) + i.value
    }
    const pub = outputs.filter((o) => o.lane === 'public'), priv = outputs.filter((o) => o.lane === 'private')
    const transfers = [
      ...(pub.length ? [{ type: 'unshielded' as const, outputs: pub.map((o) => ({ type: o.type, receiverAddress: o.address as never, amount: o.value })) }] : []),
      ...(priv.length ? [{ type: 'shielded' as const, outputs: priv.map((o) => ({ type: o.type, receiverAddress: o.address as never, amount: o.value })) }] : []),
    ]
    const TTL_MS = 25 * 60_000
    const recipe = await f.initSwap(desired, transfers, { ttl: new Date(Date.now() + TTL_MS), payFees })
    try {
      const unproven = (b: Uint8Array) => ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', b)
      const tx: any = unproven(recipe.transaction.serialize())
      const segs: number[] = [...(tx.intents?.keys() ?? [])]
      // a shielded-only swap may come back as an offer with no intent at all (nothing to sign, nothing to re-segment)
      if (segs.length > 1) throw new Error(`unexpected intent layout (${segs.length} intents)`)
      // the signature covers the segment id: move the intent where the site wants it BEFORE signing
      const want = intentId === 'random' ? 2 + Math.floor(Math.random() * 65_000) : intentId
      if (segs.length === 1 && want !== segs[0]) { const it = tx.intents.get(segs[0]); tx.intents = new Map([[want, it]]) }
      // an offer with no intent (shielded-only swap) has nothing to sign: its spend proofs are the authorization
      const handle = f.adoptTransaction(tx.serialize(), 'Unproven')
      const signed: any = unproven((segs.length ? await f.signUnprovenTransaction(handle, this.sign) : handle).serialize())
      const noProver = { check: async () => { throw new Error('a bare intent has nothing to prove') }, prove: async () => { throw new Error('a bare intent has nothing to prove') } }
      const proven: any = await signed.prove(prover ?? noProver, ledger.CostModel.initialCostModel())
      const bytes: Uint8Array = proven.serialize()
      // the site may never submit it: give the coins back once the intent itself has expired
      setTimeout(() => { void f.revert(recipe).catch(() => {}) }, TTL_MS + 60_000)
      return bytes
    } catch (e) {
      await f.revert(recipe).catch(() => {})
      throw e
    }
  }

  /** Network fee (DUST units) of a dApp's transaction as it stands, without the wallet's own balancing part. */
  async feeOf(bytes: Uint8Array, sealed: boolean): Promise<bigint> {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    return BigInt(await f.calculateTransactionFee(f.adoptTransaction(bytes, sealed ? 'Finalized' : 'Unbound')))
  }

  /** A sealed transfer for a dApp (connector makeTransfer): built, signed and proven, not submitted. */
  async dappTransfer(outputs: Array<{ lane: 'public' | 'private'; type: string; value: bigint; address: unknown }>, payFees: boolean): Promise<Uint8Array> {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    const pub = outputs.filter((o) => o.lane === 'public'), priv = outputs.filter((o) => o.lane === 'private')
    const transfers = [
      ...(pub.length ? [{ type: 'unshielded' as const, outputs: pub.map((o) => ({ type: o.type, receiverAddress: o.address as never, amount: o.value })) }] : []),
      ...(priv.length ? [{ type: 'shielded' as const, outputs: priv.map((o) => ({ type: o.type, receiverAddress: o.address as never, amount: o.value })) }] : []),
    ]
    const recipe = await f.transferTransaction(transfers, { ttl: new Date(Date.now() + 30 * 60_000), payFees })
    try {
      const signed = await f.signRecipe(recipe, this.sign)
      return (await f.finalizeRecipe(signed)).serialize()
    } catch (e) {
      await f.revert(recipe).catch(() => {})
      throw e
    }
  }

  /** Sign bytes for a dApp with the key behind the public address (BIP-340 Schnorr); both values as hex. */
  async dappSign(payload: Uint8Array): Promise<{ signature: string; verifyingKey: string }> {
    const ks = this.keystore
    if (!ks) throw new Error('wallet not running')
    const sig = await ks.signDataAsync(payload), key = ks.getPublicKey()
    if (sig.tag !== 'schnorr' || key.tag !== 'schnorr') throw new Error('unexpected signature kind')
    return { signature: sig.value, verifyingKey: key.value }
  }

  /**
   * Submit a sealed transaction (from a dApp) through our node; resolves with its id.
   * It ends with the node's answer, or as soon as this wallet's own sync has the transaction in a block, whichever
   * comes first (core/sendWait.ts: the node's answer can be lost for good). With neither in time it rejects with
   * NotConfirmedYet, and nothing the transaction booked is released: it may still land.
   */
  async submitSealed(bytes: Uint8Array): Promise<string> {
    const f = this.facade
    if (!f) throw new Error('wallet not running')
    const tx = f.adoptTransaction(bytes, 'Finalized')
    // what the sync has recorded for this transaction: the SDK's own lookup (it knows the hash a block gave it)
    const landed = async (): Promise<string | null> => {
      const look = (f as any).finalizedEntryFor
      if (typeof look !== 'function') return null
      const entry = look.call(f, tx, await f.getAllFromTxHistory())
      return entry ? String(entry.hash ?? 'landed') : null
    }
    try {
      const id: string = await sendSettled(f.submitTransaction(tx), landed)
      void this.save()
      return id
    } catch (e) {
      if (!(e instanceof NotConfirmedYet)) await f.revert(tx).catch(() => {})
      throw e
    }
  }

  /** A transaction this wallet balanced for a dApp that will not be submitted: release the coins it reserved. */
  async releaseSealed(bytes: Uint8Array): Promise<void> {
    const f = this.facade
    if (!f) return
    try { await f.revert(f.adoptTransaction(bytes, 'Finalized')) } catch {}
  }

  /** This wallet is leaving the device: nothing more of it is saved (stop() would otherwise write its sync cache once more, after it was deleted). */
  forget() { this.stateKey = null }

  async stop() {
    this.cardanoSigner = null
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    document.removeEventListener('visibilitychange', this.onHide)
    await this.save()
    try { this.stateSub?.unsubscribe() } catch {}
    this.stateSub = null
    try { await this.facade?.stop() } catch {}
    this.facade = null
    this.seeds?.shielded.fill(0); this.seeds?.dust.fill(0); this.seeds?.unshielded.fill(0)
    this.seeds = null
    this.keystore = null
    this.history = null
    this.stateKey = null
    this.lastState = null
    this.hand = null
  }
}

export const fmtUnits = (v: bigint, decimals: number, maxFrac = 4) => {
  const neg = v < 0n; const a = neg ? -v : v
  const whole = a / 10n ** BigInt(decimals), frac = a % 10n ** BigInt(decimals)
  const f = frac.toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${f ? '.' + f : ''}`
}
