// NFTs on Midnight, as this wallet finds and reads them.
//
// An NFT is a native token (public or private lane) with a supply of one whose collection contract keeps a display
// record for it in its public state. There is one layout in use on mainnet for that state, and this reads it:
//   field 0   the collection's name
//   field 1   a map: token type (32 bytes) -> record
//   next map  token type -> supply (an entry that is not 1 means "not an NFT")
// A record is twelve values: name (32 bytes), then four optional fields each led by a flag (symbol 10, decimals 1,
// description 256, image 256, media type 32), then a version. A token with decimals is a coin, not an NFT.
// A blind mint writes a placeholder record at mint and the real one at the reveal, so records are re-read.
//
// Which contract belongs to a token type: a token type does not name its contract, so the wallet looks at
//   1. what it remembered from earlier,
//   2. the contracts its own transactions that brought the token in called to MINT (a mint names its collection),
//   3. the collections listed below.
// A contract is accepted for a token only when its record map holds that token type. Nothing here is trusted
// beyond display: names and pictures are whatever the contract's deployer wrote.
//
// WRAPPED NFTS OF ANOTHER CHAIN (2026-11-24): a contract can hold, beside the layout above, which Cardano asset each
// of its tokens stands for (the NFT itself waits in a vault on Cardano while the token exists here). Such a token
// is minted by the contract's operator, not by the holder, through an entry point named "wrap", and its type
// follows from the contract's address and the asset's name (wrappedItemType): that is the proof the contract
// issued it, and it is what lets the wallet say where the NFT comes from.
//
// WHERE THE DATA COMES FROM, and why (2026-11-21):
//   - A contract's state is read from the NODE (midnight_contractState, through the node door the wallet already
//     uses): a direct read of the current state, tens of milliseconds.
//   - It is NEVER asked of the indexer. `contractAction(address){ state }` makes indexer 4.4 rebuild the state of a
//     contract nobody touched since the ledger-9 fork, which takes minutes, and a few of those at once stop the
//     whole indexer answering (it happened twice on 2026-11-21 with the first version of this file, which asked for
//     every contract in the wallet's history, in parallel).
//   - The indexer is asked one light thing only: which contracts a transaction called, and by which entry point
//     (no state). One question at a time, a few per pass, and a token nobody claims is not asked about again for hours.
import * as ledger from '@midnightntwrk/ledger-v9'
import { sha256 } from '@noble/hashes/sha2.js'
import { KNOWN } from './tokens'

export type Lane = 'public' | 'private'
export type NftRecord = { name: string; symbol?: string; decimals?: number; description?: string; image?: string; mediaType?: string }
/**
 * The NFT on another chain that a token stands for. Shown only when the token's type proves the collection contract
 * issued it for that asset; `policy` is what that contract states (a listed collection is one this wallet has matched to its project).
 */
export type Origin = { chain: 'cardano'; /** asset name: as text when it is plain text, else its hex */ asset: string; /** asset name, hex */ assetHex: string; /** policy id, 56 hex */ policy?: string }
export type Collection = {
  contract: string; name: string; records: Map<string, NftRecord>; supply: Map<string, bigint>
  /** wrapped NFTs only: token type -> the asset name it stands for (32 bytes, zero-padded) and that name's length */
  origins?: Map<string, { name: Uint8Array; length: number }>
  /** wrapped NFTs only: the policy id the contract states, 56 hex */
  policy?: string
}
export type Nft = {
  /** token type, 64 hex */
  type: string
  lane: Lane
  /** collection contract address, 64 hex */
  contract: string
  collection: string
  name: string
  symbol?: string
  description?: string
  image?: string
  mediaType?: string
  /** the collection is on this wallet's own list (see LISTED) */
  listed: boolean
  /** a wrapped NFT of another chain: what it stands for there (proven by the token's type) */
  origin?: Origin
}

/**
 * Collections this wallet always checks, so their NFTs show even when they arrived by a plain transfer (no mint of
 * ours to learn the contract from). `checked`: the contract was matched to the project by us.
 */
