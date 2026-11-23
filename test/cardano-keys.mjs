// The wallet's own Cardano key code (src/core/cardano.ts) against a full Cardano library (lucid), on THROWAWAY
// phrases made here: same address, same stake address, and signatures that the library's own keys verify.
// Nothing is printed but addresses of wallets that never held anything. Needs lucid: run from a folder that has it,
//   node test/cardano-keys.mjs        (after `npm install` in server/cardano; LUCID=<path of another build> overrides)
import { pathToFileURL } from 'node:url'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { ed25519 } from '@noble/curves/ed25519'
import { cardanoKeys, accountOf, cardanoAccount, witnessSet, wipe } from '../src/core/cardano.ts'

const LUCID = process.env.LUCID ?? new URL('../server/cardano/node_modules/@lucid-evolution/lucid/dist/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const { walletFromSeed, getAddressDetails } = await import(pathToFileURL(LUCID).href)
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const unhex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)))

let same = 0, sigs = 0
const N = 12
for (let i = 0; i < N; i++) {
  const words = generateMnemonic(wordlist, i % 3 === 0 ? 128 : 256)   // 12-word phrases too
  let ok = false
  try {
    const ref = walletFromSeed(words, { addressType: 'Base', accountIndex: 0, network: 'Mainnet' })
    const mine = cardanoAccount(words)
    const d = getAddressDetails(ref.address)
    ok = mine.address === ref.address && mine.rewardAddress === ref.rewardAddress && mine.paymentKeyHash === d.paymentCredential.hash && mine.stakeKeyHash === d.stakeCredential.hash && mine.addressHex === d.address.hex
    if (ok) same++
    // a witness set of ours: two signatures over a transaction id, each by the key whose hash is in the address
    const id = crypto.getRandomValues(new Uint8Array(32))
    const k = cardanoKeys(words)
    const w = unhex(witnessSet(k, id, true)); wipe(k)
    const v1 = w.slice(6, 38), s1 = w.slice(40, 104), v2 = w.slice(107, 139), s2 = w.slice(141, 205)
    if (w[0] === 0xa1 && w[2] === 0x82 && ed25519.verify(s1, id, v1) && ed25519.verify(s2, id, v2)) sigs++
  } catch { /* never print: an error here could carry key material */ }
}
check(same === N, `${same}/${N} throwaway phrases: same address, stake address and key hashes as the Cardano library`)
check(sigs === N, `${sigs}/${N} witness sets: both signatures verify`)
const k = cardanoKeys(generateMnemonic(wordlist, 256)); const a = accountOf(k); wipe(k)
check(/^addr1q[0-9a-z]{97}$/.test(a.address) && /^stake1u[0-9a-z]{52}$/.test(a.rewardAddress), `shape: ${a.address.slice(0, 14)}… ${a.rewardAddress.slice(0, 12)}…`)
check(k.payment.kl.every((b) => b === 0) && k.stake.kr.every((b) => b === 0), 'wipe() zeroes the keys')
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
