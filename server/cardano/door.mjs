// The wallet's Cardano door (127.0.0.1:3148; reached by apps through server/static.mjs as /wallet/api/cardano/*).
// It reads the deployment's Cardano stack (Kupo + Ogmios) and its Midnight indexer, and BUILDS three transactions for the
// wallet's built-in Cardano address: the cNIGHT -> DUST registration, a send of ADA or NIGHT, and "move everything
// out". It holds no keys
// and signs nothing: the app checks every byte of what it gets (src/core/cardanoTx.ts) and signs on the phone.
// It submits only transactions it built itself, with the witnesses the app sends back.
//   GET  /state?address=addr1…&dust=mn_dust1…   what is on the address, is it registered, what Midnight sees
//   GET  /activity?address=addr1…               the transactions that put coins on the address or spent its coins, newest first
//   POST /register {address, dust}              -> { cbor, id }   (refused when the stake key is registered already)
//   POST /send     {address, to, lovelace | night}  -> { cbor, id }   ADA (an amount, or "all" that is free) or NIGHT to `to`
//   POST /moveout  {address, to}                -> { cbor, id }   everything on the address to `to`
//   POST /submit   {id, witness}                -> { id }
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { Lucid, Kupmios, Data, Constr, mintingPolicyToId, validatorToAddress, getAddressDetails } from '@lucid-evolution/lucid'
import { bech32m } from '@scure/base'

const PORT = Number(process.env.CARDANO_DOOR_PORT ?? 3148)
const KUPO = process.env.KUPO_URL ?? 'http://127.0.0.1:1442'
const OGMIOS = process.env.OGMIOS_URL ?? 'http://127.0.0.1:1337'
const INDEXER = process.env.MN_INDEXER_URL ?? 'http://127.0.0.1:8188/api/v4/graphql'

const MAPPING_VALIDATOR = 'addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7'
const AUTH_POLICY = '73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5'
const NIGHT_UNIT = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa' + Buffer.from('NIGHT').toString('hex')
const LOVELACE_FOR_REGISTRATION = 1_586_080n   // the official dApp's constant
const NIGHT_COIN_LOVELACE = 2_000_000n          // ADA riding with the NIGHT coin
const COLLATERAL = 2_000_000n
/** NIGHT sent on its own takes this much ADA along: a Cardano output cannot hold a token and no ADA. */
const NIGHT_SEND_LOVELACE = 1_200_000n
const MIN_SEND_LOVELACE = 1_000_000n
/** transactions built or handed in per client and minute (the tests' own door raises it) */
const BUILDS_PER_MIN = Number(process.env.CARDANO_DOOR_BUILDS_PER_MIN ?? 7)
/** What the address needs before it can register: the locked amount, the fee, the NIGHT coin's ADA, some change. */
const NEEDS_LOVELACE = 4_500_000n
const SCRIPT = { type: 'PlutusV3', script: readFileSync(new URL('./dust-mapping-validator.plutusV3.hex', import.meta.url), 'utf8').trim() }
if (mintingPolicyToId(SCRIPT) !== AUTH_POLICY || validatorToAddress('Mainnet', SCRIPT) !== MAPPING_VALIDATOR) { console.error('the mapping script file is not the mainnet mapping contract'); process.exit(1) }
const CREATE = Data.to(new Constr(0, []))

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const provider = new Kupmios(KUPO, OGMIOS)

