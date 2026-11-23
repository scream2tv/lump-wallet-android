// Favorite sites of the in-app browser: the list at the top of Apps. This device only, shared by its wallets (like
// the recently opened sites); nothing here is sent anywhere.
//
// A device starts with our own sites as favorites. They are ordinary favorites: a person can remove them, and a
// removed one stays removed. `offered` remembers which of the defaults this device has been given, so a default
// that a later build adds arrives once and one that was removed does not come back.
export type Favorite = { url: string; name: string; hint?: string }

const KEY = 'lump.browser.favorites.v1'
const MAX = 40

export const DEFAULT_FAVORITES: Favorite[] = [
  { name: 'LumpTools', hint: 'Markets, wallets and NFTs on Midnight', url: 'https://lumptools.xyz/midnight' },
  { name: 'LumpFun', hint: 'Launch and trade tokens', url: 'https://lumpfun.com' },
  { name: 'Midnight Station', hint: 'NFT marketplace on Midnight', url: 'https://midnightstation.io' },
  { name: 'Mint testing', hint: 'Try a mint on Midnight Station', url: 'https://mint.midnightstation.io' },
]

/** One page, however its address is written: https only, no fragment, no trailing slash. null: not a page that can be a favorite. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return u.origin + u.pathname.replace(/\/+$/, '') + u.search
  } catch { return null }
}

type Stored = { list: Favorite[]; offered: string[] }
function read(): Stored {
  let s: Stored = { list: [], offered: [] }
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Stored> | null
    if (j && Array.isArray(j.list)) {
      s = {
        list: j.list.filter((f) => f && typeof f.url === 'string' && typeof f.name === 'string' && pageKey(f.url)).map((f) => ({ url: f.url, name: f.name.slice(0, 80), ...(typeof f.hint === 'string' ? { hint: f.hint.slice(0, 120) } : {}) })).slice(0, MAX),
        offered: Array.isArray(j.offered) ? j.offered.filter((x) => typeof x === 'string') : [],
      }
    }
  } catch { /* unreadable: start again from the defaults */ }
  // the defaults this device has not been given yet
  const fresh = DEFAULT_FAVORITES.filter((d) => !s.offered.includes(d.url))
  if (fresh.length) {
    const have = new Set(s.list.map((f) => pageKey(f.url)))
    s = { list: [...s.list, ...fresh.filter((d) => !have.has(pageKey(d.url)))].slice(0, MAX), offered: [...s.offered, ...fresh.map((d) => d.url)] }
    write(s)
  }
  return s
}
function write(s: Stored) { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* no storage: the list lasts as long as the screen */ } }

export const listFavorites = (): Favorite[] => read().list
export const isFavorite = (url: string): boolean => { const k = pageKey(url); return !!k && read().list.some((f) => pageKey(f.url) === k) }

/** Adds the page (`title`: what the page calls itself; its address stands in when it has no title). Returns the list. */
export function addFavorite(url: string, title: string): Favorite[] {
  const k = pageKey(url)
  const s = read()
  if (!k || s.list.some((f) => pageKey(f.url) === k) || s.list.length >= MAX) return s.list
  // one of our own sites put back keeps the name and the line it had
  const own = DEFAULT_FAVORITES.find((d) => pageKey(d.url) === k)
  const name = title.replace(/\s+/g, ' ').trim().slice(0, 60) || new URL(url).host
  const next = { list: [...s.list, own ?? { url: k, name }], offered: s.offered }
  write(next)
  return next.list
}
export function removeFavorite(url: string): Favorite[] {
  const k = pageKey(url)
  const s = read()
  const next = { list: s.list.filter((f) => pageKey(f.url) !== k), offered: s.offered }
  write(next)
  return next.list
}
/** The device is emptied (every wallet removed): the list starts again from the defaults. */
export function forgetFavorites() { try { localStorage.removeItem(KEY) } catch { /* no storage */ } }
