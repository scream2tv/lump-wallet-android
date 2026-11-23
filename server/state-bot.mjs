// State bot: keeps a coin-less wallet (random throwaway keys, never funded) synced to the Midnight tip and
// publishes its serialized shielded + DUST states as BOOTSTRAP snapshots. Those states hold only public,
// wallet-independent data (Merkle tree frontiers, sync offsets); a new wallet grafts its own public keys onto
// one and syncs from the snapshot instead of replaying the chain from genesis (hours -> seconds on a phone).
//
//   out/bootstrap/latest.json       newest snapshot (rewritten every SNAPSHOT_EVERY_MS once synced)
//   out/bootstrap/YYYY-MM-DD.json   first snapshot of each UTC day (lets an imported wallet start near its birthday)
//   out/bootstrap/bot-seed.json     the bot's own throwaway seed (needed to resume its own state across restarts)
//   out/bootstrap/bot-state.json    the bot's full serialized state for fast restarts
//   out/bootstrap/retired-<time>/   files built against another indexer, moved aside at startup (never resumed, never served)
//
// Every file carries `indexer` (indexerId below): sync offsets are that indexer's event ids, so a state from another
// indexer must not be resumed or published.
//
// Ledger 9 (wallet SDK 2, snapshot format v2, see src/core/bootstrap.ts): the bot's DUST side starts at the ledger-9
// fork, like every wallet's. Its FIRST sync still replays every shielded event of the chain: about 3 hours of one CPU
// core (measured 2026-11-21: ~110 shielded + ~85 DUST events a second), reading the indexer the whole time. After
// that it only follows the tip. Run that first sync when the machine has the room, at low priority.
import { WebSocket } from 'ws'
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { InMemoryTransactionHistoryStorage, ProtocolVersion } from '@midnightntwrk/wallet-sdk'
import { DefaultForkSchedule, WalletEntrySchema, WalletFacade, mergeWalletEntries } from '@midnightntwrk/wallet-sdk/facade'
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded'
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnightntwrk/wallet-sdk/unshielded'
import { DustWallet } from '@midnightntwrk/wallet-sdk/dust'
import { WalletSeeds } from '@midnightntwrk/wallet-sdk/hd'
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { firstValueFrom } from 'rxjs'
import { Option } from 'effect'

// the first sync is hours of one busy core: stay out of the way of everything else on this machine
try { (await import('node:os')).setPriority(0, 10) } catch {}

const DIR = fileURLToPath(new URL('../out/bootstrap/', import.meta.url))
const SNAPSHOT_EVERY_MS = Number(process.env.BOT_SNAPSHOT_MS ?? 5 * 60_000)
const NET = {
  networkId: 'mainnet',
  // the deployment's mainnet indexer, on the same machine by default
  indexerUrl: process.env.LW_INDEXER ?? 'http://127.0.0.1:8188/api/v4/graphql',
  indexerWsUrl: process.env.LW_INDEXER_WS ?? 'ws://127.0.0.1:8188/api/v4/graphql/ws',
  nodeWs: process.env.LW_NODE_WS ?? 'ws://127.0.0.1:3142',
  prover: process.env.LW_PROVER ?? 'http://127.0.0.1:26300',
}
// same rules as src/core/net.ts (keep in sync): the indexer is one deployment whether reached on its local port or
// through the public path. LW_INDEXER_ID names its database (the app's VITE_INDEXER_ID: change both whenever the
// indexer is resynced from scratch); LW_DUST_FORK_CURSOR is the app's VITE_DUST_FORK_CURSOR (docs/SELF-HOSTING.md);
// LW_PUBLIC_HOST is the app's VITE_WALLET_HOST.
const OWN_INDEXER_ID = process.env.LW_INDEXER_ID ?? 'mainnet-1'
const OWN_DUST_FORK = /^\d+$/.test(process.env.LW_DUST_FORK_CURSOR ?? '') ? { cursor: BigInt(process.env.LW_DUST_FORK_CURSOR), version: 2_001_100n } : null
const PUBLIC_HOST = process.env.LW_PUBLIC_HOST ?? 'wallet-server.invalid'
function indexerId(url) {
  try {
    const u = new URL(url)
    if (u.host === PUBLIC_HOST && u.pathname.startsWith('/indexer/')) return OWN_INDEXER_ID
    if (/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && u.port === '8188') return OWN_INDEXER_ID
    return (u.host + u.pathname).toLowerCase().replace(/\/+$/, '')
  } catch { return url }
}
const INDEXER = indexerId(NET.indexerUrl)
const FORK = BigInt(DefaultForkSchedule.v9)
const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(ts(), ...a)
mkdirSync(DIR, { recursive: true })
log(`indexer ${NET.indexerUrl} (${INDEXER})`)