// ---- inputs ----
function addressOf(a) {
  if (typeof a !== 'string' || a.length > 120 || !/^addr1[0-9a-z]+$/.test(a)) throw bad('not a Cardano address')
  let d
  try { d = getAddressDetails(a) } catch { throw bad('not a Cardano address') }
  if (d.networkId !== 1 || d.type !== 'Base' || d.paymentCredential?.type !== 'Key' || d.stakeCredential?.type !== 'Key') throw bad('not a wallet address with a stake key')
  return { address: a, paymentKeyHash: d.paymentCredential.hash, stakeKeyHash: d.stakeCredential.hash }
}
function payAddress(a) {
  if (typeof a !== 'string' || a.length > 120 || !/^addr1[0-9a-z]+$/.test(a)) throw bad('not a Cardano address')
  try { const d = getAddressDetails(a); if (d.networkId !== 1 || !d.paymentCredential) throw 0 } catch { throw bad('not a mainnet Cardano address') }
  return a
}
function dustHex(mnDust) {
  if (typeof mnDust !== 'string' || mnDust.length > 120) throw bad('not a fee energy address')
  let b
  try { const d = bech32m.decode(mnDust, 200); if (d.prefix !== 'mn_dust') throw 0; b = Buffer.from(bech32m.fromWords(d.words)) } catch { throw bad('not a mainnet fee energy address') }
  if (b.length !== 33) throw bad('not a fee energy address')
  return b.toString('hex')
}
const bad = (m, status = 400) => Object.assign(new Error(m), { status })
const stakeAddress = (skh) => { // stake1…: header e1 + key hash, bech32
  const data = Buffer.concat([Buffer.from([0xe1]), Buffer.from(skh, 'hex')])
  const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  const words = []; let acc = 0, bits = 0
  for (const x of data) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31) } }
  if (bits) words.push((acc << (5 - bits)) & 31)
  const hrp = 'stake', exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31))
  let chk = 1
  for (const v of [...exp, ...words, 0, 0, 0, 0, 0, 0]) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i] }
  chk ^= 1
  return hrp + '1' + [...words, ...[0, 1, 2, 3, 4, 5].map((i) => (chk >> (5 * (5 - i))) & 31)].map((w) => CH[w]).join('')
}

// ---- live registrations: every unspent coin at the mapping contract, read from Kupo, kept for a few minutes ----
let regs = { at: 0, byStake: new Map(), count: 0, running: null }
const REGS_FRESH_MS = 4 * 60_000
function credOf(datumHex) {
  const m = /^d8799f(d8799f|d87a9f)581c([0-9a-f]{56})ff58([0-9a-f]{2})([0-9a-f]*)ff$/.exec(datumHex || '')
  if (!m || m[4].length !== parseInt(m[3], 16) * 2) return null
  return { key: m[1] === 'd8799f', hash: m[2], dust: m[4] }
}
async function sweep() {
  const r = await fetch(`${KUPO}/matches/${MAPPING_VALIDATOR}?unspent&resolve_hashes`, { signal: AbortSignal.timeout(90_000) })
  if (!r.ok) throw new Error(`kupo HTTP ${r.status}`)
  const rows = await r.json()
  const byStake = new Map(); let count = 0
  for (const m of rows) {
    if (Number(m.value?.assets?.[AUTH_POLICY]) !== 1) continue
    const c = credOf(m.datum); if (!c) continue
    count++
    const list = byStake.get(c.hash) ?? []; list.push({ dust: c.dust, tx: m.transaction_id, slot: Number(m.created_at?.slot_no) || null }); byStake.set(c.hash, list)
  }
  regs = { at: Date.now(), byStake, count, running: null }
  log(`registrations: ${count} live`)
}
/** `maxAgeMs`: how old the list may be for this use (a build wants it fresh; a status line does not). */
async function registrations(maxAgeMs) {
  if (Date.now() - regs.at > maxAgeMs) {
    regs.running ??= sweep().catch((e) => { regs.running = null; throw e })
    await regs.running
  }
  return regs
}
async function mappingsOf(skh, maxAgeMs) {
  const list = (await registrations(maxAgeMs)).byStake.get(skh) ?? []
  // at: when the registration landed on Cardano (unix seconds; mainnet slots are seconds since Shelley began)
  return list.map((x) => ({ dust: bech32m.encode('mn_dust', bech32m.toWords(Buffer.from(x.dust, 'hex')), 200), tx: x.tx, at: x.slot ? x.slot + SLOT_ZERO_UNIX : null }))
}
const SLOT_ZERO_UNIX = 1_591_566_291

// ---- what Midnight sees for a stake key (our own indexer; null when it does not answer) ----
// dustGenerations adds up every NIGHT coin of the stake key. (dustGenerationStatus, used here until 2026-11-23,
// reports ONE coin: an address holding two showed half its NIGHT as earning.)
async function midnightStatus(skh) {
  const q = `{dustGenerations(cardanoRewardAddresses:${JSON.stringify([stakeAddress(skh)])}){registrations{dustAddress valid nightBalance generationRate maxCapacity currentCapacity}}}`
  try {
    const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(8_000) })
    const j = await r.json()
    const all = j?.data?.dustGenerations?.[0]?.registrations
    if (!Array.isArray(all)) return null
    const s = all.find((x) => x?.valid) ?? null
    return s ? { registered: true, night: String(s.nightBalance ?? '0'), rate: String(s.generationRate ?? '0'), cap: String(s.maxCapacity ?? '0'), now: String(s.currentCapacity ?? '0'), dustAddress: s.dustAddress ?? null }
      : { registered: false, night: '0', rate: '0', cap: '0', now: '0', dustAddress: null }
  } catch { return null }
}

