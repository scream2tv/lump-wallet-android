// On-device vault: the recovery phrase under two locks.
//
//   1. the PIN: scrypt(PIN) -> AES-256-GCM over the phrase. A 6-digit PIN alone is one million tries.
//   2. the device key (core/device.ts): AES-256-GCM over the result of 1, with a key that lives only on this device
//      (the iPhone Keychain, "this device only"). Without it the stored blob cannot even be tried against a PIN, so a
//      copy of the app's data (a backup, a file pulled off the phone) is worth nothing.
//
// Format v2 is both locks; v1 (PIN only, before 2026-11-22) is read and rewritten as v2 at the next unlock, and the
// v1 blob is replaced only after the v2 one was read back and opened. Unlocking also yields a second key (HKDF from
// the same scrypt output) that encrypts the cached sync state in IndexedDB. The PIN is never stored. With Face ID
// on, the scrypt output is kept in the Keychain behind the face (core/device.ts): the phrase still needs the device
// key as well.
//
// A vault whose device key is missing (the app's data restored from a backup, or moved to another phone) cannot be
// opened by anything: VaultMoved, and the wallet is restored from the 24 words. That is the point of the second lock.
//
// SEVERAL WALLETS (2026-11-22). One PIN and one device key for all of them; each wallet is a blob of its own with
// its own phrase. The first wallet's blob stays where it has always been (lump.vault.v1) and is never rewritten for
// this: a device from before simply has one wallet. Further wallets are stored beside it (core/scope.ts), under
// the same salt, so the keys of one unlock open every one of them; a small index holds their names, which one is in
// use, and the next free id. While the app is unlocked it keeps those keys (they cannot be exported, and the PIN is
// not among them), so switching and adding need no second PIN; locking drops them.
import { scrypt } from '@noble/hashes/scrypt.js'
import { createDeviceKey, deviceStore, loadDeviceKey, readBiometricSecret, removeBiometricSecret, removeBrowserDeviceKey, removeDeviceKey, saveBiometricSecret, type DeviceStore } from './device'
import { pinFailed, pinOk, pinWaitMs } from './attempts'
import { forgetLockSettings, lockSettings, saveLockSettings } from './lock'
import { FIRST, forgetAllScoped, forgetScoped, isWalletId, scoped } from './scope'

const KEY = 'lump.vault.v1'
const INDEX = 'lump.wallets.v1'
export const MAX_WALLETS = 9
const NAME_MAX = 24
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, dkLen: 32 } // ~0.5 s on a 2022 phone

type VaultV1 = { v: 1; salt: string; iv: string; ct: string }
type VaultV2 = { v: 2; salt: string; iv: string; ct: string; div: string; where: DeviceStore }
type VaultBlob = VaultV1 | VaultV2
/** `address`: the wallet's public address once it has been seen, for the list of wallets. */
export type WalletInfo = { id: string; name: string; address?: string }
/** What an unlocked app keeps until it locks: enough to open and add wallets, never the PIN. Neither key can be exported. */
export type SessionKeys = { vaultKey: CryptoKey; base: CryptoKey; salt: Uint8Array }
export type Unlocked = { mnemonic: string; stateKey: CryptoKey; walletId: string; keys: SessionKeys }

/** The stored phrase cannot be opened on this device: its device key is not here. */
export class VaultMoved extends Error { constructor() { super('this wallet\'s data came from another device') } }
/** That phrase is one of this device's wallets already. */
export class WalletExists extends Error { constructor(readonly walletId: string) { super('This wallet is on this device already') } }

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const gcm = (iv: Uint8Array) => ({ name: 'AES-GCM', iv: iv as BufferSource })

async function keysFromRaw(raw: Uint8Array, salt: Uint8Array): Promise<SessionKeys> {
  const vaultKey = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const base = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey'])
  return { vaultKey, base, salt }
}
/** The key of a wallet's cached sync state. The first wallet's is the one it always had; the others each get their own. */
const stateKeyFor = (k: SessionKeys, walletId: string) => crypto.subtle.deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt: k.salt as BufferSource, info: new TextEncoder().encode(scoped('lump-state-v1', walletId)) },
  k.base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
)
const rawFromPin = (pin: string, salt: Uint8Array) => scrypt(new TextEncoder().encode(pin), salt, SCRYPT)

