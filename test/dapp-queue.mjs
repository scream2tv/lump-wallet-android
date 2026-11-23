// A send the network never answers must not keep the next approval from showing (dapp/host.ts), and a send ends
// when the wallet's own sync has the transaction in a block, or as "not confirmed yet" after a limit (core/sendWait.ts).
// Found 2026-11-23: a purchase landed on chain two seconds after the wallet sent it, the node's answer never came, and
// every later request of the site (three signatures) waited behind it with no sheet on screen.
// No wallet and no funds: the host is built in the page with a stand-in session. Starts its own dev server (5187).
//   node test/dapp-queue.mjs
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = 'http://127.0.0.1:5187'
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5187', '--strictPort'], { cwd: ROOT, stdio: 'ignore' })

let browser
try {
  for (let i = 0; i < 240; i++) { if (await fetch(BASE).then((r) => r.ok).catch(() => false)) break; await sleep(500) }
  browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(BASE, { waitUntil: 'load' })

  // ---- the approval line ----
  const line = await page.evaluate(async () => {
    const { DappHost } = await import('/src/dapp/host.ts')
    const { addConnection } = await import('/src/dapp/connections.ts')
    const origin = 'https://example.org'
    const asked = []
    const sends = []
    const session = {
      walletId: 'w1',
      snap: { phase: 'ready' },
      // the node never answers this send
      submitSealed: (bytes) => { sends.push(bytes.length); return new Promise(() => {}) },
      releaseSealed: async () => {},
      dappSign: async () => ({ signature: 'aa', verifyingKey: 'bb' }),
    }
    addConnection(origin, 'w1')
    const host = new DappHost(session, async (a) => { asked.push({ kind: a.kind, at: Date.now() }); return true })
    const t0 = Date.now()
    const call = (id, method, params) => host.handleRaw(origin, JSON.stringify({ id, method, params }))
    const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('NO ANSWER'), ms))])
    const submit = call(1, 'submitTransaction', ['00ff00ff'])
    await new Promise((r) => setTimeout(r, 300))
    const sign = await within(call(2, 'signData', ['hello', { encoding: 'text', keyType: 'unshielded' }]), 4000)
    const second = await within(call(3, 'signData', ['again', { encoding: 'text', keyType: 'unshielded' }]), 4000)
    const stillOpen = (await within(submit, 200)) === 'NO ANSWER'
    return { asked: asked.map((a) => `${a.kind}@${a.at - t0}`), sends, sign, second, stillOpen }
  })
  const signed = (raw) => { try { return JSON.parse(raw).result?.signature === 'aa' } catch { return false } }
  check(line.sends.length === 1 && line.stillOpen, `the send went out and the network never answered it (${line.sends.length} sent, still open: ${line.stillOpen})`)
  check(signed(line.sign), `a signature asked for meanwhile is shown and answered (${String(line.sign).slice(0, 80)})`)
  check(signed(line.second), `and so is the one after it (${String(line.second).slice(0, 80)})`)
  check(line.asked.filter((a) => a.startsWith('sign@')).length === 2, `the sheets came up: ${line.asked.join(', ')}`)

  // ---- what the site hears when a send is not confirmed in time, and when it is refused ----
  const said = await page.evaluate(async () => {
    const { DappHost } = await import('/src/dapp/host.ts')
    const { addConnection } = await import('/src/dapp/connections.ts')
    const wait = await import('/src/core/sendWait.ts').catch(() => null)
    const origin = 'https://example.org'
    addConnection(origin, 'w1')
    const make = (submitSealed) => new DappHost({ walletId: 'w1', snap: { phase: 'ready' }, submitSealed, releaseSealed: async () => {}, dappSign: async () => ({ signature: 'aa', verifyingKey: 'bb' }) }, async () => true)
    const call = (host, id) => host.handleRaw(origin, JSON.stringify({ id, method: 'submitTransaction', params: ['00ff'] }))
    const late = wait ? JSON.parse(await call(make(async () => { throw new wait.NotConfirmedYet() }), 1)) : null
    const refused = JSON.parse(await call(make(async () => { throw new Error('the node refused it') }), 2))
    const fine = JSON.parse(await call(make(async () => 'id'), 3))
    return { late, refused, fine }
  })
  check(said.late?.error?.code === 'InternalError' && /not confirmed/.test(said.late?.error?.reason ?? ''), `a send that is not confirmed in time is reported as sent and unconfirmed, not as refused (${JSON.stringify(said.late?.error)})`)
  check(said.refused?.error?.code === 'InvalidRequest', `a refused send is still reported as refused (${JSON.stringify(said.refused?.error)})`)
  check(said.fine?.result === null && !said.fine?.error, 'a send that is answered ends as before')

  // ---- one send per transaction ----
  const once = await page.evaluate(async () => {
    const { DappHost } = await import('/src/dapp/host.ts')
    const { addConnection } = await import('/src/dapp/connections.ts')
    const a = 'https://example.org', b = 'https://other.example'
    addConnection(a, 'w1'); addConnection(b, 'w1')
    let sends = 0, asks = 0
    let answer
    const session = { walletId: 'w1', snap: { phase: 'ready' }, releaseSealed: async () => {}, dappSign: async () => ({ signature: 'aa', verifyingKey: 'bb' }),
      submitSealed: () => { sends++; return new Promise((res, rej) => { answer = { res, rej } }) } }
    const host = new DappHost(session, async () => { asks++; return true })
    const call = (origin, id, tx) => host.handleRaw(origin, JSON.stringify({ id, method: 'submitTransaction', params: [tx] })).then(JSON.parse)
    const tick = () => new Promise((r) => setTimeout(r, 150))
    const one = call(a, 1, 'aabbcc'), two = call(a, 2, 'aabbcc')
    await tick()
    const three = call(a, 3, 'AABBCC')            // the same transaction, written in capitals
    const other = await call(b, 4, 'aabbcc')      // another site, while it is on its way
    await tick()
    const sendsWhileOpen = sends, asksWhileOpen = asks
    answer.res('id')
    const results = await Promise.all([one, two, three])
    // refused: the next request for it is a new send
    const again = call(a, 5, 'aabbcc')
    await tick()
    answer.rej(new Error('the node refused it'))
    const refused = await again
    const afterRefusal = call(a, 6, 'aabbcc')
    await tick()
    answer.res('id')
    const last = await afterRefusal
    return { sendsWhileOpen, asksWhileOpen, results, other, refused, last, sends }
  })
  check(once.sendsWhileOpen === 1 && once.asksWhileOpen === 1, `three requests for one transaction at once are one send and one sheet (${once.sendsWhileOpen} sent, ${once.asksWhileOpen} asked)`)
  check(once.results.every((r) => r.result === null && !r.error), 'and all three get its result')
  check(once.other?.error?.code === 'InvalidRequest' && /already being sent/.test(once.other.error.reason), `another site asking for it meanwhile is refused (${JSON.stringify(once.other?.error)})`)
  check(once.refused?.error?.code === 'InvalidRequest' && once.last?.result === null && once.sends === 3, `when a send has ended, the next request is a send of its own (${once.sends} in all)`)

  // ---- an approval that ran out while a sheet was up ----
  const stale = await page.evaluate(async () => {
    const { DappHost } = await import('/src/dapp/host.ts')
    const { addConnection } = await import('/src/dapp/connections.ts')
    const { NotConfirmedYet } = await import('/src/core/sendWait.ts')
    const origin = 'https://example.org'
    addConnection(origin, 'w1')
    const run = async ({ approve, submitSealed, until }) => {
      const released = []
      const session = { walletId: 'w1', snap: { phase: 'ready' }, dappSign: async () => ({ signature: 'aa', verifyingKey: 'bb' }), submitSealed,
        releaseSealed: async (bytes) => { released.push(bytes.length) } }
      const host = new DappHost(session, async () => approve)
      // a transaction this wallet balanced earlier: its approval, as the host keeps it
      host.approved.set('aabb', { origin, until })
      const answer = JSON.parse(await host.handleRaw(origin, JSON.stringify({ id: 1, method: 'submitTransaction', params: ['aabb'] })))
      await new Promise((r) => setTimeout(r, 50))
      return { answer, released: released.length, kept: host.approved.has('aabb'), held: host.sending.has('aabb') }
    }
    const past = Date.now() - 1000, ahead = Date.now() + 600_000
    return {
      declinedLate: await run({ approve: false, submitSealed: async () => 'id', until: past }),
      unconfirmed: await run({ approve: true, submitSealed: async () => { throw new NotConfirmedYet() }, until: past }),
      sentInTime: await run({ approve: true, submitSealed: async () => 'id', until: ahead }),
    }
  })
  check(stale.declinedLate.answer?.error?.code === 'Rejected' && stale.declinedLate.released === 1 && !stale.declinedLate.kept && !stale.declinedLate.held, `declined after its approval ran out: what it booked is released, once (${JSON.stringify(stale.declinedLate).slice(0, 140)})`)
  check(stale.unconfirmed.released === 0 && !stale.unconfirmed.kept, `sent and not confirmed yet: nothing is released (${stale.unconfirmed.released} released)`)
  check(stale.sentInTime.answer?.result === null && stale.sentInTime.released === 0 && !stale.sentInTime.kept, 'sent in time: nothing to release, the approval is used up')

  // ---- how a send ends ----
  const ends = await page.evaluate(async () => {
    const wait = await import('/src/core/sendWait.ts').catch(() => null)
    if (!wait) return null
    const { sendSettled, NotConfirmedYet } = wait
    const never = () => new Promise(() => {})
    const after = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms))
    const out = {}
    // the node answers first
    let polls = 0
    out.node = await sendSettled(after(40, 'by-node'), async () => { polls++; return null }, 2000, 50)
    await after(200)
    out.pollsAfterNode = polls
    const then = polls
    await after(200)
    out.pollsStopped = polls === then
    // the node never answers; the wallet's own sync has the transaction on its second look
    let looks = 0
    const t0 = Date.now()
    out.sync = await sendSettled(never(), async () => (++looks >= 2 ? 'by-sync' : null), 5000, 50)
    out.syncMs = Date.now() - t0
    // neither: not confirmed yet, after the limit
    const t1 = Date.now()
    out.neither = await sendSettled(never(), async () => null, 300, 50).then(() => 'RESOLVED', (e) => (e instanceof NotConfirmedYet ? 'not-confirmed' : `other: ${e}`))
    out.neitherMs = Date.now() - t1
    // the node refuses: that error, unchanged
    out.refused = await sendSettled(Promise.reject(new Error('refused')), async () => null, 2000, 50).then(() => 'RESOLVED', (e) => e.message)
    // a look at the sync that fails is a look that saw nothing
    let bad = 0
    out.badLook = await sendSettled(never(), async () => { if (++bad < 3) throw new Error('storage'); return 'by-sync' }, 5000, 50)
    return out
  })
  if (!ends) check(false, 'core/sendWait.ts is there')
  else {
    check(ends.node === 'by-node' && ends.pollsStopped, `the node's answer ends a send, and the sync is not asked any more (${ends.node}, ${ends.pollsAfterNode} looks)`)
    check(ends.sync === 'by-sync' && ends.syncMs < 1000, `with no answer from the node, the wallet's own sync ends it (${ends.sync} after ${ends.syncMs} ms)`)
    check(ends.neither === 'not-confirmed' && ends.neitherMs >= 280 && ends.neitherMs < 1500, `with neither, it ends as not confirmed yet at the limit (${ends.neither} after ${ends.neitherMs} ms)`)
    check(ends.refused === 'refused', `a refusal comes through unchanged (${ends.refused})`)
    check(ends.badLook === 'by-sync', `a failed look at the sync is only a look that saw nothing (${ends.badLook})`)
  }
} catch (e) {
  failed++
  console.log('FAILED', String(e?.message ?? e).slice(0, 500))
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