const totals = (utxos) => {
  let lovelace = 0n, night = 0n, adaOnly = 0n, other = 0
  for (const u of utxos) {
    lovelace += u.assets.lovelace
    night += u.assets[NIGHT_UNIT] ?? 0n
    const units = Object.keys(u.assets).filter((k) => k !== 'lovelace')
    if (!units.length) adaOnly += u.assets.lovelace
    other += units.filter((k) => k !== NIGHT_UNIT).length
  }
  return { lovelace, night, adaOnly, other }
}

async function state(q) {
  const me = addressOf(q.address)
  const dust = q.dust ? dustHex(q.dust) : null
  const [utxos, maps, midnight] = await Promise.all([provider.getUtxos(me.address), mappingsOf(me.stakeKeyHash, REGS_FRESH_MS), midnightStatus(me.stakeKeyHash)])
  const t = totals(utxos)
  const here = dust ? maps.filter((m) => dustHex(m.dust) === dust).length : 0
  return {
    lovelace: String(t.lovelace), night: String(t.night), adaOnly: String(t.adaOnly), coins: utxos.length, otherTokens: t.other,
    // none: not registered · here: registered to this wallet · elsewhere: to another fee energy address · double: more than one (earns nothing)
    mapped: maps.length === 0 ? 'none' : maps.length > 1 ? 'double' : here === 1 ? 'here' : 'elsewhere',
    mappings: maps, midnight, needsLovelace: String(NEEDS_LOVELACE), rewardAddress: stakeAddress(me.stakeKeyHash), asOf: regs.at,
    // the earliest registration there is for the stake key (unix seconds), and its transaction
    registeredAt: maps.reduce((a, m) => (m.at && (a === null || m.at < a) ? m.at : a), null), registeredTx: maps[0]?.tx ?? null,
  }
}

// ---- what happened on the address: every transaction that put a coin on it or spent one of its coins (our Kupo
// keeps spent coins with the transaction that spent them). Per transaction: what the address gained or lost in it,
// so what left includes the network fee. ----
// Anyone can ask about any address, and a busy one (an exchange's) has a history of many megabytes: the answer
// from Kupo is read with a limit and dropped beyond it; an address is looked up once at a time and its answer kept
// for a short while; only a few lookups run at once.
const ACTIVITY_MAX = 150
const ACTIVITY_MAX_BYTES = Number(process.env.CARDANO_DOOR_ACTIVITY_MAX_BYTES ?? 4_000_000), ACTIVITY_FRESH_MS = 20_000, ACTIVITY_AT_ONCE = 3
const activityOf = new Map()   // address -> { at, value } | { running }
let activityRunning = 0
async function readLimited(r, max) {
  const reader = r.body.getReader(), chunks = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) { await reader.cancel().catch(() => {}); throw bad('There is too much on this address to list', 413) }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