// ---- what is stored ----
const blobKey = (walletId: string) => scoped(KEY, walletId)
const has = (name: string) => { try { return !!localStorage.getItem(name) } catch { return false } }
const readBlob = (walletId: string): VaultBlob | null => { try { return JSON.parse(localStorage.getItem(blobKey(walletId)) ?? 'null') as VaultBlob | null } catch { return null } }

type Index = { list: WalletInfo[]; active: string; next: number }
/**
 * The wallets whose phrase is really on this device. Without a stored index (every device before 2026-11-22) that is
 * the one wallet under the old name.
 */
function readIndex(): Index {
  let list: WalletInfo[] = [], active = FIRST, next = 2
  try {
    const v = JSON.parse(localStorage.getItem(INDEX) ?? 'null') as { list?: unknown; active?: unknown; next?: unknown } | null
    if (v && Array.isArray(v.list)) {
      list = (v.list as Array<Partial<WalletInfo> | null>).filter((w): w is WalletInfo => !!w && isWalletId(w.id) && typeof w.name === 'string')
        .map((w) => ({ id: w.id, name: w.name.slice(0, NAME_MAX), ...(typeof w.address === 'string' ? { address: w.address } : {}) }))
      if (isWalletId(v.active)) active = v.active
      if (Number.isInteger(v.next) && (v.next as number) >= 2) next = v.next as number
    }
  } catch { /* unreadable: as if there were none */ }
  const seen = new Set<string>()
  list = list.filter((w) => !seen.has(w.id) && !!seen.add(w.id) && has(blobKey(w.id)))
  if (!seen.has(FIRST) && has(KEY)) list = [{ id: FIRST, name: 'Wallet 1' }, ...list]
  if (!list.some((w) => w.id === active)) active = list[0]?.id ?? FIRST
  for (const w of list) next = Math.max(next, Number(w.id.slice(1)) + 1)
  return { list, active, next }
}
const writeIndex = (ix: Index) => localStorage.setItem(INDEX, JSON.stringify(ix))

export const hasVault = () => readIndex().list.length > 0
/** The wallets on this device, in the order they were added. */
export const listWallets = (): WalletInfo[] => readIndex().list
/** The wallet the app opens with. */
export const activeWalletId = (): string => readIndex().active
/** How the phrase of the wallet in use is kept on this device (Settings shows it). */
export function vaultInfo(): { locks: 1 | 2; where: DeviceStore | null } | null {
  const b = readBlob(activeWalletId())
  return b ? (b.v === 2 ? { locks: 2, where: b.where } : { locks: 1, where: null }) : null
}

/**
 * Put the device lock around a PIN-locked phrase, and prove the result opens before it is handed back.
 * `fresh`: a vault is being made where there was none, so the device gets a new key. Otherwise the phrase goes under
 * the key that is already here: a new one in its place would lock every other wallet away for good.
 */
async function withDeviceLock(v1: VaultV1, fresh: boolean): Promise<VaultV2> {
  let made: { key: CryptoKey; store: DeviceStore } | null = null
  if (!fresh) {
    const store = await deviceStore()
    const key = await loadDeviceKey(store)
    if (key) made = { key, store }
    // no key although a wallet here is under one: that wallet is lost to this device already, and nothing may be put in the key's place
    else if (readIndex().list.some((w) => readBlob(w.id)?.v === 2)) throw new Error('the device key is not here')
  }
  const { key, store } = made ?? await createDeviceKey()
  const div = crypto.getRandomValues(new Uint8Array(12))
  const inner = unb64(v1.ct)
  const outer = new Uint8Array(await crypto.subtle.encrypt(gcm(div), key, inner as BufferSource))
  const blob: VaultV2 = { v: 2, salt: v1.salt, iv: v1.iv, ct: b64(outer), div: b64(div), where: store }
  // read the key back from where it is kept, as the next unlock will, and open the outer lock with it
  const again = await loadDeviceKey(store)
  if (!again) throw new Error('the device key was not kept')
  const back = new Uint8Array(await crypto.subtle.decrypt(gcm(div), again, outer as BufferSource))
  if (back.length !== inner.length || back.some((x, i) => x !== inner[i])) throw new Error('the device lock did not open again')
  return blob
}