export const LISTED: ReadonlyArray<{ contract: string; checked: boolean }> = [
  // Midnight Punks
  { contract: '430a881cc0724b131e25728ac09427219752d1f326e2245f56e6b8db190af97f', checked: true },
  // Midnight Station: The Quiet Embassy, Hologrid Runners (public), Hologrid Runners (private)
  { contract: 'ee7b3a9599fe37ebf53e65c6f86f8f382cfc6a851fd0b6b8b457eda0b40dfb12', checked: true },
  { contract: '10092000e25dfaa9f606ffb6d80ed9ebf2f145271375bc4cf01a7552ecacc16e', checked: true },
  { contract: '1521a84470951f89eb6afb142e64b1b3d67cb464e43d48af361edc0ecf1bbdc1', checked: true },
  // Cardano NFTs, each held in a vault on Cardano while its token exists here: Chilled Kongs (Cardano), Magic Kongs (Cardano)
  { contract: 'afccb0f2379d76b1f0c7f595fae9f72ecca3a74888b27e8b1bdc7df7edd3818e', checked: true },
  { contract: '58891eeb312deb120f30b210610a44eabc773f595ad7f8114433d61e25bf2655', checked: true },
]
const listedSet = new Set(LISTED.map((l) => l.contract))
export const isChecked = (contract: string) => LISTED.some((l) => l.contract === contract && l.checked)

const HEX64 = /^[0-9a-f]{64}$/
/** widths of the twelve values of a record */
const WIDTHS = [32, 1, 10, 1, 1, 1, 256, 1, 256, 1, 32, 2]
/** contracts read per pass (each is one small node read) */
const MAX_CONTRACTS = 17
/** transaction look-ups per pass, and the pause between two of them */
const MAX_HINT_TXS = 7
const HINT_GAP_MS = 230
/** a token type no contract claimed is looked up again only after this long */
const MISS_RETRY_MS = 6 * 3_600_000

const utf8 = new TextDecoder('utf-8', { fatal: false })
/** zero-padded UTF-8, with control characters and direction overrides removed (a name is a stranger's text) */
function text(bytes: Uint8Array): string {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  // eslint-disable-next-line no-control-regex
  return utf8.decode(bytes.subarray(0, end)).replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩�]/g, '').trim()
}
const flag = (b: Uint8Array) => b.length > 0 && b[0] !== 0
const num = (b: Uint8Array) => b.reduceRight((n, x) => n * 256n + BigInt(x), 0n)
const hex = (b: Uint8Array, width = 32) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').padEnd(width * 2, '0')
const fromHex = (h: string) => { const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return out }

function readRecord(cell: ledger.StateValue | undefined): NftRecord | null {
  if (!cell || cell.type() !== 'cell') return null
  const a = cell.asCell().value.map((x) => Uint8Array.from(x))
  if (a.length !== WIDTHS.length || a.some((x, i) => x.length > WIDTHS[i])) return null
  const optional = (i: number) => (flag(a[i]) ? text(a[i + 1]) || undefined : undefined)
  return {
    name: text(a[0]),
    symbol: optional(1),
    decimals: flag(a[3]) ? Number(num(a[4])) : undefined,
    description: optional(5),
    image: optional(7),
    mediaType: optional(9),
  }
}