async function activity(q) {
  const me = addressOf(q.address)
  const hit = activityOf.get(me.address)
  if (hit?.value && Date.now() - hit.at < ACTIVITY_FRESH_MS) return hit.value
  if (hit?.running) return hit.running
  if (activityRunning >= ACTIVITY_AT_ONCE) throw bad('Busy right now: try again in a moment', 429)
  if (activityOf.size > 400) for (const [k, v] of activityOf) if (!v.running) activityOf.delete(k)
  activityRunning++
  const running = readActivity(me).then(
    (value) => { activityOf.set(me.address, { at: Date.now(), value }); return value },
    (e) => { activityOf.delete(me.address); throw e },
  ).finally(() => { activityRunning-- })
  activityOf.set(me.address, { running })
  return running
}
async function readActivity(me) {
  const r = await fetch(`${KUPO}/matches/${me.address}`, { signal: AbortSignal.timeout(40_000) })
  if (!r.ok) throw new Error(`kupo HTTP ${r.status}`)
  const rows = await readLimited(r, ACTIVITY_MAX_BYTES)
  if (!Array.isArray(rows)) throw new Error('kupo: not a list')
  const txs = new Map()
  const of = (id, slot) => { let t = txs.get(id); if (!t) { t = { tx: id, slot: Number(slot) || 0, lovelace: 0n, night: 0n, others: new Map() }; txs.set(id, t) } return t }
  const add = (t, value, sign) => {
    t.lovelace += sign * BigInt(value?.coins ?? 0)
    for (const [unit, v] of Object.entries(value?.assets ?? {})) {
      const key = unit.replace('.', '')
      if (key === NIGHT_UNIT) t.night += sign * BigInt(v)
      else t.others.set(key, (t.others.get(key) ?? 0n) + sign * BigInt(v))
    }
  }
  for (const m of rows) {
    if (typeof m?.transaction_id !== 'string' || !m.created_at) continue
    add(of(m.transaction_id, m.created_at.slot_no), m.value, 1n)
    if (typeof m.spent_at?.transaction_id === 'string') add(of(m.spent_at.transaction_id, m.spent_at.slot_no), m.value, -1n)
  }
  const regs = new Set((await mappingsOf(me.stakeKeyHash, REGS_FRESH_MS).catch(() => [])).map((m) => m.tx))
  const all = [...txs.values()].sort((a, b) => b.slot - a.slot)
  return {
    items: all.slice(0, ACTIVITY_MAX).map((t) => ({
      tx: t.tx, at: t.slot + SLOT_ZERO_UNIX, lovelace: String(t.lovelace), night: String(t.night),
      others: [...t.others.values()].filter((v) => v !== 0n).length, registration: regs.has(t.tx),
    })),
    more: all.length > ACTIVITY_MAX,
  }
}

// ---- builds ----
const built = new Map()   // id -> { tx, at, kind }
const remember = (tx, kind) => {
  const id = tx.toHash()
  for (const [k, v] of built) if (Date.now() - v.at > 15 * 60_000) built.delete(k)
  if (built.size > 500) built.clear()
  built.set(id, { tx, at: Date.now(), kind })
  return { cbor: tx.toCBOR(), id }
}

async function register(body) {
  const me = addressOf(body.address)
  const dust = dustHex(body.dust)
  // a second mapping for one stake key makes it ambiguous: Midnight then generates nothing for it
  const maps = await mappingsOf(me.stakeKeyHash, 45_000)
  if (maps.length) throw bad('This Cardano address is registered already', 409)
  const utxos = await provider.getUtxos(me.address)
  const t = totals(utxos)
  if (t.lovelace < NEEDS_LOVELACE) throw bad('Not enough ADA on the address yet', 409)
  const datum = Data.to(new Constr(0, [new Constr(0, [me.stakeKeyHash]), dust]))
  if (datum !== `d8799fd8799f581c${me.stakeKeyHash}ff5821${dust}ff`) throw new Error('datum encoder mismatch')
  const lucid = await Lucid(provider, 'Mainnet')
  lucid.selectWallet.fromAddress(me.address, utxos)
  let b = lucid.newTx()
    .mintAssets({ [AUTH_POLICY]: 1n }, CREATE)
    .attach.MintingPolicy(SCRIPT)
    .pay.ToContract(MAPPING_VALIDATOR, { kind: 'inline', value: datum }, { lovelace: LOVELACE_FOR_REGISTRATION, [AUTH_POLICY]: 1n })
    .addSignerKey(me.paymentKeyHash)
    .addSignerKey(me.stakeKeyHash)
  // Midnight only counts NIGHT coins created at or after the registration: every NIGHT coin is spent and made again, as one
  const nightUtxos = utxos.filter((u) => u.assets[NIGHT_UNIT])
  if (nightUtxos.length) b = b.collectFrom(nightUtxos).pay.ToAddress(me.address, { lovelace: NIGHT_COIN_LOVELACE, [NIGHT_UNIT]: t.night })
  let tx
  try { tx = await b.complete({ presetWalletInputs: utxos, changeAddress: me.address, setCollateral: COLLATERAL }) }
  catch (e) {
    const m = String(e?.message ?? e)
    log('register build failed:', m.slice(0, 200))
    throw bad(/collateral/i.test(m) ? 'Send about 5 ADA to the address in a transfer of its own (ADA only), then try again' : 'The registration could not be built right now', 409)
  }
  log(`register built ${tx.toHash().slice(0, 12)} for ${me.address.slice(0, 16)}… night ${t.night}`)
  return remember(tx, 'register')
}

