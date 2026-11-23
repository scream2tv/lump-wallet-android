// Timers that keep their pace while the wallet's window is not in front (desktop browsers).
//
// A browser slows the timers of a hidden page to one a second, and after some minutes to one a minute. The wallet
// SDK paces its sync with short timers, so a wallet left syncing in a background tab or a minimized window would
// crawl: an hour's sync becomes most of a day. A worker's timers are not slowed, so while the page is hidden,
// setTimeout is served by a small worker that sleeps and calls back; with the page in front nothing changes.
// Not used in the app: a phone suspends the whole page in the background, timers or not.
import { Capacitor } from '@capacitor/core'

const WORKER = 'const t=new Map();onmessage=(e)=>{const[id,ms]=e.data;if(ms<0){clearTimeout(t.get(id));t.delete(id)}else t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},ms))}'
/** ids of our own timers start here, far above anything the browser hands out in a session */
const FIRST_ID = 2 ** 30

export function installBackgroundTimers() {
  if (Capacitor.isNativePlatform() || typeof Worker !== 'function' || typeof document === 'undefined') return
  let worker: Worker
  try { worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }))) } catch { return }
  const pending = new Map<number, () => void>()
  const stats = { served: 0 }
  let next = FIRST_ID, broken = false
  worker.onmessage = (e: MessageEvent<number>) => {
    const fn = pending.get(e.data)
    if (!fn) return
    pending.delete(e.data)
    stats.served++
    fn()
  }
  // a worker that dies must not take the wallet's timers with it: what it still owed runs now, the rest goes the usual way
  worker.onerror = () => { broken = true; const owed = [...pending.values()]; pending.clear(); for (const fn of owed) { try { fn() } catch (err) { console.error(err) } } }
  const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window)
  const set = (handler: TimerHandler, ms?: number, ...args: unknown[]): number => {
    if (broken || !document.hidden || typeof handler !== 'function') return nativeSet(handler, ms, ...args)
    const id = next++
    pending.set(id, () => (handler as (...a: unknown[]) => void)(...args))
    worker.postMessage([id, Math.max(0, Number(ms) || 0)])
    return id
  }
  const clear = (id?: number) => {
    if (typeof id === 'number' && id >= FIRST_ID) { if (pending.delete(id)) worker.postMessage([id, -1]) } else nativeClear(id)
  }
  window.setTimeout = set as typeof window.setTimeout
  window.clearTimeout = clear as typeof window.clearTimeout
  if (import.meta.env.DEV || import.meta.env.VITE_LOCAL === '1') (window as unknown as { __lumpBgTimers?: unknown }).__lumpBgTimers = stats
}
