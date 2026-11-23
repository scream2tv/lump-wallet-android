// Keep the screen on while the wallet syncs. A phone that locks its screen freezes the app, and the sync with it, so
// a long first sync would otherwise need a finger on the glass. In the app the native shell holds the screen
// (KeepAwake plugin: the idle timer on iOS); in a browser the Screen Wake Lock does, where there is one. The lock is
// let go the moment the sync is done, and the system takes it away by itself whenever the wallet is not in front.
// On Android the same call also lets the sync go on after the app is left (KeepAwakePlugin.java, SyncService.java).
import { Capacitor, registerPlugin } from '@capacitor/core'

const Native = registerPlugin<{ set(o: { on: boolean }): Promise<void> }>('KeepAwake')
type Sentinel = { release(): Promise<void>; addEventListener(type: 'release', fn: () => void): void }

let wanted = false
let sentinel: Sentinel | null = null
let listening = false

async function hold() {
  if (!wanted || sentinel || document.visibilityState !== 'visible') return
  try {
    const lock = (navigator as unknown as { wakeLock?: { request(kind: 'screen'): Promise<Sentinel> } }).wakeLock
    if (!lock) return
    const s = await lock.request('screen')
    if (!wanted) { void s.release().catch(() => {}); return }
    sentinel = s
    // the browser drops the lock when the page is hidden: taken again when it is back in front
    s.addEventListener('release', () => { if (sentinel === s) sentinel = null })
  } catch { /* not allowed right now (battery saver, no gesture yet): the screen just follows the system setting */ }
}

// On a computer the wallet may be left syncing in a tab that is not in front. A browser may freeze such a page to
// save power; one that holds a lock is left running.
let unlock: (() => void) | null = null
function holdLock() {
  const locks = (navigator as unknown as { locks?: LockManager }).locks
  if (unlock || !locks) return
  try {
    void locks.request('lump-wallet-sync', { ifAvailable: true }, (lock) => (lock ? new Promise<void>((done) => { unlock = done; if (!wanted) { unlock = null; done() } }) : undefined)).catch(() => {})
  } catch { /* no locks here */ }
}

export function keepAwake(on: boolean) {
  if (on === wanted) return
  wanted = on
  if (Capacitor.isNativePlatform()) void Native.set({ on }).catch(() => {})
  if (!listening) { listening = true; document.addEventListener('visibilitychange', () => void hold()) }
  if (on) { void hold(); holdLock() }
  else {
    const s = sentinel; sentinel = null; void s?.release().catch(() => {})
    const u = unlock; unlock = null; u?.()
  }
}
