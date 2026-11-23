// A site may not get this wallet's signature on coins the wallet did not choose to spend (src/dapp/guard.ts).
//
// Found in the 2026-11-22 review: balancing a site's transaction ends with the wallet signing the site's intents, and
// the SDK puts that signature on EVERY input without one. A site could list this wallet's own public coins as inputs
// and pay them to itself: the transaction is in balance, so the sheet said "No tokens leave your wallet".
// This test builds such transactions with the real ledger and the SDK's own signing step, shows that the signature
// the SDK attaches really authorises the wallet's coin, and checks that the guard refuses each of them while letting
// an ordinary site transaction through. Throwaway keys, no network, no wallet.
//   node test/dapp-guard.mjs
import * as ledger from '@midnightntwrk/ledger-v9'
import { TransactionOps } from '../node_modules/@midnightntwrk/wallet-sdk-unshielded-wallet/dist/v2/TransactionOps.js'
import { Either } from 'effect'
import { ownClaims, refusal, deficits } from '../src/dapp/guard.ts'

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }

const mineSk = ledger.sampleSigningKey(), mine = ledger.signatureVerifyingKey(mineSk)
const siteSk = ledger.sampleSigningKey(), site = ledger.signatureVerifyingKey(siteSk)
const siteAddress = ledger.addressFromKey(site), myAddress = ledger.addressFromKey(mine)
const NIGHT = ledger.nativeToken().raw
const OTHER = ledger.sampleRawTokenType()
const ttl = () => new Date(Date.now() + 30 * 60_000)
const coin = (owner, value, type = NIGHT, outputNo = 0) => ({ value, owner, type, intentHash: ledger.sampleIntentHash(), outputNo })
const out = (owner, value, type = NIGHT) => ({ value, owner, type })
const nothing = async () => { throw new Error('nothing to prove') }
const noProver = { check: nothing, prove: nothing, lookupKey: async () => undefined, getParams: nothing }

/** A site's transaction as the wallet receives it: proved, not bound, through the same bytes and reader as the app. */
async function asReceived(build) {
  const intent = ledger.Intent.new(ttl())
  build(intent)
  const unproven = ledger.Transaction.fromParts('mainnet', undefined, undefined, intent)
  const proven = await unproven.prove(noProver, ledger.CostModel.initialCostModel())
  return ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', proven.serialize())
}
const segmentOf = (tx) => [...tx.intents.keys()][0]

// ---- 1. the attack: this wallet's coin as an input of the site's own making, paid to the site ----
{
  const tx = await asReceived((intent) => {
    intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(mine, 5_000_000n)], [out(siteAddress, 5_000_000n)], [])
  })
  const before = deficits(tx)
  check(before.pays.length === 0 && before.complete, 'the hostile transaction is in balance: by amounts alone the wallet has nothing to add and nothing to show')

  // what the SDK does when the wallet signs a balanced site transaction: one signature per intent, on every input without one
  const seg = segmentOf(tx)
  const signature = ledger.signData(mineSk, tx.intents.get(seg).signatureData(seg))
  const signed = Either.getOrThrow(TransactionOps.addSignature(tx, signature, seg))
  const offer = signed.intents.get(seg).guaranteedUnshieldedOffer
  check(offer.signatures.length === 1 && ledger.verifySignature(mine, signed.intents.get(seg).signatureData(seg), signature), 'unguarded, the SDK puts the wallet\'s valid signature on that coin: the site could spend it')

  const fresh = await asReceived((intent) => {
    intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(mine, 5_000_000n)], [out(siteAddress, 5_000_000n)], [])
  })
  const claims = ownClaims(fresh, mine)
  check(claims.spends.length === 1 && claims.spends[0].value === 5_000_000n && claims.spends[0].lane === 'public' && claims.spends[0].type === String(NIGHT).toLowerCase(), `the guard sees the coin (${claims.spends.map((s) => s.value).join()})`)
  check(/already spends coins of this wallet/.test(refusal(claims) ?? ''), 'and the transaction is refused')
}

// ---- 2. the same in the part that may fail, among other inputs, in several coins and tokens ----
{
  const tx = await asReceived((intent) => {
    intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 1n)], [out(siteAddress, 1n)], [])
    intent.fallibleUnshieldedOffer = ledger.UnshieldedOffer.new(
      [coin(site, 7n), coin(mine, 40n, NIGHT, 1), coin(mine, 2n, NIGHT, 2), coin(mine, 9n, OTHER, 3)],
      [out(siteAddress, 49n), out(siteAddress, 9n, OTHER)], [])
  })
  const claims = ownClaims(tx, mine)
  const night = claims.spends.find((s) => s.type === String(NIGHT).toLowerCase()), other = claims.spends.find((s) => s.type === String(OTHER).toLowerCase())
  check(night?.value === 42n && other?.value === 9n && claims.spends.length === 2, 'coins of this wallet in the part that may fail are found and added up by token')
  check(refusal(claims) !== null, 'refused')
}

