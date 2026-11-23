// The wallet's picture: one of the NFTs this wallet holds, chosen on that NFT's own screen (ui/Nfts.tsx). It takes
// the place of the wallet's mark at the top of Home and in the list of wallets.
//
// What is kept is a small copy of the picture, made once when it is chosen: showing the wallet never asks a gateway
// (or any other server) for it again, and it shows with no connection. It belongs to one wallet and stays on this
// device. The picture shows while the wallet holds the NFT: `held` is what the wallet knew when it was last up to
// date. An NFT that is listed for sale or sent away takes its picture with it, and brings it back if it returns.
import { scoped } from './scope'

export type WalletPicture = { type: string; name: string; thumb: string; held: boolean }

const KEY = 'lump.wallet.picture.v1'
const HEX64 = /^[0-9a-f]{64}$/
const THUMB = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/
/** a copy is some 10 KB; nothing larger is kept or shown */
const MAX_THUMB = 96 * 1024
/** side of the kept copy, in pixels (the mark is 39 points wide) */
const SIDE = 144

const listeners = new Set<() => void>()
export const onPictureChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** The picture of a wallet (the wallet in use when none is named), or null. Anything that is not a small picture is no picture. */
export function readPicture(walletId?: string): WalletPicture | null {
  try {
    const v = JSON.parse(localStorage.getItem(scoped(KEY, walletId)) ?? 'null')
    if (!v || typeof v !== 'object' || typeof v.type !== 'string' || !HEX64.test(v.type)) return null
    if (typeof v.thumb !== 'string' || v.thumb.length > MAX_THUMB || !THUMB.test(v.thumb)) return null
    return { type: v.type, name: typeof v.name === 'string' ? v.name.slice(0, 80) : '', thumb: v.thumb, held: v.held !== false }
  } catch { return null }
}

export function writePicture(p: WalletPicture | null, walletId?: string) {
  try {
    if (p) localStorage.setItem(scoped(KEY, walletId), JSON.stringify(p))
    else localStorage.removeItem(scoped(KEY, walletId))
  } catch { /* no storage: the wallet keeps its mark */ }
  for (const fn of listeners) { try { fn() } catch { /* one listener's trouble is not another's */ } }
}

export const forgetPicture = (walletId?: string) => writePicture(null, walletId)

/** Whether the wallet holds the picture's NFT, as it knows now that it is up to date. Written only when it changed. */
export function notePictureHeld(held: boolean, walletId?: string) {
  const p = readPicture(walletId)
  if (p && p.held !== held) writePicture({ ...p, held }, walletId)
}

/** A small square copy of a picture, from the first of its addresses that delivers it; null when none can be read. */
export async function makeThumb(urls: string[]): Promise<string | null> {
  for (const url of urls.slice(0, 4)) {
    const t = await thumbOf(url).catch(() => null)
    if (t) return t
  }
  return null
}

function thumbOf(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    let over = false
    const done = (v: string | null) => { if (over) return; over = true; clearTimeout(timer); resolve(v) }
    const timer = setTimeout(() => { img.src = ''; done(null) }, 17_000)
    // read with the server's leave (a gateway gives it to everyone); without it the copy below is refused
    if (!url.startsWith('data:')) { img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer' }
    img.decoding = 'async'
    img.onerror = () => done(null)
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight
        if (!w || !h) return done(null)
        const c = document.createElement('canvas')
        c.width = c.height = SIDE
        const g = c.getContext('2d')
        if (!g) return done(null)
        g.fillStyle = '#0b0d14'
        g.fillRect(0, 0, SIDE, SIDE)
        g.imageSmoothingQuality = 'high'
        // the largest square of it: the middle of a wide picture, the upper part of a tall one (where a face is)
        const s = Math.min(w, h)
        g.drawImage(img, (w - s) / 2, (h - s) * 0.3, s, s, 0, 0, SIDE, SIDE)
        const out = c.toDataURL('image/jpeg', 0.86)
        done(THUMB.test(out) && out.length <= MAX_THUMB ? out : null)
      } catch { done(null) } // a picture whose server does not let a page read it
    }
    img.src = url
  })
}