// Move aside (never delete) every snapshot / bot state built against another indexer or in the old format, before
// anything resumes or serves it. static.mjs lists only top-level YYYY-MM-DD.json files, so a retired-* folder is
// invisible to wallets.
{
  const foreign = []
  for (const f of readdirSync(DIR)) {
    if (!/^(latest|bot-state|\d{4}-\d{2}-\d{2})\.json(\.tmp)?$/.test(f)) continue
    let doc
    try { doc = JSON.parse(readFileSync(DIR + f, 'utf8')) } catch {}
    const old = /^bot-state/.test(f) ? doc?.format !== 2 : doc?.v !== 2
    if (doc?.indexer !== INDEXER || old) foreign.push([f, doc?.indexer, old])
  }
  if (foreign.length) {
    const dest = DIR + `retired-${new Date().toISOString().replace(/[:.]/g, '-')}/`
    mkdirSync(dest, { recursive: true })
    for (const [f, ix, old] of foreign) {
      let moved = false
      for (let i = 0; i < 5 && !moved; i++) {
        try { renameSync(DIR + f, dest + f); moved = true } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200) }
      }
      if (!moved) { copyFileSync(DIR + f, dest + f); unlinkSync(DIR + f) }
      log(`moved aside ${f}: ${ix !== INDEXER ? `built against ${ix ?? 'an unstamped indexer'}, not ${INDEXER}` : ''}${old ? ' (written before ledger 9)' : ''}`)
    }
    log(`retired ${foreign.length} file(s) to ${dest}`)
  }
}

// throwaway seed: no funds ever go here; it only exists so the bot can restore its own state after a restart
const seedFile = DIR + 'bot-seed.json'
if (!existsSync(seedFile)) writeFileSync(seedFile, JSON.stringify({ created: new Date().toISOString(), mnemonic: generateMnemonic(wordlist, 256) }))
const { mnemonic } = JSON.parse(readFileSync(seedFile, 'utf8'))
const seeds = WalletSeeds.fromMasterSeed(mnemonicToSeedSync(mnemonic))
const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, NET.networkId)

/** A DUST wallet from nothing, at the ledger-9 fork (the known position when one was given; else the SDK's own search). */
async function freshDust(cfg) {
  if (INDEXER === OWN_INDEXER_ID && OWN_DUST_FORK) {
    const probe = { dustTimelineStartProbe: async () => Option.some({ cursor: OWN_DUST_FORK.cursor, version: ProtocolVersion.ProtocolVersion(OWN_DUST_FORK.version) }) }
    const w = await DustWallet({ ...cfg, ...probe }).startWithSeed(seeds.dust)
    const s = await firstValueFrom(w.state)
    if (BigInt(s.protocolVersion) >= FORK && s.progress.appliedIndex === OWN_DUST_FORK.cursor) return w
    log(`DUST start: the known fork position was not taken (at ${s.progress.appliedIndex}, version ${s.protocolVersion}); searching`)
    await w.stop().catch(() => {})
  }
  const Dust = DustWallet({ ...cfg, skipLedgerV8DustHistory: true })
  for (let attempt = 1; ; attempt++) {
    const w = await Dust.startWithSeed(seeds.dust)
    const s = await firstValueFrom(w.state)
    if (BigInt(s.protocolVersion) >= FORK) return w
    if (attempt >= 3) { log('DUST start: fork not found, replaying the whole DUST history'); return w }
    await w.stop().catch(() => {})
    await new Promise((r) => setTimeout(r, 1_100 * attempt))
  }
}

