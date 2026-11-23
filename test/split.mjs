// The plan that sends a too-heavy transfer in parts (src/core/split.ts), with made-up coins and a made-up chain rule:
// a transfer is taken when it spends at most MAX coins. The pretend wallet spends its SMALLEST coins first, the worst
// case for the planner (it cannot choose the coins). No wallet, no network.
//   node test/split.mjs
import { largestFitting, partsEstimate, sendInParts, PartialSend } from '../src/core/split.ts'

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }

/** a pretend wallet: coins of one token, a rule on how many one transfer may spend, and what was sent */
function wallet(coins, max, { optimistic = 0, failAt = 0 } = {}) {
  let held = [...coins].sort((a, b) => (a < b ? -1 : 1))
  const sent = []
  let probes = 0
  const pick = (amount) => { const used = []; let sum = 0n; for (const c of held) { if (sum >= amount) break; used.push(c); sum += c } return sum >= amount ? { used, change: sum - amount } : null }
  return {
    sent, held: () => held, probes: () => probes,
    // `optimistic`: the estimate before proving lets this many coins too many through
    probe: async (amount) => { probes++; const p = pick(amount); return !!p && p.used.length <= max + optimistic },
    sendPart: async (amount) => {
      if (failAt && sent.length + 1 === failAt) throw new Error('the prover did not answer')
      const p = pick(amount)
      if (!p) throw new Error('not enough')
      if (p.used.length > max) return { refused: true }
      held = held.slice(p.used.length)
      if (p.change > 0n) held = [...held, p.change].sort((a, b) => (a < b ? -1 : 1))
      sent.push({ amount, coins: p.used.length })
      return { id: `tx${sent.length}` }
    },
    between: async () => {},
  }
}
const sum = (a) => a.reduce((n, x) => n + x, 0n)

// 1. one transfer when it fits
{
  const w = wallet([5_000_000n, 7_000_000n], 16)
  const ids = await sendInParts({ amount: 9_000_000n, ...w })
  check(ids.length === 1 && w.sent[0].amount === 9_000_000n && w.probes() === 1, 'a transfer that fits goes out as one, after one question')
}
// 2. the case that failed on 2026-11-21: one token in 29 small coins, the rule takes about 16
{
  const coins = Array.from({ length: 29 }, (_, i) => 200_000n + BigInt(i) * 7_000n)
  const total = sum(coins)
  const w = wallet(coins, 16)
  const est = await partsEstimate(w.probe, total)
  const ids = await sendInParts({ amount: total, ...w })
  check(sum(w.sent.map((s) => s.amount)) === total && w.held().length === 0, `29 small coins: all of it sent, nothing left behind (${ids.length} transfers; estimate was ${est.parts})`)
  check(w.sent.every((s) => s.coins <= 16), `no transfer spent more than the rule allows (${w.sent.map((s) => s.coins).join(', ')} coins)`)
  check(ids.length <= 4, 'in few transfers, not coin by coin')
}
// 3. the estimate before proving is too kind: the finished transaction is refused, and the part is halved
{
  const coins = Array.from({ length: 40 }, () => 100_000n)
  const w = wallet(coins, 10, { optimistic: 6 })
  const ids = await sendInParts({ amount: 3_300_000n, ...w })
  check(sum(w.sent.map((s) => s.amount)) === 3_300_000n && w.sent.every((s) => s.coins <= 10), `a too-kind estimate is corrected by the final check (${ids.length} transfers of ${w.sent.map((s) => s.coins).join(', ')} coins)`)
}
// 4. something breaks half-way: what went out is reported, the rest is not lost track of
{
  const coins = Array.from({ length: 30 }, () => 100_000n)
  const w = wallet(coins, 10, { failAt: 2 })
  let err = null
  try { await sendInParts({ amount: 3_000_000n, ...w }) } catch (e) { err = e }
  check(err instanceof PartialSend && err.ids.length === 1 && err.sent === w.sent[0].amount && /prover/.test(err.message), `a failure after the first part says what was sent (${err?.sent} in ${err?.ids?.length} transfer) and why`)
}
// 5. nothing went out at all: the plain error
{
  const w = wallet([100_000n, 100_000n], 10, { failAt: 1 })
  let err = null
  try { await sendInParts({ amount: 150_000n, ...w }) } catch (e) { err = e }
  check(err instanceof Error && !(err instanceof PartialSend), 'a failure before anything went out is a plain error')
}
// 6. many small coins and one large: once the small ones are spent, the rest goes in one (no part stays small for nothing)
{
  const coins = [...Array.from({ length: 29 }, () => 200_000n), 100_000_000n]
  const total = sum(coins)
  const w = wallet(coins, 16)
  const ids = await sendInParts({ amount: total, ...w })
  check(sum(w.sent.map((s) => s.amount)) === total && ids.length <= 3, `29 small coins and a large one: ${ids.length} transfers (${w.sent.map((s) => s.coins).join(', ')} coins), not one per small part`)
}
// 7. no headway possible (the rule takes ONE coin, the amount needs two): it stops and says so, it does not grind
{
  const w = wallet([100_000n, 11_000_000n], 1)
  let err = null
  try { await sendInParts({ amount: 11_050_000n, ...w }) } catch (e) { err = e }
  check(err instanceof Error && w.sent.length <= 37 && /too small|more than 37|would not take/.test(err.message), `a send that cannot make headway stops with words (${w.sent.length} transfers went out first): ${err?.message}`)
}
// 8. the search
{
  const fits = (limit) => async (a) => a <= limit
  check((await largestFitting(fits(1000n), 500n)) === 500n, 'largestFitting: the whole amount when it fits')
  const got = await largestFitting(fits(1000n), 64_000n)
  check(got > 0n && got <= 1000n && got >= 500n, `largestFitting: close under the limit (${got} of 1000)`)
  check((await largestFitting(fits(0n), 64_000n)) === 0n, 'largestFitting: 0 when nothing fits')
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
