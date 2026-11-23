// Device hand-off: one device's synced wallet state for the owner's other devices, so a second device (a phone)
// continues where the first (a computer left running) has got to instead of reading the chain from the start.
//
// The state is the wallet's sync cache: viewing-side data (which notes are ours, the Merkle paths, the offsets), never
// the seed. It is encrypted HERE with AES-256-GCM under a key derived from the recovery phrase, and stored on the
// wallet server under an id derived from the same phrase. So only a device holding the same 24 words can find it,
// read it, or write one that another device would accept; the server holds ciphertext it cannot open or forge.
// Sharing is off until switched on in Settings (per device); looking for a hand-off needs no setting.
//
// Blob: [1] format version · [12] nonce · AES-GCM(ciphertext) with the version byte as additional data.
// Plaintext: [1] 1 = gzip, 0 = plain · JSON { v, saved, indexer, cache }.
import { mnemonicToSeedSync } from '@scure/bip39'
import { normalize, toHex } from './keys'
import { API_BASE } from './net'

/** The wallet's sync cache, as the session saves it on the device (src/core/wallet.ts). */
export type SyncCache = { shielded: string; unshielded: string; dust: string; history?: string; saved: string; indexer?: string; meta?: { dustCoins: number; night: string } }
export type HandoffKeys = { id: string; key: CryptoKey }
export type HandoffDoc = { v: 1; saved: string; indexer: string; cache: SyncCache }
export type Offsets = { shielded: bigint; dust: bigint }

const VERSION = 1
const SHARE_KEY = 'lump.handoff.share.v1'
const enc = (s: string) => new TextEncoder().encode(s)
const url = (id: string) => `${API_BASE}api/handoff/${id}`

export const sharingOn = (): boolean => { try { return localStorage.getItem(SHARE_KEY) === '1' } catch { return false } }
export function setSharing(on: boolean) { try { if (on) localStorage.setItem(SHARE_KEY, '1'); else localStorage.removeItem(SHARE_KEY) } catch {} }

/** The id the state is stored under and the key that locks it, both from the recovery phrase, each on its own HKDF label. */
export async function handoffKeys(mnemonic: string): Promise<HandoffKeys> {
  const seed = mnemonicToSeedSync(normalize(mnemonic))
  try {
    const base = await crypto.subtle.importKey('raw', seed as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits'])
    const salt = enc('lump-wallet-handoff')
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc('key-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const id = toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc('id-v1') }, base, 160)))
    return { id, key }
  } finally { seed.fill(0) }
}

const pipe = async (bytes: Uint8Array, through: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(through as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer())

async function seal(keys: HandoffKeys, doc: HandoffDoc): Promise<Uint8Array> {
  const json = enc(JSON.stringify(doc))
  let body = json, packed = 0
  if (typeof CompressionStream === 'function') { try { body = await pipe(json, new CompressionStream('gzip')); packed = 1 } catch { body = json } }
  const plain = new Uint8Array(body.length + 1)
  plain[0] = packed; plain.set(body, 1)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([VERSION]) }, keys.key, plain as BufferSource))
  const out = new Uint8Array(13 + ct.length)
  out[0] = VERSION; out.set(iv, 1); out.set(ct, 13)
  return out
}

/** null: not a hand-off this build reads, or not written with this wallet's key. */
async function unseal(keys: HandoffKeys, blob: Uint8Array): Promise<HandoffDoc | null> {
  try {
    if (blob.length < 29 || blob[0] !== VERSION) return null
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(1, 13), additionalData: new Uint8Array([VERSION]) }, keys.key, blob.slice(13) as BufferSource))
    const body = plain[0] === 1 ? await pipe(plain.slice(1), new DecompressionStream('gzip')) : plain.slice(1)
    const doc = JSON.parse(new TextDecoder().decode(body)) as HandoffDoc
    const c = doc?.cache
    if (doc?.v !== 1 || typeof doc.indexer !== 'string' || typeof c?.shielded !== 'string' || typeof c?.unshielded !== 'string' || typeof c?.dust !== 'string') return null
    return doc
  } catch { return null }
}

/** fetch with a deadline that also works on the older WebKit of wallet browsers (no AbortSignal.timeout there) */
async function ask(input: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(input, { ...init, signal: ac.signal, cache: 'no-store' }) } finally { clearTimeout(t) }
}

/**
 * What the server holds for this wallet. 'same': still the one with `seenTag`. null: nothing there, not reachable, or
 * not readable; all the same to the caller, which then simply carries on by itself.
 */
export async function fetchHandoff(keys: HandoffKeys, seenTag: string | null, ms = 9_000): Promise<{ tag: string; doc: HandoffDoc } | 'same' | null> {
  try {
    const r = await ask(url(keys.id), { headers: seenTag ? { 'if-none-match': seenTag } : {} }, ms)
    if (r.status === 304) return 'same'
    if (r.status !== 200) return null
    const tag = r.headers.get('etag') ?? ''
    const doc = await unseal(keys, new Uint8Array(await r.arrayBuffer()))
    return doc ? { tag, doc } : null
  } catch { return null }
}

/** Store this device's state for the others; resolves with the stored copy's tag, or throws with a short reason. */
export async function putHandoff(keys: HandoffKeys, indexer: string, cache: SyncCache): Promise<{ tag: string; bytes: number }> {
  const blob = await seal(keys, { v: 1, saved: cache.saved, indexer, cache })
  const r = await ask(url(keys.id), { method: 'PUT', body: blob as BodyInit, headers: { 'content-type': 'application/octet-stream' } }, 31_000)
  if (!r.ok) throw new Error(r.status === 429 ? 'too many tries, wait a minute' : r.status === 413 ? 'too large to share' : `the server answered ${r.status}`)
  return { tag: r.headers.get('etag') ?? '', bytes: blob.length }
}

/** How far a cache has read: the event ids its private and fee-energy sides stand at. null: not readable. */
export function offsetsOf(cache: Pick<SyncCache, 'shielded' | 'dust'> | null): Offsets | null {
  if (!cache) return null
  try {
    const at = (s: string) => BigInt(String(JSON.parse(s).offset ?? 0))
    return { shielded: at(cache.shielded), dust: at(cache.dust) }
  } catch { return null }
}

/** `a` is nowhere behind `b`, and at least `margin` events further in all. */
export function ahead(a: Offsets, b: Offsets, margin: bigint): boolean {
  return a.shielded >= b.shielded && a.dust >= b.dust && (a.shielded - b.shielded) + (a.dust - b.dust) >= margin
}