/** A contract's public state read as a collection, or null when it is not in that layout. */
export function readCollection(contract: string, stateHex: string): Collection | null {
  let top: ledger.StateValue[] | undefined
  try {
    const cs = ledger.ContractState.deserialize(fromHex(stateHex)) as unknown as { data: { state?: ledger.StateValue } & ledger.StateValue }
    const root = cs.data.state ?? cs.data
    top = root.type() === 'array' ? root.asArray() : undefined
  } catch { return null }
  if (!top || top.length < 2) return null
  let name = ''
  try { name = top[0].type() === 'cell' ? text(Uint8Array.from(top[0].asCell().value[0] ?? [])) : '' } catch {}
  const mapAt = (i: number) => (top![i].type() === 'map' ? top![i].asMap() : undefined)
  // field 1 when it is a map, else the first map from field 2 on that holds anything
  let slot = mapAt(1) ? 1 : -1
  for (let i = 2; slot < 0 && i < top.length; i++) if ((mapAt(i)?.keys().length ?? 0) > 0) slot = i
  if (slot < 0) return null
  const records = new Map<string, NftRecord>()
  const map = mapAt(slot)!
  for (const key of map.keys()) {
    const r = readRecord(map.get(key))
    if (r) records.set(hex(Uint8Array.from(key.value[0] ?? [])), r)
  }
  if (records.size === 0) return null
  const supply = new Map<string, bigint>()
  let supplyAt = -1
  for (let i = slot + 1; i < top.length; i++) {
    const m = mapAt(i)
    if (!m) continue
    for (const key of m.keys()) {
      try { const v = m.get(key); if (v?.type() === 'cell') supply.set(hex(Uint8Array.from(key.value[0] ?? [])), num(Uint8Array.from(v.asCell().value[0] ?? []))) } catch { /* not a count */ }
    }
    supplyAt = i
    break
  }
  const col: Collection = { contract, name, records, supply }
  // A contract of wrapped NFTs goes on: the field after the supply map is the policy id (28 bytes) and the next MAP
  // says, for each token type, which asset it stands for: asset name (32 bytes), its length, and where the NFT is
  // locked (a transaction, 32 bytes, and an output number). Read only when every entry has exactly that shape.
  try {
    for (let i = supplyAt + 1; supplyAt > 0 && i < top.length; i++) {
      const m = mapAt(i)
      if (!m) continue
      const origins = new Map<string, { name: Uint8Array; length: number }>()
      let shaped = true
      for (const key of m.keys()) {
        const v = m.get(key)
        const a = v?.type() === 'cell' ? v.asCell().value.map((x) => Uint8Array.from(x)) : null
        const length = a && a[1] ? (a[1].length === 0 ? 0 : a[1][0]) : -1
        if (!a || a.length !== 4 || a[0].length > 32 || a[1].length > 1 || a[2].length > 32 || a[3].length > 2 || length > 32 || a[0].length > length) { shaped = false; break }
        const padded = new Uint8Array(32)
        padded.set(a[0])
        origins.set(hex(Uint8Array.from(key.value[0] ?? [])), { name: padded, length })
      }
      if (shaped && origins.size > 0) {
        col.origins = origins
        const p = top[supplyAt + 1]
        const bytes = p?.type() === 'cell' ? Uint8Array.from(p.asCell().value[0] ?? []) : null
        if (bytes && bytes.length > 0 && bytes.length <= 28) col.policy = hex(bytes, 28)
      }
      break   // only the first map after the supply map can be it
    }
  } catch { /* not such a contract */ }
  return col
}

/**
 * The token type of the wrapped NFT that stands for the asset `name` (32 bytes, zero-padded; `length` of them count)
 * under a contract of wrapped Cardano NFTs: domain = SHA-256(pad32("cardano-nft-shield:item:v1") || name || length as
 * 32 bytes little-endian), type = the ledger's token type of that domain and the contract's address.
 * test/origin-id.mjs checks it against the ones on mainnet. A type that matches is proof the contract issued the
 * token for that asset name: no other address and no other name give it.
 */
const WRAP_TAG = (() => { const b = new Uint8Array(32); b.set(new TextEncoder().encode('cardano-nft-shield:item:v1')); return b })()
export function wrappedItemType(contract: string, name: Uint8Array, length: number): string {
  const data = new Uint8Array(96)
  data.set(WRAP_TAG)
  data.set(name.subarray(0, 32), 32)
  data[64] = length
  return String(ledger.rawTokenType(sha256(data), contract)).toLowerCase()
}

/** What a token stands for on Cardano, when `col` says so AND the token's type proves it; else undefined. */
export function originOf(col: Collection, type: string): Origin | undefined {
  const o = col.origins?.get(type)
  if (!o) return undefined
  try { if (wrappedItemType(col.contract, o.name, o.length) !== type) return undefined } catch { return undefined }
  const bytes = o.name.subarray(0, o.length)
  const assetHex = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('')
  const plain = bytes.length > 0 && bytes.every((x) => x >= 0x20 && x <= 0x7e)
  return { chain: 'cardano', asset: plain ? utf8.decode(bytes) : assetHex, assetHex, ...(col.policy ? { policy: col.policy } : {}) }
}

/**
 * The token type of item `index` (from 0) of a collection contract, by the item scheme of the Midnight NFT standard
 * that Midnight Station's collections use: domain = SHA-256(pad32("midnight-station:item:v1") || index as 32 bytes little-endian),
 * type = the ledger's token type of that domain and the contract's address. test/item-id.mjs checks it against
 * items on mainnet. A type that matches is proof the contract issued the token: no other address gives it.
 */
