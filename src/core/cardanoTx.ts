// What the wallet insists on before it signs a Cardano transaction that our server built. The server is asked to
// build (it has the chain data and the script machinery); it is not trusted: a transaction is signed only when,
// read here byte by byte, it can do nothing but the one thing the person asked for.
//   registration: every output goes to this wallet's own address or to the DUST mapping contract; exactly one
//     output to the contract, carrying one authorisation token, at most 2 ADA and exactly OUR mapping (our stake key
//     -> our fee energy address); exactly that one token is minted; the fee and the collateral are capped; nothing
//     else a transaction can do (certificates, withdrawals, votes, donations, …) is present.
//   move out: every output goes to the address the person typed or back to this wallet; nothing is minted.
// Cardano itself guarantees inputs = outputs + fee, so with the outputs and the fee pinned nothing can leak.
// A small CBOR reader of our own (definite and indefinite lengths, tags); anything it does not expect is a refusal.
import { blake2b } from '@noble/hashes/blake2.js'
import { bech32, bech32m } from '@scure/base'

/** Midnight's cNIGHT -> DUST mapping contract on Cardano mainnet (PlutusV3; the same script is the token's policy). */
export const MAPPING_SCRIPT_HASH = '73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5'
export const MAPPING_ADDRESS_HEX = '71' + MAPPING_SCRIPT_HASH
export const NIGHT_POLICY = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa'
export const NIGHT_NAME = '4e49474854'
const MAX_FEE = 1_500_000n            // a registration costs about 0.35 ADA
const MAX_MAPPING_LOVELACE = 2_000_000n
const MAX_COLLATERAL = 5_000_000n     // only at risk if the contract fails on chain

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const unhex = (h: string) => { if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error('not hex'); return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16)) }

// ---- CBOR ----
type Node =
  | { t: 'uint' | 'nint'; v: bigint }
  | { t: 'bytes'; v: Uint8Array }
  | { t: 'text'; v: string }
  | { t: 'array'; v: Node[] }
  | { t: 'map'; v: Array<[Node, Node]> }
  | { t: 'tag'; tag: bigint; v: Node }
  | { t: 'simple'; v: number }
type Read = { node: Node; end: number }

function read(b: Uint8Array, at: number, depth = 0): Read {
  if (depth > 32) throw new Error('nested too deep')
  if (at >= b.length) throw new Error('cut short')
  const major = b[at] >> 5, info = b[at] & 31
  let p = at + 1, n = 0n, indefinite = false
  if (info < 24) n = BigInt(info)
  else if (info <= 27) { const len = 1 << (info - 24); if (p + len > b.length) throw new Error('cut short'); for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(b[p + i]); p += len }
  else if (info === 31 && major >= 2 && major <= 5) indefinite = true
  else throw new Error('unexpected encoding')
  const isBreak = () => { if (p >= b.length) throw new Error('cut short'); return b[p] === 0xff }
  if (major === 0) return { node: { t: 'uint', v: n }, end: p }
  if (major === 1) return { node: { t: 'nint', v: -1n - n }, end: p }
  if (major === 2 || major === 3) {
    const parts: Uint8Array[] = []
    if (indefinite) { while (!isBreak()) { const r = read(b, p, depth + 1); if (r.node.t !== (major === 2 ? 'bytes' : 'text')) throw new Error('bad chunk'); parts.push(major === 2 ? (r.node as { v: Uint8Array }).v : new TextEncoder().encode((r.node as { v: string }).v)); p = r.end } p++ }
    else { const len = Number(n); if (n > 0x1000000n || p + len > b.length) throw new Error('cut short'); parts.push(b.slice(p, p + len)); p += len }
    const all = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of parts) { all.set(x, o); o += x.length }
    return major === 2 ? { node: { t: 'bytes', v: all }, end: p } : { node: { t: 'text', v: new TextDecoder().decode(all) }, end: p }
  }
  if (major === 4) {
    const v: Node[] = []
    if (indefinite) { while (!isBreak()) { const r = read(b, p, depth + 1); v.push(r.node); p = r.end } p++ }
    else { if (n > 100_000n) throw new Error('too long'); for (let i = 0n; i < n; i++) { const r = read(b, p, depth + 1); v.push(r.node); p = r.end } }
    return { node: { t: 'array', v }, end: p }
  }
  if (major === 5) {
    const v: Array<[Node, Node]> = []
    const pair = () => { const k = read(b, p, depth + 1); const x = read(b, k.end, depth + 1); v.push([k.node, x.node]); p = x.end }
    if (indefinite) { while (!isBreak()) pair(); p++ }
    else { if (n > 100_000n) throw new Error('too long'); for (let i = 0n; i < n; i++) pair() }
    return { node: { t: 'map', v }, end: p }
  }
  if (major === 6) { const r = read(b, p, depth + 1); return { node: { t: 'tag', tag: n, v: r.node }, end: r.end } }
  if (info >= 24) throw new Error('floats are not expected here')
  return { node: { t: 'simple', v: info }, end: p }
}