/** The first wallet of a device that has none: sets the PIN. */
export async function createVault(mnemonic: string, pin: string): Promise<Unlocked> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const raw = rawFromPin(pin, salt)
  const keys = await keysFromRaw(raw, salt)
  raw.fill(0)
  const ct = new Uint8Array(await crypto.subtle.encrypt(gcm(iv), keys.vaultKey, new TextEncoder().encode(mnemonic)))
  const v1: VaultV1 = { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }
  // a new wallet starts clean: no Face ID item or miss count of an earlier one
  await removeBiometricSecret()
  forgetLockSettings()
  pinOk()
  let blob: VaultBlob = v1
  try { blob = await withDeviceLock(v1, true) } catch (e) { console.warn('vault: device lock not available, PIN lock only', (e as Error)?.message ?? e) }
  localStorage.setItem(KEY, JSON.stringify(blob))
  try { localStorage.removeItem(INDEX) } catch { /* none */ }
  return { mnemonic, stateKey: await stateKeyFor(keys, FIRST), walletId: FIRST, keys }
}

/** Open with the keys of a PIN (or of Face ID). null: those keys do not open it. Throws VaultMoved, or what the device's key store threw. */
async function openWith(blob: VaultBlob, vaultKey: CryptoKey): Promise<string | null> {
  let inner: Uint8Array
  if (blob.v === 2) {
    if (blob.where === 'keychain' && (await deviceStore()) !== 'keychain') throw new VaultMoved()
    const dk = await loadDeviceKey(blob.where)
    if (!dk) throw new VaultMoved()
    try { inner = new Uint8Array(await crypto.subtle.decrypt(gcm(unb64(blob.div)), dk, unb64(blob.ct) as BufferSource)) } catch { throw new VaultMoved() }
  } else inner = unb64(blob.ct)
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt(gcm(unb64(blob.iv)), vaultKey, inner as BufferSource))
  } catch { return null }
}

/** A v1 vault that just opened gets its device lock. Never in the way of the unlock: on any problem v1 stays. */
async function upgrade(walletId: string, blob: VaultBlob) {
  if (blob.v !== 1) return
  try { localStorage.setItem(blobKey(walletId), JSON.stringify(await withDeviceLock(blob, false))) } catch (e) { console.warn('vault: kept the PIN-only format', (e as Error)?.message ?? e) }
}

/**
 * The device key moves from the web view's own store into the system's key store, once the app's shell has one
 * (Android got its Keystore store on 2026-11-23; until then the key sat beside the data it locks, so a copy of the
 * app's files was held back by the PIN alone).
 *
 * Every wallet's outer lock is opened with the old key and closed with the new one; the PIN's lock inside is not
 * touched, so no PIN is needed. A wallet is rewritten only after its new lock was opened again with the key read
 * back from the system store, and the old key is thrown away only when every wallet of the device is under the new
 * one and opens. Stopped half-way (the app killed), both keys are still there and each wallet names the store its
 * key is in: the next unlock goes on where this one stopped. Never in the way of an unlock: on any problem
 * everything stays as it was.
 */