const ITEM_TAG = (() => { const b = new Uint8Array(32); b.set(new TextEncoder().encode('midnight-station:item:v1')); return b })()
export function stationItemType(contract: string, index: number): string {
  const data = new Uint8Array(64)
  data.set(ITEM_TAG)
  for (let i = 0, v = index; i < 4; i++, v = Math.floor(v / 256)) data[32 + i] = v % 256
  return String(ledger.rawTokenType(sha256(data), contract)).toLowerCase()
}
/** item numbers tried per contract when proving (a collection larger than this still shows by its mints) */
const MAX_ITEM_NUMBER = 2_048

/**
 * Markets whose register of collections the wallet reads, so an item bought there is found even when the wallet
 * never saw its collection before. A registered collection is only a candidate: it names a token on proof alone.
 */
export const MARKETS: ReadonlyArray<string> = [
  // Midnight Station
  '68970fe177419f2dd91da1041778d897825511a370efb6cbb9187b95ceba732a',
]
const MAX_REGISTERED = 11
/** The contract addresses a market's register holds: the keys of the first map of its state whose keys are all 32 bytes. */
export function registeredCollections(stateHex: string): string[] {
  try {
    const cs = ledger.ContractState.deserialize(fromHex(stateHex)) as unknown as { data: { state?: ledger.StateValue } & ledger.StateValue }
    const flat: ledger.StateValue[] = []
    const walk = (v: ledger.StateValue, depth: number) => { if (v.type() === 'array' && depth < 3) for (const x of v.asArray()!) walk(x, depth + 1); else flat.push(v) }
    walk(cs.data.state ?? cs.data, 0)
    for (const v of flat) {
      if (v.type() !== 'map') continue
      const keys = v.asMap()!.keys().map((k) => Uint8Array.from(k.value[0] ?? []))
      if (keys.length > 0 && keys.every((k) => k.length === 32)) return keys.map((k) => hex(k))
      if (keys.length > 0) return []
    }
  } catch { /* not readable: no candidates */ }
  return []
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The contracts a transaction called to bring a token into being, from the indexer: called to MINT (or deployed:
 * some collections mint in their deploy), or called to WRAP (an operator issuing the token of an NFT held on another
 * chain). `mint` says which: a contract called to mint names its collection as before, one called to wrap may name
 * a token only when the token's type proves it (see resolveNfts). No other entry point is looked at, so the wallet
 * never reads the state of a contract that merely moved a token.
 * A light question: addresses and entry point names, no state. Null when the indexer did not answer.
 */
export async function contractsOfTx(indexerUrl: string, hash: string): Promise<Array<{ contract: string; mint: boolean }> | null> {
  let data: { transactions?: Array<{ contractActions?: Array<{ __typename: string; address: string; entryPoint?: string }> }> } | null = null
  try {
    const r = await fetch(indexerUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(11_000),
      body: JSON.stringify({ query: 'query($h: HexEncoded!){ transactions(offset:{hash:$h}){ contractActions{ __typename address ... on ContractCall { entryPoint } } } }', variables: { h: hash } }),
    })
    if (!r.ok) return null
    const j = await r.json()
    if (j?.errors?.length) return null
    data = j?.data ?? null
  } catch { return null }
  if (!data) return null
  const out = new Map<string, boolean>()
  for (const t of data.transactions ?? []) for (const a of t.contractActions ?? []) {
    const c = String(a.address).toLowerCase()
    if (!HEX64.test(c)) continue
    const entry = String(a.entryPoint ?? '')
    if (a.__typename === 'ContractDeploy' || /mint/i.test(entry)) out.set(c, true)
    else if (/wrap/i.test(entry) && !out.has(c)) out.set(c, false)
  }
  // the ones called to mint first
  return [...out].map(([contract, mint]) => ({ contract, mint })).sort((a, b) => Number(b.mint) - Number(a.mint))
}

/** The contracts a transaction called to mint (or deployed). Null when the indexer did not answer. */
export const mintContractsOfTx = async (indexerUrl: string, hash: string): Promise<string[] | null> => (await contractsOfTx(indexerUrl, hash))?.filter((c) => c.mint).map((c) => c.contract) ?? null

/**
 * Reads contracts' current public state from the node, one after another over one connection.
 * `get(contract)` resolves with the state as hex, or null (no such contract, no answer in time, connection gone).
 */
