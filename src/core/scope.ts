// Several wallets on one device: whose stored data is whose.
//
// The first wallet ('w1') keeps the storage names its data has always had, so a device from before there could be
// several is read exactly as it was and nothing is moved. Every further wallet ('w2', 'w3', …) uses the same names
// with "@<id>" appended. An id is never used twice on a device.
//
// What needs the id of a wallet that may no longer be the one in use (the sync cache a closing wallet still saves,
// the phrase itself) is given it; `scoped(name)` without one means the wallet in use, set when it is opened.
export const FIRST = 'w1'
const ID = /^w[1-9]\d{0,5}$/
export const isWalletId = (id: unknown): id is string => typeof id === 'string' && ID.test(id)

let current = FIRST
/** The wallet in use from now on (App sets it before that wallet's session starts). */
export function setScope(walletId: string) { current = isWalletId(walletId) ? walletId : FIRST }
export const scopeId = () => current

/** The storage name `name` for a wallet (the wallet in use when none is given). */
export const scoped = (name: string, walletId: string = current) => (walletId === FIRST ? name : `${name}@${walletId}`)

/** Everything in localStorage that belongs to a further wallet (never the first: its names are the plain ones). */
export function forgetScoped(walletId: string) {
  if (!isWalletId(walletId) || walletId === FIRST) return
  try { for (const k of Object.keys(localStorage)) if (k.endsWith(`@${walletId}`)) localStorage.removeItem(k) } catch { /* no storage */ }
}
/** The same for every further wallet at once (the device is being emptied). */
export function forgetAllScoped() {
  try { for (const k of Object.keys(localStorage)) if (/@w[1-9]\d{0,5}$/.test(k)) localStorage.removeItem(k) } catch { /* no storage */ }
}