export async function moveToSystemStore(): Promise<'moved' | 'nothing' | 'kept'> {
  try {
    if ((await deviceStore()) !== 'keychain') return 'nothing'
    const ids = [...new Set([FIRST, ...readIndex().list.map((w) => w.id)])]
    const here = ids.map((id) => ({ id, blob: readBlob(id) })).filter((x): x is { id: string; blob: VaultV2 } => x.blob?.v === 2)
    const todo = here.filter((x) => x.blob.where === 'browser')
    if (todo.length === 0) return 'nothing'
    const old = await loadDeviceKey('browser')
    // no old key: those wallets cannot be opened by anything any more, and nothing may be put in the key's place
    if (!old) return 'kept'
    // the system store's key: the one that is there (an earlier, unfinished move), else a new one
    const next = (await loadDeviceKey('keychain')) ?? (await createDeviceKey()).key
    for (const { id, blob } of todo) {
      const inner = new Uint8Array(await crypto.subtle.decrypt(gcm(unb64(blob.div)), old, unb64(blob.ct) as BufferSource))
      const div = crypto.getRandomValues(new Uint8Array(12))
      const outer = new Uint8Array(await crypto.subtle.encrypt(gcm(div), next, inner as BufferSource))
      // as the next unlock will: the key read from the system store opens what was just closed
      const again = await loadDeviceKey('keychain')
      if (!again) throw new Error('the system key store did not keep the device key')
      const back = new Uint8Array(await crypto.subtle.decrypt(gcm(div), again, outer as BufferSource))
      const same = back.length === inner.length && back.every((x, i) => x === inner[i])
      inner.fill(0); back.fill(0)
      if (!same) throw new Error('the new device lock did not open again')
      const moved: VaultV2 = { ...blob, ct: b64(outer), div: b64(div), where: 'keychain' }
      const text = JSON.stringify(moved)
      localStorage.setItem(blobKey(id), text)
      if (localStorage.getItem(blobKey(id)) !== text) throw new Error('the moved lock was not stored')
    }
    // the old key goes only when nothing needs it any more: every wallet names the system store and opens with its key
    const key = await loadDeviceKey('keychain')
    if (!key) throw new Error('the system key store did not keep the device key')
    for (const id of ids) {
      const b = readBlob(id)
      if (!b || b.v !== 2) continue
      if (b.where !== 'keychain') return 'kept'
      await crypto.subtle.decrypt(gcm(unb64(b.div)), key, unb64(b.ct) as BufferSource)
    }
    await removeBrowserDeviceKey()
    return 'moved'
  } catch (e) {
    console.warn('vault: the device key stays where it is', (e as Error)?.message ?? e)
    return 'kept'
  }
}

/** Returns the wallet in use opened, or null for a wrong PIN. No attempt counting: see unlockWithPin. */
export async function openVault(pin: string): Promise<Unlocked | null> {
  const walletId = activeWalletId()
  const blob = readBlob(walletId)
  if (!blob) return null
  const salt = unb64(blob.salt)
  const raw = rawFromPin(pin, salt)
  const keys = await keysFromRaw(raw, salt)
  raw.fill(0)
  const mnemonic = await openWith(blob, keys.vaultKey)
  if (mnemonic == null) return null
  // first the move (it gives the system store its key), then a PIN-only wallet gets its device lock under that key
  await moveToSystemStore()
  await upgrade(walletId, blob)
  return { mnemonic, stateKey: await stateKeyFor(keys, walletId), walletId, keys }
}

export type PinResult = { ok: Unlocked } | { wrong: true; waitMs: number } | { waitMs: number }

/** What every PIN pad calls: a PIN is only tried when no wait is running, and a miss counts (core/attempts.ts). */
export async function unlockWithPin(pin: string): Promise<PinResult> {
  const wait = pinWaitMs()
  if (wait > 0) return { waitMs: wait }
  const u = await openVault(pin)
  if (!u) { pinFailed(); return { wrong: true, waitMs: pinWaitMs() } }
  pinOk()
  return { ok: u }
}

// ---- several wallets ----

/** Another wallet of this device, opened with the keys of the unlock, and from now on the wallet in use. */
export async function openWallet(keys: SessionKeys, walletId: string): Promise<Unlocked> {
  const blob = readBlob(walletId)
  if (!blob) throw new Error('That wallet is not on this device')
  if (blob.salt !== b64(keys.salt)) throw new Error('That wallet is locked with another PIN')
  const mnemonic = await openWith(blob, keys.vaultKey)
  if (mnemonic == null) throw new Error('That wallet could not be opened')
  writeIndex({ ...readIndex(), active: walletId })
  return { mnemonic, stateKey: await stateKeyFor(keys, walletId), walletId, keys }
}

/**
 * A further wallet (a new phrase, or one brought along) under the same PIN and device key, and from now on the
 * wallet in use. Its stored phrase is read back and opened before the list of wallets names it; the wallets that are
 * here already are not touched. Throws WalletExists when the phrase is one of them.
 */