const fail = (why: string): never => { throw new Error(`Transaction refused: ${why}`) }
const uint = (n: Node | undefined, what: string): bigint => (n?.t === 'uint' ? n.v : fail(`${what} is not a number`))
const bytes = (n: Node | undefined, what: string): Uint8Array => (n?.t === 'bytes' ? n.v : fail(`${what} is not bytes`))
/** a list, or a set (tag 258 around a list) */
const list = (n: Node | undefined, what: string): Node[] => (n?.t === 'array' ? n.v : n?.t === 'tag' && n.tag === 258n && n.v.t === 'array' ? n.v.v : fail(`${what} is not a list`))

type Out = { addressHex: string; lovelace: bigint; assets: Map<string, bigint>; datumHex: string | null; hasScript: boolean }
function output(n: Node): Out {
  let addr: Node | undefined, value: Node | undefined, datum: Node | undefined, script = false
  if (n.t === 'map') {
    // a field given twice could be read one way here and another way by Cardano: refused
    const seen = new Set<bigint>()
    for (const [k, v] of n.v) {
      const key = uint(k, 'output field')
      if (seen.has(key)) fail('an output field twice')
      seen.add(key)
      if (key === 0n) addr = v; else if (key === 1n) value = v; else if (key === 2n) datum = v; else if (key === 3n) script = true; else fail('unknown output field')
    }
  } else if (n.t === 'array' && (n.v.length === 2 || n.v.length === 3)) { [addr, value] = n.v; if (n.v.length === 3) fail('an output with a datum hash') }
  else fail('output shape')
  const assets = new Map<string, bigint>()
  let lovelace = 0n
  if (value?.t === 'uint') lovelace = value.v
  else if (value?.t === 'array' && value.v.length === 2 && value.v[1].t === 'map') {
    lovelace = uint(value.v[0], 'amount')
    const policies = new Set<string>()
    for (const [pol, names] of value.v[1].v) {
      const policy = hex(bytes(pol, 'policy'))
      if (policies.has(policy)) fail('a token policy listed twice')
      policies.add(policy)
      if (names.t !== 'map') fail('token list')
      for (const [name, q] of (names as { v: Array<[Node, Node]> }).v) {
        const unit = hex(bytes(pol, 'policy')) + hex(bytes(name, 'token name'))
        if (assets.has(unit)) fail('a token listed twice')
        assets.set(unit, uint(q, 'token amount'))
      }
    }
  } else fail('output value')
  let datumHex: string | null = null
  if (datum) {
    // [1, #6.24(bytes)] = an inline datum; a datum hash ([0, hash]) is not something we ever ask for
    if (datum.t !== 'array' || datum.v.length !== 2 || uint(datum.v[0], 'datum kind') !== 1n) fail('datum kind')
    const d = (datum as { v: Node[] }).v[1]
    if (d.t !== 'tag' || d.tag !== 24n) fail('datum encoding')
    datumHex = hex(bytes((d as { v: Node }).v, 'datum'))
  }
  return { addressHex: hex(bytes(addr, 'address')), lovelace, assets, datumHex, hasScript: script }
}

type Body = { id: Uint8Array; fields: Map<bigint, Node>; outputs: Out[]; fee: bigint }
function open(cborHex: string): Body {
  const raw = unhex(cborHex.toLowerCase())
  const head = raw[0]
  if (head !== 0x84) fail('not a transaction')
  const body = read(raw, 1)
  const wit = read(raw, body.end)
  const valid = read(raw, wit.end)
  const aux = read(raw, valid.end)
  if (aux.end !== raw.length) fail('bytes after the transaction')
  if (valid.node.t !== 'simple' || valid.node.v !== 21) fail('marked as failing')   // true: a "failing" transaction only burns the collateral
  if (body.node.t !== 'map') fail('body shape')
  const fields = new Map<bigint, Node>()
  for (const [k, v] of (body.node as { v: Array<[Node, Node]> }).v) { const key = uint(k, 'body field'); if (fields.has(key)) fail('a field twice'); fields.set(key, v) }
  const outputs = list(fields.get(1n), 'outputs').map(output)
  return { id: blake2b(raw.slice(1, body.end), { dkLen: 32 }), fields, outputs, fee: uint(fields.get(2n), 'fee') }
}
const only = (b: Body, allowed: bigint[]) => { for (const k of b.fields.keys()) if (!allowed.includes(k)) fail(`it does something this wallet did not ask for (field ${k})`) }

