// Wrong PINs cost time. After four misses every further one makes the wallet wait before it takes another: half a
// minute, a minute, five, fifteen, then an hour each. This stops someone holding the unlocked phone from walking
// through PINs by hand; a copy of the app's data is held by the device key instead (core/device.ts), which no
// number of tries gets around.
//
// The wait is SERVED, not scheduled: what is kept is how much of it is left, and it only runs down while the wallet
// is open, measured on the page's own running clock, by one open wallet at a time. The phone's date and time have
// no say in how fast it runs, so setting the clock forward skips nothing, and closing the app only pauses it. (Someone who truly forgot the PIN does not wait
// it out: "Forgot PIN" restores from the 24 words.)
const KEY = 'lump.pin.attempts.v1'
/** seconds to wait after the n-th miss in a row (index = misses so far) */
const WAIT_S = [0, 0, 0, 0, 0, 31, 61, 307, 907]
const WAIT_MAX_S = 3_607
/** a step of the running clock longer than this was the app asleep, not time served */
const STEP_MAX_MS = 1_500

/** `by` + `beat`: which open wallet is serving the wait, and when it last did (see serve) */
type Saved = { fails: number; left: number; by?: string; beat?: number }
const ME = Math.random().toString(36).slice(2)
const read = (): Saved => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (v && Number.isInteger(v.fails) && v.fails >= 0 && typeof v.left === 'number' && v.left >= 0) return { fails: v.fails, left: v.left, by: typeof v.by === 'string' ? v.by : undefined, beat: typeof v.beat === 'number' ? v.beat : undefined }
  } catch { /* unreadable: as if no miss */ }
  return { fails: 0, left: 0 }
}
const write = (s: Saved) => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {} }

let ticking: ReturnType<typeof setInterval> | null = null
let last = 0
function serve() {
  if (ticking) return
  last = performance.now()
  ticking = setInterval(() => {
    const now = performance.now()
    const step = Math.min(STEP_MAX_MS, Math.max(0, now - last))
    last = now
    const s = read()
    if (s.left <= 0) { if (ticking) clearInterval(ticking); ticking = null; return }
    // ONE open wallet serves the wait: with the wallet open in several tabs, each would otherwise run it down, and
    // ten tabs would make an hour six minutes. Another one that served a moment ago keeps the job; it is taken over
    // only when that one has gone quiet (closed), or the clock makes its mark unreadable.
    const wall = Date.now()
    const theirs = s.by !== undefined && s.by !== ME && s.beat !== undefined && wall >= s.beat && wall - s.beat < 2 * STEP_MAX_MS
    if (theirs) return
    write({ fails: s.fails, left: Math.max(0, s.left - step), by: ME, beat: wall })
  }, 500)
}
// a wait that was running when the app was closed goes on from where it stood
if (typeof localStorage !== 'undefined' && read().left > 0) serve()

/** Milliseconds of waiting still to be served before a PIN may be tried; 0 when one may be tried now. */
export function pinWaitMs(): number {
  const left = read().left
  if (left > 0) serve()
  return left
}

export function pinFailed() {
  const fails = read().fails + 1
  const wait = WAIT_S[fails] ?? WAIT_MAX_S
  write({ fails, left: wait * 1000 })
  if (wait) serve()
}

export function pinOk() { try { localStorage.removeItem(KEY) } catch {} }

/** "0:31", "5:07", "1:00:07" */
export function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