export async function addWallet(keys: SessionKeys, mnemonic: string, name?: string): Promise<Unlocked> {
  const ix = readIndex()
  if (ix.list.length === 0) throw new Error('There is no wallet to add to')
  if (ix.list.length >= MAX_WALLETS) throw new Error(`This device holds up to ${MAX_WALLETS} wallets`)
  // the same phrase twice would be one wallet shown as two
  for (const w of ix.list) {
    const b = readBlob(w.id)
    const m = b && b.salt === b64(keys.salt) ? await openWith(b, keys.vaultKey).catch(() => null) : null
    if (m === mnemonic) throw new WalletExists(w.id)
  }
  const walletId = `w${ix.next}`
  if (has(blobKey(walletId))) throw new Error('The new wallet could not be stored')   // an id is never used twice
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt(gcm(iv), keys.vaultKey, new TextEncoder().encode(mnemonic)))
  const v1: VaultV1 = { v: 1, salt: b64(keys.salt), iv: b64(iv), ct: b64(ct) }
  let blob: VaultBlob = v1
  try { blob = await withDeviceLock(v1, false) } catch (e) {
    // the other wallets are under the device key: this one is too, or it is not stored at all. Only a device whose
    // wallets are all PIN-only (it has no key store that works) keeps a further one the same way.
    if (ix.list.some((w) => readBlob(w.id)?.v === 2)) throw new Error('The new wallet could not be stored safely on this device')
    console.warn('vault: device lock not available for the new wallet, PIN lock only', (e as Error)?.message ?? e)
  }
  localStorage.setItem(blobKey(walletId), JSON.stringify(blob))
  // as the next unlock will find it
  const back = readBlob(walletId)
  const again = back ? await openWith(back, keys.vaultKey).catch(() => null) : null
  if (again !== mnemonic) { try { localStorage.removeItem(blobKey(walletId)) } catch {}; throw new Error('The new wallet could not be stored') }
  const label = (name ?? '').trim().slice(0, NAME_MAX) || `Wallet ${ix.next}`
  writeIndex({ list: [...ix.list, { id: walletId, name: label }], active: walletId, next: ix.next + 1 })
  return { mnemonic, stateKey: await stateKeyFor(keys, walletId), walletId, keys }
}

export function renameWallet(walletId: string, name: string) {
  const label = name.trim().slice(0, NAME_MAX)
  if (!label) return
  const ix = readIndex()
  if (!ix.list.some((w) => w.id === walletId)) return
  try { writeIndex({ ...ix, list: ix.list.map((w) => (w.id === walletId ? { ...w, name: label } : w)) }) } catch { /* no room: the old name stays */ }
}

/** Remembers a wallet's public address for the list of wallets. */
export function noteWalletAddress(walletId: string, address: string) {
  const ix = readIndex()
  const w = ix.list.find((x) => x.id === walletId)
  if (!w || !address || w.address === address) return
  try { writeIndex({ ...ix, list: ix.list.map((x) => (x.id === walletId ? { ...x, address } : x)) }) } catch { /* no room */ }
}

/**
 * Takes ONE wallet off this device: its phrase, its sync cache and what the app remembered for it. The other
 * wallets, the PIN and the device key stay. Returns the wallet in use afterwards; null when it was the last one, and
 * then the device is emptied as destroyVault does.
 */
export async function removeWallet(walletId: string): Promise<string | null> {
  const ix = readIndex()
  const gone = ix.list.find((w) => w.id === walletId)
  const rest = ix.list.filter((w) => w.id !== walletId)
  if (!gone) return ix.list.length ? ix.active : null
  if (rest.length === 0) { await destroyVault(); return null }
  const active = ix.active === walletId ? rest[0].id : ix.active
  // the list first: a wallet half removed must not be the one the app opens with
  writeIndex({ list: rest, active, next: ix.next })
  try { localStorage.removeItem(blobKey(walletId)) } catch {}
  const { clearState } = await import('./stateStore')
  await clearState(walletId).catch(() => {})
  const { clearBirthday } = await import('./bootstrap')
  clearBirthday(walletId)
  const { forgetDustNotes } = await import('./dustNotes')
  forgetDustNotes(walletId)
  const { forgetPicture } = await import('./avatar')
  forgetPicture(walletId)
  const { forgetHeldOnCardano } = await import('./energy')
  forgetHeldOnCardano(walletId)
  const { forgetConnections } = await import('../dapp/connections')
  forgetConnections(walletId)
  const { forgetDappEntries } = await import('../dapp/log')
  forgetDappEntries(walletId)
  if (gone.address) { const { forgetActivity } = await import('./activity'); forgetActivity(gone.address) }
  forgetScoped(walletId)
  return active
}