async function moveout(body) {
  const me = addressOf(body.address)
  const to = payAddress(body.to)
  if (to === me.address) throw bad('That is this wallet\'s own address')
  const utxos = await provider.getUtxos(me.address)
  if (!utxos.length) throw bad('Nothing on the address', 409)
  const lucid = await Lucid(provider, 'Mainnet')
  lucid.selectWallet.fromAddress(me.address, utxos)
  let tx
  // every coin in, one output: the change, at the address the person entered
  try { tx = await lucid.newTx().collectFrom(utxos).complete({ presetWalletInputs: utxos, changeAddress: to }) }
  catch (e) { log('moveout build failed:', String(e?.message ?? e).slice(0, 200)); throw bad('The transfer could not be built right now', 409) }
  log(`moveout built ${tx.toHash().slice(0, 12)} from ${me.address.slice(0, 16)}…`)
  return remember(tx, 'moveout')
}

const amountOf = (v, what) => { if (typeof v !== 'string' || !/^\d{1,20}$/.test(v)) throw bad(`not an amount of ${what}`); return BigInt(v) }

/**
 * ADA or NIGHT from the address to `to`, the rest back to the address.
 *   ADA: out of the coins that hold nothing but ADA, so the coin with the NIGHT in it is left alone and keeps
 *        earning. lovelace "all" = everything in those coins (the fee comes out of it).
 *   NIGHT: the NIGHT coins are spent; NIGHT that stays comes back as one coin, 1.2 ADA travels with what leaves.
 */
async function send(body) {
  const me = addressOf(body.address)
  const to = payAddress(body.to)
  if (to === me.address) throw bad('That is this wallet\'s own address')
  const all = body.lovelace === 'all'
  const lovelace = all ? 0n : amountOf(body.lovelace ?? '0', 'ADA'), night = amountOf(body.night ?? '0', 'NIGHT')
  if ((all || lovelace > 0n) === (night > 0n)) throw bad('Send ADA or NIGHT, one at a time')
  const utxos = await provider.getUtxos(me.address)
  if (!utxos.length) throw bad('Nothing on the address', 409)
  const t = totals(utxos)
  const lucid = await Lucid(provider, 'Mainnet')
  const tries = []
  if (night > 0n) {
    if (night > t.night) throw bad('Not that much NIGHT on the address', 409)
    const nightUtxos = utxos.filter((u) => u.assets[NIGHT_UNIT])
    lucid.selectWallet.fromAddress(me.address, utxos)
    const base = () => lucid.newTx().collectFrom(nightUtxos).pay.ToAddress(to, { lovelace: NIGHT_SEND_LOVELACE, [NIGHT_UNIT]: night })
    // tidy first: the NIGHT that stays as a coin of its own beside the ADA; with little ADA about, it stays with the change
    if (t.night > night) tries.push(() => base().pay.ToAddress(me.address, { lovelace: NIGHT_COIN_LOVELACE, [NIGHT_UNIT]: t.night - night }).complete({ presetWalletInputs: utxos, changeAddress: me.address }))
    tries.push(() => base().complete({ presetWalletInputs: utxos, changeAddress: me.address }))
  } else {
    const plain = utxos.filter((u) => Object.keys(u.assets).every((k) => k === 'lovelace'))
    if (t.adaOnly === 0n) throw bad('No ADA on its own on the address: what is there travels with your NIGHT', 409)
    lucid.selectWallet.fromAddress(me.address, plain)
    if (all) tries.push(() => lucid.newTx().collectFrom(plain).complete({ presetWalletInputs: plain, changeAddress: to }))
    else {
      if (lovelace < MIN_SEND_LOVELACE) throw bad('Send at least 1 ADA')
      if (lovelace > t.adaOnly) throw bad('Not that much ADA on its own on the address', 409)
      tries.push(() => lucid.newTx().pay.ToAddress(to, { lovelace }).complete({ presetWalletInputs: plain, changeAddress: me.address }))
    }
  }
  let tx, why = ''
  for (const build of tries) { try { tx = await build(); break } catch (e) { why = String(e?.message ?? e) } }
  if (!tx) {
    log('send build failed:', why.slice(0, 200))
    throw bad(night > 0n ? 'Not enough ADA on the address to send NIGHT: about 1.5 ADA is needed besides it' : 'That leaves too little for the fee and the change: send a little less, or tap Max', 409)
  }
  log(`send built ${tx.toHash().slice(0, 12)} from ${me.address.slice(0, 16)}… ${night > 0n ? `night ${night}` : all ? 'all free ADA' : `lovelace ${lovelace}`}`)
  return remember(tx, 'send')
}

