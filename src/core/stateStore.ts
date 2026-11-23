// Encrypted cache of the wallet's synced state (IndexedDB, AES-GCM with the unlock-derived state key), so a
// re-open resumes where the last session stopped instead of replaying the chain from genesis.
// The cache holds viewing-side state only, never the seed; a wrong key or corrupt blob just means a fresh sync.
// One row per wallet (core/scope.ts): the first wallet's is the row there has always been.
import { FIRST, scoped } from './scope'

const DB = 'lump', STORE = 'state'
const row = (walletId: string) => scoped('wallet-v1', walletId)

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

type Row = { iv: Uint8Array; ct: ArrayBuffer; saved: string }

export async function saveState(key: CryptoKey, value: unknown, walletId: string = FIRST): Promise<number> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(value))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  const db = await openDb()
  try { await tx(db, 'readwrite', (s) => s.put({ iv, ct, saved: new Date().toISOString() } satisfies Row, row(walletId))) } finally { db.close() }
  return ct.byteLength
}

export async function loadState<T>(key: CryptoKey, walletId: string = FIRST): Promise<(T & { saved: string }) | null> {
  try {
    const db = await openDb()
    let kept: Row | undefined
    try { kept = await tx<Row | undefined>(db, 'readonly', (s) => s.get(row(walletId))) } finally { db.close() }
    if (!kept) return null
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kept.iv as BufferSource }, key, kept.ct)
    return { ...JSON.parse(new TextDecoder().decode(pt)), saved: kept.saved }
  } catch {
    return null
  }
}

export async function clearState(walletId: string = FIRST) {
  const db = await openDb()
  try { await tx(db, 'readwrite', (s) => s.delete(row(walletId))) } finally { db.close() }
}

/** Every wallet's cache (the device is being emptied). */
export async function clearAllState() {
  const db = await openDb()
  try { await tx(db, 'readwrite', (s) => s.clear()) } finally { db.close() }
}