export function nodeStates(nodeWs: string): { get(contract: string): Promise<string | null>; close(): void } {
  let ws: WebSocket | null = null
  let opening: Promise<WebSocket | null> | null = null
  let seq = 0
  const waiting = new Map<number, (v: string | null) => void>()
  const fail = () => { for (const r of waiting.values()) r(null); waiting.clear() }
  const open = () => (opening ??= new Promise<WebSocket | null>((resolve) => {
    let sock: WebSocket
    try { sock = new WebSocket(nodeWs) } catch { resolve(null); return }
    const timer = setTimeout(() => { try { sock.close() } catch {} resolve(null) }, 9_000)
    sock.onopen = () => { clearTimeout(timer); ws = sock; resolve(sock) }
    sock.onerror = () => { clearTimeout(timer); resolve(null) }
    sock.onclose = () => { ws = null; fail() }
    sock.onmessage = (m) => {
      try { const j = JSON.parse(String(m.data)); const r = waiting.get(j.id); if (r) { waiting.delete(j.id); r(typeof j.result === 'string' ? j.result.replace(/^0x/i, '').toLowerCase() : null) } } catch {}
    }
  }))
  let chain: Promise<unknown> = Promise.resolve()
  return {
    get: (contract) => {
      const run = chain.then(async () => {
        const sock = await open()
        if (!sock || sock.readyState !== WebSocket.OPEN) return null
        const id = ++seq
        return new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => { waiting.delete(id); resolve(null) }, 9_000)
          waiting.set(id, (v) => { clearTimeout(timer); resolve(v) })
          try { sock.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'midnight_contractState', params: [contract] })) } catch { waiting.delete(id); clearTimeout(timer); resolve(null) }
        })
      })
      chain = run.catch(() => null)
      return run
    },
    close: () => { try { ws?.close() } catch {} ws = null; fail() },
  }
}

// ---- what the wallet remembers between sessions (public facts only: token type -> contract, and the last records) ----
// v2 (2026-11-21): builds before cf30c4a remembered a contract for tokens it merely held a record for, which is no
// proof it minted them. Those memos (and the names cached from them) are dropped once and rebuilt from the tokens'
// own mints. The hidden list is the person's own choice and stays.
const MEMO_KEY = 'lump.nft.contracts.v2', CACHE_KEY = 'lump.nft.cache.v2', HIDDEN_KEY = 'lump.nft.hidden.v1', MISS_KEY = 'lump.nft.misses.v2'
const OLD_KEYS = ['lump.nft.contracts.v1', 'lump.nft.cache.v1', 'lump.nft.misses.v1']
try { for (const k of OLD_KEYS) localStorage.removeItem(k) } catch { /* no storage: nothing saved either */ }
const readJson = <T,>(key: string, fallback: T): T => { try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return v ?? fallback } catch { return fallback } }
const writeJson = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)) } catch {} }

export const loadCachedNfts = (): Nft[] => { const v = readJson<Nft[]>(CACHE_KEY, []); return Array.isArray(v) ? v.filter((n) => n && HEX64.test(n.type) && HEX64.test(n.contract)) : [] }
export const loadHidden = (): Set<string> => new Set(readJson<string[]>(HIDDEN_KEY, []))
export function setHidden(type: string, hidden: boolean) {
  const s = loadHidden()
  if (hidden) s.add(type); else s.delete(type)
  writeJson(HIDDEN_KEY, [...s])
}
export function forgetNfts() { for (const k of [MEMO_KEY, CACHE_KEY, HIDDEN_KEY, MISS_KEY, ...OLD_KEYS]) { try { localStorage.removeItem(k) } catch {} } }

/** Token types held in exactly one unit that are not a known coin: the only ones that can be NFTs. */
export function candidates(unshielded: Map<string, bigint>, shielded: Map<string, bigint>): Array<{ type: string; lane: Lane }> {
  const out: Array<{ type: string; lane: Lane }> = []
  for (const [lane, m] of [['public', unshielded], ['private', shielded]] as const) {
    for (const [type, v] of m) if (v === 1n && !KNOWN[type] && HEX64.test(type)) out.push({ type, lane })
  }
  return out
}

