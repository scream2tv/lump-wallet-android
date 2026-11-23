// The wallet's Cardano side: one address, from the same recovery phrase, that holds the NIGHT which earns this
// wallet its fee energy (DUST). Standard Cardano derivation (CIP-1852, account 0: m/1852'/1815'/0', payment key 0/0,
// stake key 2/0, "Icarus" master key from the phrase's entropy), so the same words in any Cardano wallet show the
// same address and can always move what is on it. Keys are derived when needed and never stored or sent anywhere:
// the server builds transactions, this wallet checks them (cardanoTx.ts) and signs here.
// No Cardano library: BIP32-Ed25519 on the curve primitives, checked against a full Cardano library in
// test/cardano-keys.mjs.
import { ed25519 } from '@noble/curves/ed25519'
import { blake2b } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { bech32 } from '@scure/base'
import { mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

type Xprv = { kl: Uint8Array; kr: Uint8Array; cc: Uint8Array }
export type CardanoKeys = { payment: Xprv; stake: Xprv }
export type CardanoAccount = {
  address: string          // addr1… (base address: payment key + stake key)
  rewardAddress: string    // stake1…
  paymentKeyHash: string   // hex, 28 bytes
  stakeKeyHash: string     // hex, 28 bytes
  addressHex: string       // the address's 57 raw bytes, as transactions carry it
}

const H = 0x80000000
const L = ed25519.CURVE.n
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length } return o }
const le = (b: Uint8Array) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n }
const toLe = (n: bigint, len: number) => { const o = new Uint8Array(len); for (let i = 0; i < len; i++) { o[i] = Number(n & 0xffn); n >>= 8n } return o }
const mod = (n: bigint) => ((n % L) + L) % L
const pub = (k: Xprv) => ed25519.ExtendedPoint.BASE.multiply(mod(le(k.kl))).toRawBytes()

function master(mnemonic: string): Xprv {
  const entropy = mnemonicToEntropy(mnemonic, wordlist)
  const x = pbkdf2(sha512, new Uint8Array(0), entropy, { c: 4096, dkLen: 96 })
  entropy.fill(0)
  x[0] &= 0xf8; x[31] &= 0x1f; x[31] |= 0x40
  return { kl: x.slice(0, 32), kr: x.slice(32, 64), cc: x.slice(64, 96) }
}

function child(k: Xprv, index: number): Xprv {
  const i = toLe(BigInt(index), 4)
  const hard = index >= H
  const z = hard ? hmac(sha512, k.cc, cat(Uint8Array.of(0), k.kl, k.kr, i)) : hmac(sha512, k.cc, cat(Uint8Array.of(2), pub(k), i))
  const c = hard ? hmac(sha512, k.cc, cat(Uint8Array.of(1), k.kl, k.kr, i)) : hmac(sha512, k.cc, cat(Uint8Array.of(3), pub(k), i))
  const kl = toLe(8n * le(z.slice(0, 28)) + le(k.kl), 32)
  const kr = toLe((le(z.slice(32, 64)) + le(k.kr)) & ((1n << 256n) - 1n), 32)
  return { kl, kr, cc: c.slice(32, 64) }
}

/** The two keys of the address. Hold them only for as long as a signature takes, then `wipe` them. */
export function cardanoKeys(mnemonic: string): CardanoKeys {
  let acct = master(mnemonic)
  for (const i of [1852 + H, 1815 + H, 0 + H]) { const n = child(acct, i); wipeX(acct); acct = n }
  const pay0 = child(acct, 0), stake0 = child(acct, 2)
  const keys = { payment: child(pay0, 0), stake: child(stake0, 0) }
  wipeX(acct); wipeX(pay0); wipeX(stake0)
  return keys
}
const wipeX = (k: Xprv) => { k.kl.fill(0); k.kr.fill(0); k.cc.fill(0) }
export const wipe = (k: CardanoKeys) => { wipeX(k.payment); wipeX(k.stake) }

export function accountOf(k: CardanoKeys): CardanoAccount {
  const pkh = blake2b(pub(k.payment), { dkLen: 28 }), skh = blake2b(pub(k.stake), { dkLen: 28 })
  const addr = cat(Uint8Array.of(0x01), pkh, skh)   // base address, key + key, mainnet
  return {
    address: bech32.encode('addr', bech32.toWords(addr), 1023),
    rewardAddress: bech32.encode('stake', bech32.toWords(cat(Uint8Array.of(0xe1), skh)), 1023),
    paymentKeyHash: hex(pkh), stakeKeyHash: hex(skh), addressHex: hex(addr),
  }
}

/** The address for a recovery phrase (keys are dropped again before this returns). */
export function cardanoAccount(mnemonic: string): CardanoAccount {
  const k = cardanoKeys(mnemonic)
  try { return accountOf(k) } finally { wipe(k) }
}

function sign(k: Xprv, msg: Uint8Array): { vkey: Uint8Array; sig: Uint8Array } {
  const A = pub(k)
  const r = mod(le(sha512(cat(k.kr, msg))))
  const R = ed25519.ExtendedPoint.BASE.multiply(r === 0n ? 1n : r).toRawBytes()
  const h = mod(le(sha512(cat(R, A, msg))))
  const sig = cat(R, toLe(mod(r + h * mod(le(k.kl))), 32))
  if (!ed25519.verify(sig, msg, A)) throw new Error('signature check failed')
  return { vkey: A, sig }
}

/**
 * The witness set for a transaction id (32 bytes), signed by the payment key and, when `withStake`, the stake key:
 * CBOR { 0: [[vkey, signature], …] }, hex. The caller has already checked what the transaction does.
 */
export function witnessSet(k: CardanoKeys, txId: Uint8Array, withStake: boolean): string {
  if (txId.length !== 32) throw new Error('a transaction id is 32 bytes')
  const ws = [sign(k.payment, txId), ...(withStake ? [sign(k.stake, txId)] : [])]
  // a1 00 8N then per witness: 82 58 20 <vkey> 58 40 <sig>
  return hex(cat(Uint8Array.of(0xa1, 0x00, 0x80 + ws.length), ...ws.map((w) => cat(Uint8Array.of(0x82, 0x58, 0x20), w.vkey, Uint8Array.of(0x58, 0x40), w.sig))))
}