/** The 33 bytes inside an mn_dust1… address, hex. */
export function dustPayloadHex(dustAddress: string): string {
  const d = bech32m.decode(dustAddress as `${string}1${string}`, 200)
  if (d.prefix !== 'mn_dust') throw new Error('not a mainnet fee energy address')
  const b = bech32m.fromWords(d.words)
  if (b.length !== 33) throw new Error('unexpected fee energy address')
  return hex(b)
}
/** The mapping datum: Constr 0 [ Constr 0 [ stake key hash ], dust address bytes ]. */
export const mappingDatumHex = (stakeKeyHash: string, dustHex: string) => `d8799fd8799f581c${stakeKeyHash}ff5821${dustHex}ff`

export type Checked = { id: Uint8Array; idHex: string; fee: bigint; locked: bigint; toSelf: { lovelace: bigint; night: bigint }; toOther: { lovelace: bigint; night: bigint } }
const sum = (outs: Out[]) => ({ lovelace: outs.reduce((s, o) => s + o.lovelace, 0n), night: outs.reduce((s, o) => s + (o.assets.get(NIGHT_POLICY + NIGHT_NAME) ?? 0n), 0n) })

/** A registration of OUR stake key to OUR fee energy address, and nothing else. Throws with the reason otherwise. */
export function checkRegistration(cborHex: string, me: { addressHex: string; paymentKeyHash: string; stakeKeyHash: string }, dustAddress: string): Checked {
  const b = open(cborHex)
  // inputs, outputs, fee, ttl, valid-from, mint, script data hash, collateral, required signers, collateral return, total collateral, reference inputs
  only(b, [0n, 1n, 2n, 3n, 8n, 9n, 11n, 13n, 14n, 16n, 17n, 18n])
  if (b.fee > MAX_FEE) fail('the fee is too high')
  const mine = b.outputs.filter((o) => o.addressHex === me.addressHex)
  const mapping = b.outputs.filter((o) => o.addressHex === MAPPING_ADDRESS_HEX)
  if (mine.length + mapping.length !== b.outputs.length) fail('it pays an address that is not yours')
  if (b.outputs.some((o) => o.hasScript)) fail('an output carries a script')
  if (mine.some((o) => o.datumHex !== null)) fail('unexpected data on your own output')
  if (mapping.length !== 1) fail('it must register exactly once')
  const m = mapping[0]
  if (m.lovelace > MAX_MAPPING_LOVELACE) fail('too much ADA locked in the registration')
  if (m.assets.size !== 1 || m.assets.get(MAPPING_SCRIPT_HASH) !== 1n) fail('the registration carries something else')
  if (m.datumHex !== mappingDatumHex(me.stakeKeyHash, dustPayloadHex(dustAddress))) fail('it registers something other than this wallet')
  // exactly one authorisation token is minted, nothing burned, nothing else minted
  const mint = b.fields.get(9n)
  if (mint?.t !== 'map' || mint.v.length !== 1) fail('mint')
  const [pol, names] = (mint as { v: Array<[Node, Node]> }).v[0]
  if (hex(bytes(pol, 'policy')) !== MAPPING_SCRIPT_HASH || names.t !== 'map' || names.v.length !== 1) fail('mint')
  const [name, q] = (names as { v: Array<[Node, Node]> }).v[0]
  if (bytes(name, 'token name').length !== 0 || uint(q, 'minted amount') !== 1n) fail('mint')
  const signers = list(b.fields.get(14n), 'signers').map((s) => hex(bytes(s, 'signer')))
  if (!signers.includes(me.stakeKeyHash) || signers.some((s) => s !== me.stakeKeyHash && s !== me.paymentKeyHash)) fail('signers')
  const ret = b.fields.get(16n)
  if (ret && output(ret).addressHex !== me.addressHex) fail('the collateral would not come back to you')
  if (b.fields.has(13n) && uint(b.fields.get(17n), 'collateral') > MAX_COLLATERAL) fail('the collateral is too high')
  return { id: b.id, idHex: hex(b.id), fee: b.fee, locked: m.lovelace, toSelf: sum(mine), toOther: { lovelace: 0n, night: 0n } }
}

