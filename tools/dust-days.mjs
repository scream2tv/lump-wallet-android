// One-off (and repeatable) job: the PUBLIC fee energy (DUST) sync state as it stood near the start of each UTC day
// since the ledger-9 fork, for the days the state bot has no daily snapshot of (it started publishing later).
//   node tools/dust-days.mjs            -> out/bootstrap/dust/YYYY-MM-DD.json, one per day, existing files kept
// A wallet whose fee energy was created on day D (a Cardano registration, src/core/wallet.ts findFeeEnergy) replays
// the DUST events from the newest of these before D instead of from the fork.
// It is a coin-less DUST wallet with random throwaway keys, replaying the deployment's indexer's DUST events from the fork at
// low priority; nothing here is wallet-specific (the identity fields are stripped, as in server/state-bot.mjs).
// A day's file is the state at most CHECK_EVERY events into that day (well under an hour of chain time).
import { WebSocket } from 'ws'
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { InMemoryTransactionHistoryStorage, ProtocolVersion } from '@midnightntwrk/wallet-sdk'
import { DefaultForkSchedule, WalletEntrySchema, mergeWalletEntries } from '@midnightntwrk/wallet-sdk/facade'
import { DustWallet } from '@midnightntwrk/wallet-sdk/dust'
import * as ledgerV8 from '@midnightntwrk/ledger-v8'
import * as ledgerV9 from '@midnightntwrk/ledger-v9'
import { Option } from 'effect'

try { (await import('node:os')).setPriority(0, 10) } catch {}

const DIR = fileURLToPath(new URL('../out/bootstrap/dust/', import.meta.url))
const INDEXER_URL = process.env.LW_INDEXER ?? 'http://127.0.0.1:8188/api/v4/graphql'
const INDEXER_WS = process.env.LW_INDEXER_WS ?? 'ws://127.0.0.1:8188/api/v4/graphql/ws'
// the same two values as server/state-bot.mjs and the app build (docs/SELF-HOSTING.md)
const OWN_INDEXER_ID = process.env.LW_INDEXER_ID ?? 'mainnet-1'
if (!/^\d+$/.test(process.env.LW_DUST_FORK_CURSOR ?? '')) { console.error('LW_DUST_FORK_CURSOR is not set: this job starts at the known fork position of the indexer (docs/SELF-HOSTING.md)'); process.exit(1) }
const OWN_DUST_FORK = { cursor: BigInt(process.env.LW_DUST_FORK_CURSOR), version: 2_001_100n }
/** stop once the state is past this day (the state bot's own daily snapshots take over from there) */
const UNTIL = process.env.DUST_DAYS_UNTIL ?? '2026-11-22'
const CHECK_EVERY = 400n
const FORK = BigInt(DefaultForkSchedule.v9)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
mkdirSync(DIR, { recursive: true })

const seed = randomBytes(32)
const cfg = {
  networkId: 'mainnet',
  forks: DefaultForkSchedule,
  costParameters: { feeBlocksMargin: 5 },
  relayURL: new URL(process.env.LW_NODE_WS ?? 'ws://127.0.0.1:3142'),
  provingServerUrl: new URL(process.env.LW_PROVER ?? 'http://127.0.0.1:26300'),
  indexerClientConnection: { indexerHttpUrl: INDEXER_URL, indexerWsUrl: INDEXER_WS },
  txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  batchUpdates: { size: 100, timeout: 1, spacing: 1 },
  dustTimelineStartProbe: async () => Option.some({ cursor: OWN_DUST_FORK.cursor, version: ProtocolVersion.ProtocolVersion(OWN_DUST_FORK.version) }),
}
const wallet = await DustWallet(cfg).startWithSeed(seed)

const strip = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)))
let lastDay = null, busy = false, written = 0, lastLog = 0, done = false, first = true, checkedAt = 0n, startedAt = Date.now()
const finish = async (why) => { if (done) return; done = true; log(why, `(${written} day file(s) written, ${((Date.now() - startedAt) / 60_000).toFixed(1)} min)`); await wallet.stop().catch(() => {}); process.exit(0) }

/** The wallet's state as it is saved, and the chain time it has reached. */
async function look() {
  const du = JSON.parse(await wallet.serializeState())
  const t = ledgerV9.DustLocalState.deserialize(Buffer.from(du.state, 'hex')).syncTime
  return { du, t: t instanceof Date ? t : new Date(t) }
}

wallet.state.subscribe({
  next: async (s) => {
    const p = s.progress
    if (first) {
      first = false
      log(`started at event ${p?.appliedIndex}, protocol ${s.protocolVersion}`)
      if (BigInt(s.protocolVersion) < FORK || p.appliedIndex !== OWN_DUST_FORK.cursor) { log('not at the known fork position: refusing'); process.exit(1) }
    }
    if (done || busy || !p) return
    const atTip = p.isConnected && p.highestRelevantWalletIndex > 0n && p.appliedIndex + 3n >= p.highestRelevantWalletIndex
    if (p.appliedIndex - checkedAt < CHECK_EVERY && !atTip) return
    busy = true
    try {
      checkedAt = p.appliedIndex
      const { du, t } = await look()
      if (t.getTime() < 1e12) return   // nothing applied yet
      const day = t.toISOString().slice(0, 10)
      if (Date.now() - lastLog > 30_000) { lastLog = Date.now(); log(`at event ${du.offset} of ${p.highestRelevantWalletIndex}, chain time ${t.toISOString()}`) }
      if (day !== lastDay) {
        // the first state seen is the fork itself, mid-day: only a day that began while replaying gets a file
        if (lastDay !== null) {
          if ((du.pendingDust ?? []).length) throw new Error('the throwaway wallet holds something: refusing')
          const file = DIR + day + '.json'
          const doc = { v: 2, savedAt: new Date().toISOString(), stateTime: t.toISOString(), indexer: OWN_INDEXER_ID, dust: strip(du, ['publicKey', 'pendingDust']) }
          if (!existsSync(file)) { writeFileSync(file + '.tmp', JSON.stringify(doc)); renameSync(file + '.tmp', file); written++; log(`wrote ${day}.json  offset ${du.offset}  chain time ${t.toISOString()}`) }
          else log(`${day}.json exists: kept`)
        }
        lastDay = day
        if (day > UNTIL) { await finish(`past ${UNTIL}`); return }
      }
      if (atTip) await finish('at the tip')
    } catch (e) { log('check failed', e?.message ?? e) } finally { busy = false }
  },
  error: (e) => { log('state error', e?.message ?? e); process.exit(1) },
})
await wallet.start({ v8: ledgerV8.DustSecretKey.fromSeed(seed), v9: ledgerV9.DustSecretKey.fromSeed(seed) })
log('replaying DUST events from the ledger-9 fork')
process.on('uncaughtException', (e) => { log('uncaught', e?.message ?? e); process.exit(1) })
process.on('unhandledRejection', (e) => { log('unhandled', e?.message ?? e); process.exit(1) })