const stateFile = DIR + 'bot-state.json'
const cache = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
if (cache) log('resuming bot state saved', cache.saved)
const facade = await WalletFacade.init({
  configuration: {
    networkId: NET.networkId,
    forks: DefaultForkSchedule,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(NET.nodeWs),
    provingServerUrl: new URL(NET.prover),
    indexerClientConnection: { indexerHttpUrl: NET.indexerUrl, indexerWsUrl: NET.indexerWsUrl },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    // bigger steps than the SDK's default of 10 events: about twice the sync speed (test/l9-dust-fast.mjs scratch)
    batchUpdates: { size: 200, timeout: 1, spacing: 4 },
  },
  shielded: async (c) => (cache ? ShieldedWallet(c).restore(cache.shielded) : ShieldedWallet(c).startWithSeed(seeds.shielded)),
  unshielded: async (c) => (cache ? UnshieldedWallet(c).restore(cache.unshielded) : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(keystore))),
  dust: async (c) => (cache ? DustWallet(c).restore(cache.dust) : freshDust(c)),
})
await facade.start(seeds)
log('bot started; syncing')

let last = null, lastLog = 0, lastSnapshot = 0, synced = false
facade.state().subscribe({ next: (s) => { last = s }, error: (e) => { log('state error', e?.message ?? e); process.exit(1) } })

// Windows refuses the rename while a reader (static.mjs streaming the file, a scanner) holds the target: retry a
// few times, then copy over it (a torn read is handled by the client as "no snapshot").
const writeAtomic = (file, text) => {
  writeFileSync(file + '.tmp', text)
  for (let i = 0; i < 5; i++) {
    try { renameSync(file + '.tmp', file); return } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200) }
  }
  copyFileSync(file + '.tmp', file)
}
const strip = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)))
async function checkpoint() {
  const [shielded, unshielded, dust] = await Promise.all([facade.shielded.serializeState(), facade.unshielded.serializeState(), facade.dust.serializeState()])
  const saved = new Date().toISOString()
  writeAtomic(stateFile, JSON.stringify({ format: 2, saved, indexer: INDEXER, shielded, unshielded, dust }))
  return { saved, sh: JSON.parse(shielded), du: JSON.parse(dust) }
}
async function snapshot() {
  const { saved, sh, du } = await checkpoint()
  // a snapshot must be coin-free, and past the fork on both sides, or wallets could not graft onto it
  if (Object.keys(sh.coinHashes ?? {}).length || (du.pendingDust ?? []).length || (last?.dust?.totalCoins?.length ?? 0) > 0) throw new Error('bot wallet has coins; refusing to publish')
  if (BigInt(sh.protocolVersion ?? 0) < FORK || BigInt(du.protocolVersion ?? 0) < FORK) throw new Error('not past the ledger-9 fork yet')
  const snap = { v: 2, savedAt: saved, indexer: INDEXER, shielded: strip(sh, ['publicKeys', 'coinHashes']), dust: strip(du, ['publicKey', 'pendingDust']) }
  const text = JSON.stringify(snap)
  writeAtomic(DIR + 'latest.json', text)
  const day = DIR + snap.savedAt.slice(0, 10) + '.json'
  if (!existsSync(day)) writeAtomic(day, text)
  log(`snapshot ${(text.length / 1024).toFixed(0)} KB  shielded offset ${sh.offset}  dust offset ${du.offset}`)
}

setInterval(async () => {
  const s = last
  if (!s) return
  const done = (p) => p?.isConnected && p.highestRelevantWalletIndex > 0n && p.appliedIndex + 3n >= p.highestRelevantWalletIndex
  const ok = done(s.shielded.progress) && done(s.dust.progress) && s.protocol?._tag === 'Settled'
  if (Date.now() - lastLog > 60_000) {
    lastLog = Date.now()
    const p = (x) => `${x?.appliedIndex ?? '?'}/${x?.highestRelevantWalletIndex ?? '?'}`
    log(`${ok ? 'synced' : 'syncing'}  shielded ${p(s.shielded.progress)}  dust ${p(s.dust.progress)}`)
    // checkpoint during the long first sync so a restart resumes
    if (!ok && Date.now() - lastSnapshot > 4 * 60_000) { lastSnapshot = Date.now(); try { await checkpoint() } catch (e) { log('checkpoint failed', e?.message ?? e) } }
  }
  if (!ok) { synced = false; return }
  if (!synced) { synced = true; log('fully synced') }
  if (Date.now() - lastSnapshot > SNAPSHOT_EVERY_MS) { lastSnapshot = Date.now(); try { await snapshot() } catch (e) { log('snapshot failed', e?.message ?? e) } }
}, 5_000)

process.on('uncaughtException', (e) => { log('uncaught', e?.message ?? e); process.exit(1) })
process.on('unhandledRejection', (e) => { log('unhandled', e?.message ?? e); process.exit(1) })