/** A plain payment: every output goes to `toAddress` or back to this wallet; nothing minted, nothing else done. */
export function checkMoveOut(cborHex: string, me: { addressHex: string }, toAddress: string): Checked {
  const b = open(cborHex)
  only(b, [0n, 1n, 2n, 3n, 8n])
  if (b.fee > MAX_FEE) fail('the fee is too high')
  const toHex = cardanoAddressHex(toAddress)
  const mine = b.outputs.filter((o) => o.addressHex === me.addressHex)
  const theirs = b.outputs.filter((o) => o.addressHex === toHex && o.addressHex !== me.addressHex)
  if (mine.length + theirs.length !== b.outputs.length) fail('it pays an address you did not enter')
  if (b.outputs.some((o) => o.hasScript || o.datumHex !== null)) fail('an output carries data')
  return { id: b.id, idHex: hex(b.id), fee: b.fee, locked: 0n, toSelf: sum(mine), toOther: sum(theirs) }
}

/** ADA that may travel with NIGHT sent on its own (the door sends 1.2: a Cardano output cannot be a token alone). */
const MAX_CARRY = 1_500_000n

/**
 * A send of ADA or of NIGHT, exactly as asked: one output to `toAddress` holding that and nothing else, every other
 * output back to this wallet, nothing minted, nothing else done.
 *   want.lovelace: the ADA to arrive, to the lovelace; 'all' = whatever the transaction sends (the screen shows it)
 *   want.night:    the NIGHT to arrive; ADA of at most 1.5 then travels with it
 */
export function checkSend(cborHex: string, me: { addressHex: string }, toAddress: string, want: { lovelace: bigint | 'all'; night: bigint }): Checked {
  const b = open(cborHex)
  only(b, [0n, 1n, 2n, 3n, 8n])
  if (b.fee > MAX_FEE) fail('the fee is too high')
  const toHex = cardanoAddressHex(toAddress)
  if (toHex === me.addressHex) fail('that is your own address')
  const mine = b.outputs.filter((o) => o.addressHex === me.addressHex)
  const theirs = b.outputs.filter((o) => o.addressHex === toHex)
  if (mine.length + theirs.length !== b.outputs.length) fail('it pays an address you did not enter')
  if (b.outputs.some((o) => o.hasScript || o.datumHex !== null)) fail('an output carries data')
  if (theirs.length !== 1) fail('it must pay the address you entered exactly once')
  const t = theirs[0]
  const night = t.assets.get(NIGHT_POLICY + NIGHT_NAME) ?? 0n
  if (t.assets.size !== (night > 0n ? 1 : 0)) fail('it sends a token you did not ask for')
  if (night !== want.night) fail('it sends a different amount of NIGHT')
  if (want.night > 0n) { if (want.lovelace !== 0n || t.lovelace > MAX_CARRY) fail('it sends ADA you did not ask for') }
  else if (want.lovelace === 'all') { if (t.lovelace === 0n) fail('it sends nothing') }
  else if (want.lovelace <= 0n || t.lovelace !== want.lovelace) fail('it sends a different amount of ADA')
  return { id: b.id, idHex: hex(b.id), fee: b.fee, locked: 0n, toSelf: sum(mine), toOther: sum(theirs) }
}

/** A mainnet Cardano payment address (addr1…) as the bytes transactions carry; throws when it is not one. */
export function cardanoAddressHex(address: string): string {
  const a = address.trim().toLowerCase()
  if (!a.startsWith('addr1')) throw new Error('Not a Cardano address (addr1…)')
  let b: Uint8Array
  try { b = bech32.fromWords(bech32.decode(a as `${string}1${string}`, 1023).words) } catch { throw new Error('Not a valid Cardano address') }
  // header: address type in the high half, network in the low half (1 = mainnet); types 0-7 are payment addresses
  if ((b[0] & 0x0f) !== 1 || (b[0] >> 4) > 7 || (b.length !== 57 && b.length !== 29)) throw new Error('Not a mainnet Cardano address')
  return hex(b)
}
