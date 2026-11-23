// What a site's transaction may carry when it is handed to this wallet to balance, and what the sheet says it costs.
//
// Balancing ends with this wallet's signature on the SITE'S transaction: the wallet adds its own coins to the site's
// intents and signs each intent as a whole. That one signature authorises everything in the intent that this
// wallet's key can authorise, not only what the wallet added:
//   - every public coin of this wallet that the intent spends (the SDK puts the signature on every input that has
//     none), so a site could list this wallet's coins itself, pay them to an address of its own, and show a
//     transaction that is in balance: nothing to add, nothing on the sheet, and the coins gone;
//   - a fee energy (DUST) registration that names this wallet's key.
// So a transaction that already carries either is refused before anything is shown or signed. That includes a coin
// that comes with a signature on it: the SDK appends the wallet's own coins to the site's and keeps signatures by
// position, so a signature that is there says nothing certain about which coin ends up without one. A site has no
// need to name this wallet's coins: balancing is how they get in.
//
// The amounts on the sheet are counted per part of the transaction. A transaction has a part that always happens and
// parts that may fail on their own; a surplus in one does not pay for a shortfall in another (a site could put "you
// get it back" in a part made to fail), so every shortfall counts in full.
//
// No imports: this file is also run by node in test/dapp-guard.mjs.

export type Lane = 'public' | 'private'
export type Amount = { type: string; value: bigint; lane: Lane }
/** A signature verifying key as the ledger writes it. */
export type VerifyingKey = { tag: string; value: string }
export type OwnClaims = {
  /** this wallet's public coins the transaction spends, by token */
  spends: Amount[]
  /** fee energy registrations that name this wallet's key */
  registrations: number
}

const sameKey = (a: any, b: VerifyingKey) => !!a && String(a.tag) === String(b.tag) && String(a.value).toLowerCase() === String(b.value).toLowerCase()
const listOf = (x: any): any[] => (Array.isArray(x) ? x : x == null ? [] : [...x])

/**
 * What this wallet's signature on `tx` would authorise that the wallet did not put there. Reads every intent; throws
 * when a part cannot be read (the caller refuses the transaction: what cannot be read is not signed).
 */
export function ownClaims(tx: any, key: VerifyingKey): OwnClaims {
  if (!key || typeof key.value !== 'string' || key.value.length === 0) throw new Error('no key to compare with')
  const acc = new Map<string, Amount>()
  let registrations = 0
  const intents: any[] = tx?.intents == null ? [] : tx.intents instanceof Map ? [...tx.intents.values()] : (() => { throw new Error('unexpected intents') })()
  for (const intent of intents) {
    for (const offer of [intent?.guaranteedUnshieldedOffer, intent?.fallibleUnshieldedOffer]) {
      if (offer == null) continue
      for (const input of listOf(offer.inputs)) {
        if (!sameKey(input?.owner, key)) continue
        const type = String(input.type).toLowerCase()
        const cur = acc.get(type) ?? { type, value: 0n, lane: 'public' as Lane }
        cur.value += BigInt(input.value)
        acc.set(type, cur)
      }
    }
    for (const r of listOf(intent?.dustActions?.registrations)) if (sameKey(r?.nightKey, key)) registrations++
  }
  return { spends: [...acc.values()], registrations }
}

/** Why a site's transaction is refused, in words for the site and the trace; null when it may go on to the sheet. */
export function refusal(claims: OwnClaims): string | null {
  if (claims.spends.length > 0) return 'this transaction already spends coins of this wallet. A site leaves that to the wallet: it adds its own coins when it balances'
  if (claims.registrations > 0) return 'this transaction registers this wallet for fee energy. That is done in the wallet, not by a site'
  return null
}

/**
 * What the wallet has to add to a site's transaction, by token: the sum of every part's shortfall. `complete` is
 * false when a part could not be read.
 */
export function deficits(tx: any): { pays: Amount[]; complete: boolean } {
  let complete = true
  const segs = new Set<number>([0])
  for (const m of [tx.intents, tx.fallibleOffer]) if (m instanceof Map) for (const k of m.keys()) segs.add(Number(k))
  const acc = new Map<string, Amount>()
  for (const seg of segs) {
    let imb: Map<any, bigint>
    try { imb = tx.imbalances(seg) } catch { complete = false; continue }
    for (const [tt, v] of imb) {
      if (!tt || tt.tag === 'dust') continue
      const value = BigInt(v)
      // a surplus here pays for no shortfall elsewhere
      if (value >= 0n) continue
      const lane: Lane = tt.tag === 'shielded' ? 'private' : 'public'
      const key = `${lane}:${tt.raw}`
      const cur = acc.get(key) ?? { type: String(tt.raw).toLowerCase(), value: 0n, lane }
      cur.value += -value
      acc.set(key, cur)
    }
  }
  return { pays: [...acc.values()], complete }
}