// ---- 3. upper-case key spelling does not hide a coin ----
{
  const tx = await asReceived((intent) => {
    intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(mine, 3n)], [out(siteAddress, 3n)], [])
  })
  check(refusal(ownClaims(tx, { tag: mine.tag, value: mine.value.toUpperCase() })) !== null, 'the key is compared whatever its letter case')
  let threw = false
  try { ownClaims(tx, { tag: mine.tag, value: '' }) } catch { threw = true }
  check(threw, 'without a key to compare with, nothing is waved through')
}

// ---- 4. an ordinary site transaction: other people's coins, a payment the wallet has to add ----
{
  const tx = await asReceived((intent) => {
    intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 10n)], [out(siteAddress, 10n), out(siteAddress, 2_000_000n, OTHER)], [])
  })
  const claims = ownClaims(tx, mine)
  check(claims.spends.length === 0 && claims.registrations === 0 && refusal(claims) === null, 'a transaction that spends none of this wallet\'s coins goes on to the sheet')
  const d = deficits(tx)
  check(d.complete && d.pays.length === 1 && d.pays[0].value === 2_000_000n && d.pays[0].type === String(OTHER).toLowerCase(), `and the sheet shows what the wallet has to add (${d.pays.map((p) => p.value).join()})`)
  // a payment TO this wallet is no reason to refuse
  const paid = await asReceived((intent) => {
    intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 10n)], [out(myAddress, 10n)], [])
  })
  check(refusal(ownClaims(paid, mine)) === null, 'a transaction that pays this wallet goes on as well')
}

// ---- 5. a coin of this wallet that already carries a signature: signatures go by position and the SDK appends coins, so it proves nothing ----
{
  const intent = ledger.Intent.new(ttl())
  intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(mine, 8n)], [out(siteAddress, 8n)], [])
  const unsignedTx = ledger.Transaction.fromParts('mainnet', undefined, undefined, intent)
  const seg = segmentOf(unsignedTx)
  const signature = ledger.signData(mineSk, unsignedTx.intents.get(seg).signatureData(seg))
  const signedTx = Either.getOrThrow(TransactionOps.addSignature(unsignedTx, signature, seg))
  const proven = await signedTx.prove(noProver, ledger.CostModel.initialCostModel())
  const tx = ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', proven.serialize())
  const claims = ownClaims(tx, mine)
  check(tx.intents.get(seg).guaranteedUnshieldedOffer.signatures.length === 1 && claims.spends.length === 1 && refusal(claims) !== null, 'a coin of this wallet is refused even when a signature already sits on it')
}

// ---- 6. a fee energy registration that names this wallet's key ----
{
  let built = false, claims = null
  try {
    const tx = await asReceived((intent) => {
      intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 1n)], [out(siteAddress, 1n)], [])
      const reg = new ledger.DustRegistration('signature', mine, ledger.sampleDustSecretKey().publicKey, 0n)
      intent.dustActions = new ledger.DustActions('signature', 'pre-proof', new Date(), [], [reg])
    })
    built = true
    claims = ownClaims(tx, mine)
  } catch (e) { console.log('     (could not build the registration case: ' + String(e?.message ?? e).slice(0, 120) + ')') }
  if (built) {
    check(claims.registrations === 1 && /registers this wallet for fee energy/.test(refusal(claims) ?? ''), 'a registration that names this wallet\'s key is refused')
  } else {
    // the reader itself, on the shape the ledger gives a registration
    const shaped = { intents: new Map([[1, { dustActions: { registrations: [{ nightKey: mine }, { nightKey: site }] } }]]) }
    const c = ownClaims(shaped, mine)
    check(c.registrations === 1 && refusal(c) !== null, 'a registration that names this wallet\'s key is refused (read from the ledger\'s shape)')
  }
}

// ---- 7. amounts: a surplus in one part does not pay for a shortfall in another ----
{
  // the part that always happens is short 30 (paid to the site); the part that may fail has 30 too many
  const tx = await asReceived((intent) => {
    intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([], [out(siteAddress, 30n, OTHER)], [])
    intent.fallibleUnshieldedOffer = ledger.UnshieldedOffer.new([coin(site, 30n, OTHER)], [], [])
  })
  const d = deficits(tx)
  const total = d.pays.filter((p) => p.type === String(OTHER).toLowerCase()).reduce((n, p) => n + p.value, 0n)
  check(d.complete && total === 30n, `a shortfall is shown in full although another part has a surplus of the same token (shown: ${total})`)
}

// ---- 8. what cannot be read is refused, not waved through ----
{
  let threw = false
  try { ownClaims({ intents: { not: 'a map' } }, mine) } catch { threw = true }
  check(threw, 'a transaction whose intents cannot be read makes the guard throw')
  check(ownClaims({ intents: undefined }, mine).spends.length === 0, 'a transaction without intents has nothing of this wallet\'s to sign for')
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
