// What only THIS device holds.
//
// 1. The device key: a second lock on the recovery phrase, next to the PIN. In the app it is 32 random bytes in the
//    iPhone Keychain, readable only on this device while it is unlocked (never in a backup, never moved to another
//    phone). The encrypted phrase in the app's storage is useless without it, so a copy of the app's data (a backup,
//    a file pulled off the phone) can no longer be opened by trying all one million PINs.
//    In a browser, and in an app shell that has no SecureStore yet, it is a key the browser keeps and will not hand
//    out (IndexedDB, not extractable): weaker (it lives beside the data), but the same code path.
//
// 2. The biometric item: the PIN-derived unlock key kept in the Keychain behind Face ID / Touch ID, so the wallet can
//    be opened and a send confirmed with a glance. It is released only after the system has matched the face or
//    finger, and is thrown away by the system when the enrolled faces or fingers change.
//
// Native side: ios/App/App/DappBrowser.swift, SecureStorePlugin (the Keychain); on Android SecureStorePlugin.java (a
// value encrypted with a key of the Android Keystore, kept in the app's own files, which are in no backup). Android
// has no fingerprint or face unlock yet: its biometry() answers "none".
//
// An app that kept its device key in the web view's store and then gets a shell with a system key store moves the
// key over at the next unlock (core/vault.ts, moveToSystemStore).
import { Capacitor, registerPlugin } from '@capacitor/core'

interface SecureStorePlugin {
  get(o: { key: string }): Promise<{ value: string | null }>
  set(o: { key: string; value: string }): Promise<void>
  remove(o: { key: string }): Promise<void>
  biometry(): Promise<{ kind: 'face' | 'touch' | 'none' }>
  setBio(o: { key: string; value: string }): Promise<void>
  getBio(o: { key: string; reason: string }): Promise<{ value: string | null; cancelled?: boolean }>
  removeBio(o: { key: string }): Promise<void>
}
const Native = registerPlugin<SecureStorePlugin>('SecureStore')

const DEVICE_KEY = 'vault-device-key-v1'
const BIO_KEY = 'vault-unlock-key-v1'
export type DeviceStore = 'keychain' | 'browser'

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** Is the Keychain there? Asked once: an app shell without the plugin answers "not implemented". */
let nativeStore: Promise<boolean> | null = null
function hasKeychain(): Promise<boolean> {
  nativeStore ??= (async () => {
    if (!Capacitor.isNativePlatform()) return false
    try { await Native.get({ key: 'probe' }); return true } catch (e) {
      // "not implemented" = no such plugin in this shell; any other failure is the Keychain itself having a problem
      const text = String((e as { code?: string; message?: string })?.code ?? '') + String((e as Error)?.message ?? e)
      if (/UNIMPLEMENTED|not implemented/i.test(text)) return false
      throw e
    }
  })()
  // a Keychain problem must be asked again next time, not remembered as an answer
  nativeStore.catch(() => { nativeStore = null })
  return nativeStore
}
export async function deviceStore(): Promise<DeviceStore> { return (await hasKeychain()) ? 'keychain' : 'browser' }

const importAes = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])

// ---- the browser's own key store ----
const DB = 'lump-device', STORE = 'keys', ROW = 'vault-v1'
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}
async function idbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb()
  try {
    return await new Promise<T>((res, rej) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
  } finally { db.close() }
}

/** The device key, or null when this device has none (a new install, or data that came from another device). Throws when the store cannot be read. */
export async function loadDeviceKey(store: DeviceStore): Promise<CryptoKey | null> {
  if (store === 'keychain') {
    const { value } = await Native.get({ key: DEVICE_KEY })
    return value ? importAes(unb64(value)) : null
  }
  const k = await idbDo<unknown>('readonly', (s) => s.get(ROW))
  return k instanceof CryptoKey ? k : null
}

/** A new device key in place of any earlier one. Read back before it is used: a key that did not stick would lock the phrase away. */
export async function createDeviceKey(): Promise<{ key: CryptoKey; store: DeviceStore }> {
  const store = await deviceStore()
  if (store === 'keychain') {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const value = b64(raw)
    await Native.set({ key: DEVICE_KEY, value })
    const back = await Native.get({ key: DEVICE_KEY })
    raw.fill(0)
    if (back.value !== value) throw new Error('the Keychain did not keep the device key')
    return { key: await importAes(unb64(value)), store }
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await idbDo('readwrite', (s) => s.put(key, ROW))
  const back = await idbDo<unknown>('readonly', (s) => s.get(ROW))
  if (!(back instanceof CryptoKey)) throw new Error('the browser did not keep the device key')
  return { key: back, store }
}

/** Only the web view's copy: after every wallet's lock was moved to the system key store (core/vault.ts). */
export async function removeBrowserDeviceKey() {
  await idbDo('readwrite', (s) => s.delete(ROW))
}

/** Where the device key is when there is no system key store, for the screens. */
export const ownStoreName = () => (Capacitor.isNativePlatform() ? 'this app' : 'this browser')

/** What the system's key store is called on this device, for the screens. */
export const systemStoreName = () => (Capacitor.getPlatform() === 'android' ? 'Keystore' : 'Keychain')

export async function removeDeviceKey() {
  try { if (await hasKeychain()) await Native.remove({ key: DEVICE_KEY }) } catch { /* nothing to remove, or no Keychain */ }
  try { await idbDo('readwrite', (s) => s.delete(ROW)) } catch { /* no store */ }
}

// ---- Face ID / Touch ID ----
export type Biometry = 'face' | 'touch' | 'none'
export const biometryName = (kind: Biometry) => (kind === 'face' ? 'Face ID' : kind === 'touch' ? 'Touch ID' : '')

/** What this device can match, or 'none' (a browser, no enrolled face or finger, or a shell without the plugin). */
export async function biometry(): Promise<Biometry> {
  try { return (await hasKeychain()) ? (await Native.biometry()).kind : 'none' } catch { return 'none' }
}

export async function saveBiometricSecret(secret: Uint8Array): Promise<void> {
  await Native.setBio({ key: BIO_KEY, value: b64(secret) })
}

/**
 * Ask the system for a face or finger and hand back the secret kept behind it. null: the person cancelled, or the
 * system threw the item away (enrolled faces or fingers changed). The caller falls back to the PIN.
 */
export async function readBiometricSecret(reason: string): Promise<{ secret: Uint8Array | null; gone: boolean }> {
  const r = await Native.getBio({ key: BIO_KEY, reason })
  return { secret: r.value ? unb64(r.value) : null, gone: !r.value && !r.cancelled }
}

export async function removeBiometricSecret() {
  try { if (await hasKeychain()) await Native.removeBio({ key: BIO_KEY }) } catch { /* nothing kept */ }
}