async function submit(body) {
  const b = built.get(String(body.id))
  if (!b || Date.now() - b.at > 15 * 60_000) throw bad('That transaction is no longer waiting here: start again', 410)
  if (typeof body.witness !== 'string' || !/^a100[0-9a-f]{100,600}$/.test(body.witness)) throw bad('not a witness set')
  let id
  try { id = await (await b.tx.assemble([body.witness]).complete()).submit() }
  catch (e) { const m = String(e?.message ?? e); log('submit failed:', m.slice(0, 300)); throw bad('Cardano did not accept the transaction', 502) }
  built.delete(String(body.id))
  if (b.kind === 'register') regs.at = 0   // the list is stale now
  log(`submitted ${b.kind} ${id}`)
  return { id }
}

// ---- http ----
const hits = new Map()
function allowed(kind, ip, perMin) {
  const now = Date.now(), k = kind + ip
  const h = (hits.get(k) ?? []).filter((t) => now - t < 60_000)
  if (h.length >= perMin) { hits.set(k, h); return false }
  h.push(now); hits.set(k, h)
  if (hits.size > 5000) hits.clear()
  return true
}
createServer(async (req, res) => {
  const reply = (status, obj) => { try { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)) } catch {} }
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    // static.mjs passes the real client on; only it (this machine) can reach this port
    const ip = String(req.headers['x-lump-client'] ?? req.socket.remoteAddress ?? '?')
    if (req.method === 'GET' && url.pathname === '/health') { reply(200, { ok: true, registrations: regs.count, asOf: regs.at }); return }
    if (req.method === 'GET' && url.pathname === '/state') {
      if (!allowed('s', ip, 40)) { reply(429, { error: 'Too many requests' }); return }
      reply(200, await state(Object.fromEntries(url.searchParams))); return
    }
    if (req.method === 'GET' && url.pathname === '/activity') {
      if (!allowed('a', ip, 20)) { reply(429, { error: 'Too many requests' }); return }
      reply(200, await activity(Object.fromEntries(url.searchParams))); return
    }
    if (req.method === 'POST' && ['/register', '/send', '/moveout', '/submit'].includes(url.pathname)) {
      if (!allowed('b', ip, BUILDS_PER_MIN)) { reply(429, { error: 'Too many requests' }); return }
      const chunks = []; let n = 0
      for await (const c of req) { n += c.length; if (n > 16_384) { reply(413, { error: 'too large' }); req.destroy(); return } chunks.push(c) }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { reply(400, { error: 'not JSON' }); return }
      if (!body || typeof body !== 'object') { reply(400, { error: 'not JSON' }); return }
      reply(200, await (url.pathname === '/register' ? register(body) : url.pathname === '/send' ? send(body) : url.pathname === '/moveout' ? moveout(body) : submit(body))); return
    }
    reply(404, { error: 'not found' })
  } catch (e) {
    if (e?.status) { reply(e.status, { error: e.message }); return }
    log('error', String(e?.message ?? e).slice(0, 300))
    reply(502, { error: 'The Cardano service is not answering right now' })
  }
}).listen(PORT, '127.0.0.1', () => { log(`cardano door on 127.0.0.1:${PORT} (kupo ${KUPO}, ogmios ${OGMIOS})`); registrations(0).catch((e) => log('first sweep failed:', e.message)) })
process.on('uncaughtException', (e) => console.error('uncaught', e?.message ?? e))
process.on('unhandledRejection', (e) => console.error('unhandled', e?.message ?? e))