// ---- Face ID / Touch ID ----

/** Keep the unlock key behind the face or finger. The PIN proves who is asking. */
export async function enableBiometrics(pin: string): Promise<PinResult> {
  const wait = pinWaitMs()
  if (wait > 0) return { waitMs: wait }
  const walletId = activeWalletId()
  const blob = readBlob(walletId)
  if (!blob) return { wrong: true, waitMs: 0 }
  const salt = unb64(blob.salt)
  const raw = rawFromPin(pin, salt)
  try {
    const keys = await keysFromRaw(raw, salt)
    const mnemonic = await openWith(blob, keys.vaultKey)
    if (mnemonic == null) { pinFailed(); return { wrong: true, waitMs: pinWaitMs() } }
    pinOk()
    await saveBiometricSecret(raw)
    saveLockSettings({ bio: true })
    return { ok: { mnemonic, stateKey: await stateKeyFor(keys, walletId), walletId, keys } }
  } finally { raw.fill(0) }
}

export async function disableBiometrics() {
  await removeBiometricSecret()
  saveLockSettings({ bio: false })
}

/**
 * Open with the face or finger. null: cancelled, or nothing is kept for it any more (the enrolled faces or fingers
 * changed: Face ID is then switched off here and the PIN turns it on again).
 */
export async function unlockWithBiometrics(reason: string): Promise<Unlocked | null> {
  if (!lockSettings().bio) return null
  const walletId = activeWalletId()
  const blob = readBlob(walletId)
  if (!blob) return null
  const { secret, gone } = await readBiometricSecret(reason)
  if (!secret) { if (gone) saveLockSettings({ bio: false }); return null }
  try {
    const keys = await keysFromRaw(secret, unb64(blob.salt))
    const mnemonic = await openWith(blob, keys.vaultKey)
    if (mnemonic == null) { await disableBiometrics(); return null }   // kept for an earlier wallet or PIN
    pinOk()
    return { mnemonic, stateKey: await stateKeyFor(keys, walletId), walletId, keys }
  } finally { secret.fill(0) }
}

/** Empties the device: every wallet, the PIN's lock and what the app remembered. */
export async function destroyVault() {
  const ix = readIndex()
  try { localStorage.removeItem(KEY) } catch {}
  for (const w of ix.list) { try { localStorage.removeItem(blobKey(w.id)) } catch {} }
  try { localStorage.removeItem(INDEX) } catch {}
  await removeDeviceKey()
  await removeBiometricSecret()
  forgetLockSettings()
  pinOk()
  const { clearAllState } = await import('./stateStore')
  await clearAllState().catch(() => {})
  const { clearBirthday } = await import('./bootstrap')
  clearBirthday(FIRST)
  const { forgetDustNotes } = await import('./dustNotes')
  forgetDustNotes(FIRST)
  const { forgetPicture } = await import('./avatar')
  forgetPicture(FIRST)
  const { forgetHeldOnCardano } = await import('./energy')
  forgetHeldOnCardano(FIRST)
  // what the wallets remembered about their NFTs and the sites they opened or connected goes with them
  const { forgetNfts } = await import('./nfts')
  forgetNfts()
  const { forgetFavorites } = await import('./favorites')
  forgetFavorites()
  const { forgetActivity } = await import('./activity')
  forgetActivity()
  const { forgetDappEntries } = await import('../dapp/log')
  forgetDappEntries(FIRST)
  const { forgetConnections } = await import('../dapp/connections')
  forgetConnections(FIRST)
  forgetAllScoped()
  try { localStorage.removeItem('lump.browser.recent.v1') } catch {}
}