/**
 * The NFTs among `held`. `txHashesOf(type)`: the wallet's own transactions that brought that token type in, newest
 * first (may be empty). Contract state comes from the node; the indexer is only asked which contracts a few of those
 * transactions called to mint. A token no contract claims is not returned.
 * `nfts` is also what loadCachedNfts() returns next time. `more`: another pass soon may find more (the look-ups ran
 * out, or a token's transaction is not in the history yet).
 */
export async function resolveNfts(net: { nodeWs: string; indexerUrl: string }, held: Array<{ type: string; lane: Lane }>, txHashesOf: (type: string) => string[], opts: { proofs?: boolean; /** false: as a wallet with no list and no market (tests) */ lists?: boolean } = {}): Promise<{ nfts: Nft[]; more: boolean }> {
  if (held.length === 0) { writeJson(CACHE_KEY, []); return { nfts: [], more: false } }
  const memo = readJson<Record<string, string>>(MEMO_KEY, {})
  const misses = readJson<Record<string, number>>(MISS_KEY, {})
  const node = nodeStates(net.nodeWs)
  const read = new Map<string, Collection | null>()   // null: read, not a collection; absent from the map: no answer
  const collection = async (contract: string): Promise<Collection | null | undefined> => {
    if (read.has(contract)) return read.get(contract)
    if (read.size >= MAX_CONTRACTS) return undefined
    const state = await node.get(contract)
    if (state === null) return undefined
    const c = readCollection(contract, state)
    read.set(contract, c)
    return c
  }
  const out: Nft[] = []
  const unanswered = new Set<string>()
  const claim = (h: { type: string; lane: Lane }, col: Collection): boolean => {
    const r = col.records.get(h.type)
    if (!r) return false
    const count = col.supply.get(h.type)
    if (r.decimals !== undefined || (count !== undefined && count !== 1n)) return false
    memo[h.type] = col.contract
    delete misses[h.type]
    const origin = originOf(col, h.type)
    out.push({ type: h.type, lane: h.lane, contract: col.contract, collection: col.name, name: r.name || 'Untitled', symbol: r.symbol, description: r.description, image: r.image, mediaType: r.mediaType, listed: listedSet.has(col.contract), ...(origin ? { origin } : {}) })
    return true
  }
  let more = false
  // PROOF that a contract issued a token: the token's type follows from the contract's address and the item's number
  // (stationItemType). Nobody can make another contract's address give the same type, so a contract that passes may
  // name the token however the wallet came across it: bought on a market, sent by a friend, or minted beside it.
  const issued = new Map<string, Set<string>>()
  const proves = (col: Collection, type: string): boolean => {
    if (opts.proofs === false || !col.records.has(type)) return false
    // a wrapped NFT: the contract says which asset the token stands for, and the type follows from that name
    if (originOf(col, type)) return true
    let set = issued.get(col.contract)
    if (!set) { set = new Set(); try { for (let i = 0; i < MAX_ITEM_NUMBER; i++) set.add(stationItemType(col.contract, i)) } catch { /* no proof to be had */ } issued.set(col.contract, set) }
    return set.has(type)
  }
  try {
    let open = [...held]
    // 1. the listed collections, 2. remembered contracts.
    // Any contract can write a record under any token type. So only a listed collection may claim whatever it holds
    // a record for; any other contract claims a token when that token's own mint named it (remembered from step 4,
    // which checks just that) or when the token's type proves the contract issued it. Otherwise a contract that
    // minted one token to this wallet could put its names and pictures on the others.
    const lists = opts.lists !== false
    for (const contract of [...(lists ? LISTED.map((l) => l.contract) : []), ...new Set(open.map((h) => memo[h.type]).filter((c): c is string => !!c && HEX64.test(c)))]) {
      if (open.length === 0) break
      const col = await collection(contract)
      if (col === undefined) { unanswered.add(contract); continue }
      const any = lists && listedSet.has(contract)
      if (col) open = open.filter((h) => !((any || memo[h.type] === contract || proves(col, h.type)) && claim(h, col)))
    }
    // 3. the collections a known market trades (its register), for an item bought there: accepted on proof only
    for (const market of open.length > 0 && opts.proofs !== false && lists ? MARKETS : []) {
      const state = read.size < MAX_CONTRACTS ? await node.get(market) : null
      for (const contract of state ? registeredCollections(state).slice(0, MAX_REGISTERED) : []) {
        if (open.length === 0) break
        if (read.has(contract)) continue
        const col = await collection(contract)
        if (col) open = open.filter((h) => !(proves(col, h.type) && claim(h, col)))
      }
    }
    // 4. what the mint transactions say, for tokens still unexplained and not looked up lately
    let lookups = 0
    const now = Date.now()
    for (const h of [...open]) {
      if (!open.includes(h)) continue   // claimed along with another item of its collection, a moment ago
      if (misses[h.type] && now - misses[h.type] < MISS_RETRY_MS) continue
      if (lookups >= MAX_HINT_TXS) { more = true; break }
      let answered = true, claimed = false
      for (const hash of txHashesOf(h.type).slice(0, 2)) {
        if (lookups >= MAX_HINT_TXS) { answered = false; more = true; break }
        if (lookups++ > 0) await sleep(HINT_GAP_MS)
        const contracts = await contractsOfTx(net.indexerUrl, hash)
        if (!contracts) { answered = false; continue }
        for (const { contract, mint } of contracts) {
          const col = await collection(contract)
          if (col === undefined) { answered = false; continue }
          // called to mint: it names its token, as before. Called to wrap: only on the proof that it issued the token.
          if (col && (mint || proves(col, h.type)) && claim(h, col)) {
            claimed = true
            // its other items that the type proves are its own come with it, without a look-up each
            open = open.filter((x) => x === h || !(proves(col, x.type) && claim(x, col)))
            break
          }
        }
        if (claimed) break
      }
      if (claimed) open = open.filter((x) => x.type !== h.type)
      // no transaction known for it yet (the history is still catching up): nothing was asked, ask again soon
      else if (txHashesOf(h.type).length === 0) more = true
      // every question was answered and nobody claims it
      else if (answered) misses[h.type] = now
    }
  } finally {
    node.close()
  }
  // a contract that did not answer this time must not make its NFTs vanish: keep what was known for them, but only
  // while that contract is still the one allowed to name the token (listed, or remembered from the token's own mint)
  for (const old of loadCachedNfts()) {
    const still = held.find((h) => h.type === old.type)
    const allowed = listedSet.has(old.contract) || memo[old.type] === old.contract
    if (still && allowed && !out.some((n) => n.type === old.type) && (unanswered.has(old.contract) || !read.has(old.contract))) out.push({ ...old, lane: still.lane, listed: listedSet.has(old.contract) })
  }
  out.sort((a, b) => a.collection.localeCompare(b.collection) || a.name.localeCompare(b.name, undefined, { numeric: true }))
  const heldTypes = new Set(held.map((h) => h.type))
  writeJson(MEMO_KEY, Object.fromEntries(Object.entries(memo).filter(([t]) => heldTypes.has(t))))
  writeJson(MISS_KEY, Object.fromEntries(Object.entries(misses).filter(([t]) => heldTypes.has(t))))
  writeJson(CACHE_KEY, out)
  return { nfts: out, more }
}

