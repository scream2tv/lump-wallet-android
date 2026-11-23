// A hostile site at the wallet's door (src/dapp/host.ts with src/dapp/guard.ts): a transaction that brings this
// wallet's own coins along is refused before any sheet comes up and never reaches the signing step; an ordinary
// transaction goes to the sheet with its full cost; and a trade whose proceeds go to somebody else says so.
// The transactions are built here with the real ledger; the host runs in a page with a stand-in session.
// No wallet and no funds. Starts its own dev server (5188).
//   node test/dapp-hostile.mjs
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import * as ledger from '@midnightntwrk/ledger-v9'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = 'http://127.0.0.1:5188'
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (b) => Buffer.from(b).toString('hex')

// ---- the transactions, as a site would hand them over (proved, not bound) ----
const mine = ledger.signatureVerifyingKey(ledger.sampleSigningKey())
const site = ledger.signatureVerifyingKey(ledger.sampleSigningKey())
const siteAddress = ledger.addressFromKey(site)
const NIGHT = ledger.nativeToken().raw, OTHER = ledger.sampleRawTokenType()
const coin = (owner, value, type = NIGHT, outputNo = 0) => ({ value, owner, type, intentHash: ledger.sampleIntentHash(), outputNo })
const out = (owner, value, type = NIGHT) => ({ value, owner, type })
const nothing = async () => { throw new Error('nothing to prove') }
const noProver = { check: nothing, prove: nothing, lookupKey: async () => undefined, getParams: nothing }
async function siteTx(build) {
  const intent = ledger.Intent.new(new Date(Date.now() + 30 * 60_000))
  build(intent)
  const proven = await ledger.Transaction.fromParts('mainnet', undefined, undefined, intent).prove(noProver, ledger.CostModel.initialCostModel())
  return hex(proven.serialize())
}
const HOSTILE = await siteTx((i) => { i.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(mine, 5_000_000n)], [out(siteAddress, 5_000_000n)], []) })
const HOSTILE_FALLIBLE = await siteTx((i) => {
  i.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 1n)], [out(siteAddress, 1n)], [])
  i.fallibleUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 7n), coin(mine, 40n, NIGHT, 1)], [out(siteAddress, 47n)], [])
})
const ORDINARY = await siteTx((i) => { i.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 10n)], [out(siteAddress, 10n), out(siteAddress, 2_000_000n, OTHER)], []) })
const TWO_PARTS = await siteTx((i) => {
  i.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([], [out(siteAddress, 30n, OTHER)], [])
  i.fallibleUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 30n, OTHER)], [], [])
})

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5188', '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
let browser
try {
  for (let i = 0; i < 240; i++) { if (await fetch(BASE).then((r) => r.ok).catch(() => false)) break; await sleep(500) }
  browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(BASE, { waitUntil: 'load' })

  const run = (tx, opts = {}) => page.evaluate(async ({ tx, mine, opts }) => {
    const { DappHost } = await import('/src/dapp/host.ts')
    const { addConnection } = await import('/src/dapp/connections.ts')
    const origin = 'https://example.org'
    const asked = []
    let signed = 0
    const session = {
      walletId: 'w1',
      snap: { phase: 'ready' },
      verifyingKey: () => { if (opts.noKey) throw new Error('wallet not running'); return mine },
      feeOf: async () => 0n,
      whenCanTransact: async () => {},
      // the step that ends with the wallet's signature
      dappBalance: async () => { signed++; return new Uint8Array([1, 2, 3]) },
      releaseSealed: async () => {},
    }
    addConnection(origin, 'w1')
    const host = new DappHost(session, async (a) => { asked.push({ kind: a.kind, pays: (a.pays ?? []).map((p) => ({ type: p.type, value: String(p.value), lane: p.lane })), complete: a.complete }); return true })
    const raw = await host.handleRaw(origin, JSON.stringify({ id: 1, method: opts.sealed ? 'balanceSealedTransaction' : 'balanceUnsealedTransaction', params: [tx, { payFees: false }] }))
    return { raw, asked, signed }
  }, { tx, mine, opts })
  const errorOf = (raw) => { try { return JSON.parse(raw).error ?? null } catch { return null } }

  const a = await run(HOSTILE)
  check(errorOf(a.raw)?.code === 'InvalidRequest' && /already spends coins of this wallet/.test(errorOf(a.raw)?.reason ?? errorOf(a.raw)?.message ?? ''), `a transaction that spends this wallet's coin is refused (${String(a.raw).slice(0, 140)})`)
  check(a.asked.length === 0, `no sheet came up for it (${a.asked.length})`)
  check(a.signed === 0, `and nothing was signed (${a.signed})`)

  const b = await run(HOSTILE_FALLIBLE)
  check(errorOf(b.raw)?.code === 'InvalidRequest' && b.asked.length === 0 && b.signed === 0, 'the same with the coin in the part that may fail, among the site\'s own coins')

  const c = await run(HOSTILE, { noKey: true })
  check(errorOf(c.raw)?.code === 'InvalidRequest' && c.asked.length === 0 && c.signed === 0, `when the wallet's key cannot be read, nothing is let through (${String(c.raw).slice(0, 110)})`)

  const d = await run(ORDINARY)
  const dPays = d.asked[0]?.pays ?? []
  check(d.asked.length === 1 && d.asked[0].kind === 'balance' && dPays.length === 1 && dPays[0].value === '2000000' && dPays[0].type === String(OTHER).toLowerCase() && d.asked[0].complete === true, `an ordinary transaction goes to the sheet with what the wallet adds (${JSON.stringify(dPays)})`)
  check(d.signed === 1 && !errorOf(d.raw), `and is balanced after the approval (${String(d.raw).slice(0, 80)})`)

  const e = await run(TWO_PARTS)
  const ePays = e.asked[0]?.pays ?? []
  check(e.asked.length === 1 && ePays.length === 1 && ePays[0].value === '30', `a shortfall is on the sheet in full although another part of the transaction has a surplus (${JSON.stringify(ePays)})`)

  // ---- the trade sheet: proceeds that go to somebody else ----
  const sheet = await page.evaluate(async () => {
    const { drawSheet } = await import('/test/pages/approve-sheet.tsx')
    const mineAddr = 'mn_addr1mine', other = 'mn_addr1other'
    const snap = { phase: 'ready', readyForTxAt: Date.now() - 1, tradeReady: true, unshieldedAddress: mineAddr, shieldedAddress: 'mn_shield-addr1mine' }
    const draw = (receives) => drawSheet({ kind: 'intent', origin: 'https://example.org', pays: [{ type: 'a'.repeat(64), value: 5n, lane: 'public' }], receives, payFees: false }, snap)
    const r = (recipient) => ({ type: 'b'.repeat(64), value: 7n, lane: 'public', recipient })
    return { toMe: await draw([r(mineAddr)]), toOther: await draw([r(other)]), both: await draw([r(mineAddr), r(other)]) }
  })
  check(/You receive/.test(sheet.toMe.text) && !sheet.toMe.flagged, 'a trade paid to this wallet reads "You receive"')
  check(!/You receive/.test(sheet.toOther.text) && sheet.toOther.flagged && /Paid to another address, not to this wallet/.test(sheet.toOther.text), 'a trade paid to somebody else does not, and says where it goes')
  check(/You receive/.test(sheet.both.text) && sheet.both.flagged, 'with both, each is under its own heading')
} catch (e) {
  console.log('FAIL the test itself: ' + String(e?.stack ?? e).slice(0, 600)); failed++
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
