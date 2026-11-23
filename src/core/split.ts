// A transfer that would be too heavy for its size goes out as several that are not.
//
// The chain refuses a transaction whose checking would take longer than its size allows (node error 231,
// OutsideTimeToDismiss). A token held as many small coins hits that: every coin spent is a signature to check and
// adds almost no bytes. The node's rule is in the ledger library, so the wallet can ask it beforehand (wallet.ts
// `fits`) instead of finding out at the node.
//
// This file is the plan around that question, with no wallet in it (test/split.mjs runs it with made-up coins):
//   probe(amount)    would a transfer of this amount be taken? Asked before proving; may be optimistic.
//   sendPart(amount) really send it. Says `refused` when the finished transaction would not be taken after all:
//                    nothing was sent then, and the part is tried smaller.
// Which coins a transfer spends is the wallet library's choice, so the search is over AMOUNTS, never over coins.

/**
 * More transfers than this for one send is not a plan any more (each waits for the last to confirm, about a minute):
 * the person is told to send less at a time. Also what stops a send that cannot make headway at all.
 */
export const MAX_PARTS = 37

export type Probe = (amount: bigint) => Promise<boolean>
export type SendPart = (amount: bigint) => Promise<{ id: string } | { refused: true }>

/** Part of the amount went out, then something stopped the rest. */
export class PartialSend extends Error {
  sent: bigint
  ids: string[]
  constructor(message: string, sent: bigint, ids: string[]) {
    super(message)
    this.sent = sent
    this.ids = ids
  }
}

/** The largest amount up to `max` that `probe` takes: `max` itself when it fits, else found by halving the gap. 0 when not even a sliver fits. */
export async function largestFitting(probe: Probe, max: bigint, steps = 7): Promise<bigint> {
  if (max <= 0n) return 0n
  if (await probe(max)) return max
  let lo = 0n, hi = max
  for (let i = 0; i < steps && hi - lo > 1n; i++) {
    const mid = lo + (hi - lo) / 2n
    if (await probe(mid)) lo = mid; else hi = mid
  }
  return lo
}

/** How many transfers `amount` will take, as far as can be told beforehand (later parts spend the smaller coins, so "about"). 0: it cannot be sent from here. */
export async function partsEstimate(probe: Probe, amount: bigint): Promise<{ parts: number; first: bigint }> {
  const first = await largestFitting(probe, amount)
  if (first === 0n) return { parts: 0, first }
  return { parts: Number((amount + first - 1n) / first), first }
}

/**
 * Send `amount` as one transfer when it fits, else part by part. `between` waits until the wallet may send again
 * (the last part confirmed). Resolves with the ids of every transfer; throws PartialSend when some went out and the
 * rest did not, and the plain error when nothing went out.
 */
export async function sendInParts(o: { amount: bigint; probe: Probe; sendPart: SendPart; between: () => Promise<void>; onPart?: (sent: number, left: bigint) => void }): Promise<string[]> {
  const ids: string[] = []
  let left = o.amount
  /** set only after the finished transaction was refused: the next try is at most this */
  let cap: bigint | null = null
  let shrunk = 0
  const stop = (why: string): Error => (ids.length ? new PartialSend(why, o.amount - left, ids) : new Error(why))
  while (left > 0n) {
    let part: bigint
    try {
      if (ids.length >= MAX_PARTS) throw new Error(`This would take more than ${MAX_PARTS} transactions. Send a smaller amount at a time`)
      // every part asks for all that is left first: spending the small coins frees the way for a larger part next
      part = await largestFitting(o.probe, cap !== null && cap < left ? cap : left)
      if (part === 0n) throw new Error('This token is held in pieces too small to send from this wallet')
      const r = await o.sendPart(part)
      if ('refused' in r) {
        // the estimate was too kind: half of it next
        cap = part / 2n
        if (cap === 0n || ++shrunk > 7) throw new Error('The network would not take this transfer, even in small parts')
        continue
      }
      ids.push(r.id)
    } catch (e) {
      throw stop(String((e as Error)?.message ?? e))
    }
    shrunk = 0
    left -= part
    cap = null
    o.onPart?.(ids.length, left)
    if (left > 0n) {
      try { await o.between() } catch (e) { throw stop(String((e as Error)?.message ?? e)) }
    }
  }
  return ids
}
