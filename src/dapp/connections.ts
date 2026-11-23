// Sites the user has connected (DApp Connector), per origin. Revocable in Settings → Connected apps.
// Each wallet has its own list (core/scope.ts): a site one wallet connected to knows nothing of the others.
import { scoped } from '../core/scope'

export type Connection = { origin: string; since: string }

const NAME = 'lump.dapp.connections.v1'
/**
 * A wallet's list. The screens ask for the wallet in use (no id given); a site's host always gives the id of the
 * wallet it was made for, so a request still on its way while another wallet takes over is never answered from, or
 * written to, that other wallet's list.
 */
const key = (walletId?: string) => scoped(NAME, walletId)
const listeners = new Set<() => void>()

export function listConnections(walletId?: string): Connection[] {
  try {
    const raw = localStorage.getItem(key(typeof walletId === 'string' ? walletId : undefined))
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((c) => c && typeof c.origin === 'string') : []
  } catch { return [] }
}

const write = (list: Connection[], walletId?: string) => {
  try { localStorage.setItem(key(walletId), JSON.stringify(list)) } catch {}
  for (const l of listeners) l()
}

export const isConnected = (origin: string, walletId?: string) => listConnections(walletId).some((c) => c.origin === origin)

export function addConnection(origin: string, walletId?: string) {
  if (isConnected(origin, walletId)) return
  write([...listConnections(walletId), { origin, since: new Date().toISOString() }], walletId)
}

export function removeConnection(origin: string, walletId?: string) {
  write(listConnections(walletId).filter((c) => c.origin !== origin), walletId)
}

export function onConnectionsChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
/** A wallet's whole list (that wallet is leaving the device). */
export function forgetConnections(walletId: string) { try { localStorage.removeItem(scoped(NAME, walletId)) } catch {} }

/** "https://example.org" -> "example.org" (the default port is implied). */
export const siteName = (origin: string) => origin.replace(/^https:\/\//, '')

/**
 * Sites the wallet's own lists (Apps, Settings) show under a name instead of their address. The approval sheet and
 * the browser's address bar always show the real address: that is what tells a person which site is asking.
 */
const NAMES: Record<string, string> = { 'https://mint.midnightstation.io': 'Mint testing' }
export const displayName = (origin: string) => NAMES[origin] ?? siteName(origin)
export const hasOwnName = (origin: string) => origin in NAMES

/** Old addresses of sites that have an entry of their own: left out of the Apps lists, and a saved connection to one is dropped once. */
export const HIDDEN = new Set(['https://lumpfun-midnight.vercel.app'])
const RETIRED_KEY = 'lump.dapp.retired.v1'
try {
  if (localStorage.getItem(RETIRED_KEY) !== '1') {
    const list = listConnections()
    if (list.some((c) => HIDDEN.has(c.origin))) localStorage.setItem(NAME, JSON.stringify(list.filter((c) => !HIDDEN.has(c.origin))))
    localStorage.setItem(RETIRED_KEY, '1')
  }
} catch { /* no storage: nothing saved to drop either */ }
