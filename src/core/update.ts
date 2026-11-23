// Android only: is the build on this phone still the one we hand out? The app is installed from our own download
// page, so nothing else tells its owner that a newer one exists. The wallet server names the published build
// (server/static.mjs: /api/android/latest, set by tools/android-publish.mjs); build numbers are compared.
//   a newer build is published          -> "Update available" (may wait; offered again a day later)
//   this build is below the server's min -> "Update needed" (the wallet waits behind it)
// No answer (offline, server down, nonsense) changes nothing: nobody is kept out of their wallet on a guess, and
// nothing is remembered across a restart. Installing over the app keeps the wallet: Android only accepts a build
// signed with the same key, whatever a server says. iOS (TestFlight) and the web build update by themselves.
import { useSyncExternalStore } from 'react'
import { Shell, isAndroidApp } from '../ui/back'
import { API_BASE } from './net'

export type Update = { version: string; code: number; size: number; installed: number; required: boolean }
type Installed = { version: string; code: number }

const LATER_KEY = 'lump.update.later.v1'
const LATER_MS = 23 * 3_600_000      // "Later" is good for about a day, or until a newer build still is published
const EVERY_MS = 187 * 60_000        // asked again when the app comes back to the front after this long
const TICK_MS = 17 * 60_000          // and looked at on this beat while it stays open
// Builds handed out are numbered by the minute they were made (tools/android-release.sh: about 30 million by now).
// A small number is a development or CI build (1, or the run number): it is offered the update like any other, but
// never made to take it, or a required build would shut every test build out of its own walk.
const HANDED_OUT_FROM = 1_000_000
const TEST = import.meta.env.DEV || import.meta.env.VITE_LOCAL === '1'

let installed: Installed | null | undefined   // undefined: not asked yet
let current: Update | null = null
let checkedAt = 0
let running: Promise<Update | null> | null = null
const subs = new Set<() => void>()

/** Test builds only: a desktop page plays an installed Android build (localStorage lump.test.android = {"version","code"}). */
function testBuild(): Installed | null {
  if (!TEST) return null
  try {
    const j = JSON.parse(localStorage.getItem('lump.test.android') ?? 'null') as Installed | null
    return j && Number.isSafeInteger(j.code) && j.code > 0 ? { version: String(j.version ?? ''), code: j.code } : null
  } catch { return null }
}

/** The build installed on this phone; null anywhere that is not the Android app. */
export async function installedBuild(): Promise<Installed | null> {
  if (installed !== undefined) return installed
  const t = testBuild()
  if (t) return (installed = t)
  if (!isAndroidApp()) return (installed = null)
  try {
    const i = await Shell.info()
    installed = Number.isSafeInteger(i.code) && i.code > 0 ? { version: String(i.version ?? ''), code: i.code } : null
  } catch { installed = null }
  return installed
}

async function ask(mine: Installed): Promise<void> {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), 9_000)
  try {
    const r = await fetch(`${API_BASE}api/android/latest`, { cache: 'no-store', signal: stop.signal })
    if (!r.ok) return
    const j = (await r.json()) as { version?: unknown; code?: unknown; min?: unknown; size?: unknown }
    const code = Number(j?.code), min = Number(j?.min ?? 0)
    if (!Number.isSafeInteger(code) || code <= 0) return
    checkedAt = Date.now()
    const next: Update | null = code > mine.code
      ? { version: /^[\d.]{1,20}$/.test(String(j.version)) ? String(j.version) : '', code, size: Number.isFinite(Number(j.size)) ? Number(j.size) : 0, installed: mine.code, required: Number.isSafeInteger(min) && mine.code < min && mine.code >= HANDED_OUT_FROM }
      : null
    // a new object each time: the screen looks again (a "Later" from yesterday has run out by now)
    if (next || current) { current = next; subs.forEach((f) => f()) }
  } catch { /* no answer: nothing changes */ } finally {
    clearTimeout(timer)
    // an answer that was not read (a 404, say) would otherwise stay open until the page goes away
    stop.abort()
  }
}

/** Ask the server now (`force`), or only when the last answer is old. Resolves with what is known afterwards. */
export function checkForUpdate(force = false): Promise<Update | null> {
  if (running) return running
  running = (async () => {
    const mine = await installedBuild()
    if (mine && (force || !checkedAt || Date.now() - checkedAt >= EVERY_MS)) await ask(mine)
    return current
  })().finally(() => { running = null })
  return running
}

/** Checks at start, whenever the app comes back to the front, and on a slow beat while it stays open. */
export function startUpdateWatch(): () => void {
  void checkForUpdate()
  const onVisible = () => { if (document.visibilityState === 'visible') void checkForUpdate() }
  document.addEventListener('visibilitychange', onVisible)
  const tick = setInterval(() => { if (document.visibilityState === 'visible') void checkForUpdate() }, TICK_MS)
  return () => { document.removeEventListener('visibilitychange', onVisible); clearInterval(tick) }
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
/** The newer build, when there is one. */
export const useUpdate = (): Update | null => useSyncExternalStore(subscribe, () => current)

/** "Later": this build is not offered again for about a day (a required one is never put off). */
export function putOff(u: Update) {
  try { localStorage.setItem(LATER_KEY, JSON.stringify({ code: u.code, at: Date.now() })) } catch {}
  if (current) current = { ...current }
  subs.forEach((f) => f())
}
export function wasPutOff(u: Update): boolean {
  if (u.required) return false
  try {
    const j = JSON.parse(localStorage.getItem(LATER_KEY) ?? 'null') as { code?: number; at?: number } | null
    const age = Date.now() - Number(j?.at)
    return !!j && j.code === u.code && age >= 0 && age < LATER_MS
  } catch { return false }
}

/** The download page of the published build, in the phone's own browser. Always our own page: never an address a server sent. */
export async function openDownload(): Promise<boolean> {
  const url = `${API_BASE}android/`
  if (TEST && testBuild()) { ((window as unknown as { __lumpOpened?: string[] }).__lumpOpened ??= []).push(url); return true }
  try { await Shell.openUrl({ url }); return true } catch { return false }
}