// ---- pictures ----
/** Gateways that serve IPFS content as plain web pictures, in the order they are tried. */
const GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.filebase.io/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/']
const INLINE = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i

export type Picture =
  | { kind: 'ipfs'; urls: string[] }
  /** carried in the record itself */
  | { kind: 'inline'; url: string }
  /** an ordinary web address: loading it tells that server this wallet looked, so it waits for a tap */
  | { kind: 'web'; url: string }

export function pictureOf(image: string | undefined): Picture | null {
  if (!image) return null
  if (INLINE.test(image)) return { kind: 'inline', url: image }
  let path: string | null = null
  const m = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(image) ?? /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(image)
  if (m) path = m[1]
  else if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})(\/.*)?$/.test(image)) path = image
  if (path) {
    // a content address and a path, nothing else: no query, no fragment, no dot segments
    const clean = path.split(/[?#]/)[0]
    if (!/^[A-Za-z0-9]+(\/[A-Za-z0-9._~%\-]+)*\/?$/.test(clean) || clean.split('/').some((s) => s === '.' || s === '..')) return null
    return { kind: 'ipfs', urls: GATEWAYS.map((g) => g + clean) }
  }
  try { const u = new URL(image); if (u.protocol === 'https:') return { kind: 'web', url: u.href } } catch {}
  return null
}
