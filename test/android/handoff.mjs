// Device hand-off with the Android app as one of the two devices, through the public wallet server.
//   device 1  a browser on this machine (the public web wallet): creates a brand-new wallet (throwaway, never
//             funded), gets up to date from the server snapshot, switches on "Share sync from this device".
//   device 2  the Android app on the emulator/phone on adb: imports the same 24 words and says the wallet was made
//             today. By itself it would read the chain from the start (an hour); with the hand-off it must be at
//             the tip in a couple of minutes, and say where its sync came from.
//   then the other way: the app shares its own sync and the server stores it.
// The words go from one page into the other inside this process and are never printed or pictured.
// Needs the DEBUG build installed (the test drives the app's page) and a Chromium for Playwright on this machine.
//   node test/android/handoff.mjs [maxSeconds=300]
// WALLET_URL: the web wallet for device 1 (default: the one on WALLET_HOST). RESOLVE_IP: only on the server itself, where the
// public name may resolve to a private address; leave unset anywhere else.
import { _android as android, chromium } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = 'xyz.lumptools.wallet'
const PIN = '246802'
const MAX_S = Number(process.argv[2] ?? 300)
const WEB = process.env.WALLET_URL ?? `https://${process.env.WALLET_HOST ?? 'wallet-server.invalid'}/wallet/`
const RESOLVE_IP = process.env.RESOLVE_IP ?? ''
const OUT = fileURLToPath(new URL('../out/android/', import.meta.url))
mkdirSync(OUT, { recursive: true })

const checks = [], info = {}
const t00 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t00) / 1000).toFixed(0).padStart(4)}s`, ...a)
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); log(ok ? 'PASS' : 'FAIL', name, detail ? `· ${String(detail).slice(0, 220)}` : '') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pin = async (page) => { for (const d of PIN) await page.locator('.pin button', { hasText: d }).click() }
const status = (page) => page.locator('.balance + .muted').innerText().catch(() => '')
/** follow the status line until the wallet is at the tip; resolves with the seconds it took, or null */
async function atTheTip(page, name, maxS) {
  const t0 = Date.now(); let s = '', last = ''
  const seen = []
  while (Date.now() - t0 < maxS * 1000) {
    s = (await status(page)).replace(/\s+/g, ' ')
    const key = s.replace(/[\d:.%]+/g, '#')
    if (key !== last) { log(`  [${name}] ${s}`); seen.push(s); last = key }
    if (/Up to date|Getting ready/.test(s)) return { seconds: (Date.now() - t0) / 1000, seen }
    await sleep(1000)
  }
  return { seconds: null, seen }
}
const watch = (page) => {
  const hand = [], notes = [], errors = []
  page.on('response', (r) => { if (/\/api\/handoff\//.test(r.url())) hand.push(`${r.request().method()} ${r.status()}`) })
  // (every answered hand-off request is also reported once more as "aborted", in a desktop browser too: the page
  // lets go of a request it has finished with. Only failures of another kind are worth listing.)
  page.on('requestfailed', (r) => { const why = r.failure()?.errorText ?? ''; if (/\/api\/handoff\//.test(r.url()) && !/ERR_ABORTED/.test(why)) hand.push(`${r.method()} failed ${why}`) })
  page.on('console', (m) => { const t = m.text(); if (/hand-off/i.test(t)) notes.push(t.slice(0, 160)); if (m.type() === 'error' && !/Normal Closure|favicon/.test(t)) errors.push(t.slice(0, 200)) })
  return { hand, notes, errors }
}

const [device] = await android.devices()
if (!device) { console.error('no device on adb'); process.exit(2) }
device.setDefaultTimeout(90_000)
const sh = async (cmd) => (await device.shell(cmd)).toString().trim()
let shotN = 0
const shot = async (name) => { await sleep(800); await device.screenshot({ path: `${OUT}handoff-${++shotN}-${name}.png` }).catch(() => {}) }
async function appPage() {
  let pid = ''
  for (let i = 0; i < 60 && !pid; i++) { pid = (await sh(`pidof ${PKG}`).catch(() => '')).split(/\s+/)[0] || ''; if (!pid) await sleep(500) }
  for (let i = 0; i < 120; i++) { const w = device.webViews().find((v) => String(v.pid()) === pid); if (w) return w.page(); await sleep(500) }
  throw new Error('the app WebView never showed up for inspection')
}

const profile = mkdtempSync(join(tmpdir(), 'lump-hand-android-'))
let browser = null
try {
  // ---- device 1: a browser, new wallet, shares its sync ----
  browser = await chromium.launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', args: RESOLVE_IP ? [`--host-resolver-rules=MAP ${new URL(WEB).hostname} ${RESOLVE_IP}`] : [] })
  const one = browser.pages()[0] ?? await browser.newPage()
  const w1 = watch(one)
  await one.goto(WEB, { waitUntil: 'networkidle', timeout: 120_000 })   // a cold load of the 10 MB ledger can take 10-24 s, more while the server is busy
  await one.getByText('Create new wallet').click()
  await one.locator('.words').click()
  const words = await one.locator('.words .word').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()))
  await one.getByText('I wrote them down').click()
  const labels = one.locator('label')
  for (let k = 0; k < await labels.count(); k++) {
    const n = Number((await labels.nth(k).locator('span').innerText()).replace(/[^0-9]/g, ''))
    await labels.nth(k).locator('input').fill(words[n - 1])
  }
  await one.getByText('Continue').click()
  await pin(one); await pin(one)
  await one.getByText('Fee energy', { exact: true }).waitFor({ timeout: 120_000 })
  const t1 = await atTheTip(one, 'browser', MAX_S)
  check('device 1 (browser, new wallet) is at the tip', t1.seconds != null, `${t1.seconds?.toFixed(0)} s`)
  await one.locator('button[title="Settings"]').click()
  await one.getByText('My devices').click()
  await one.getByText('Share sync from this device').click()
  const sent = await one.getByText(/^Sent at /).waitFor({ timeout: 60_000 }).then(() => true, () => false)
  check('device 1 shared its sync and the server stored it', sent && w1.hand.some((h) => /^PUT 204/.test(h)), `requests: ${w1.hand.join(', ')}`)

  // ---- device 2: the Android app, same words, made "today" ----
  await sh(`am force-stop ${PKG}`)
  await sh(`pm clear ${PKG}`)
  await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => {})
  await sh(`am start -n ${PKG}/.MainActivity`)
  let two = await appPage()
  const w2 = watch(two)
  await two.getByText('I already have a wallet').waitFor({ timeout: 120_000 })
  // a test build is older than the published one and is told so (emu.mjs looks at that prompt): put it off here
  const later = two.getByRole('dialog', { name: 'Update available' }).getByRole('button', { name: 'Later' })
  if (await later.waitFor({ timeout: 20_000 }).then(() => true, () => false)) await later.click()
  info.app = await two.evaluate(() => ({ ua: navigator.userAgent, compression: typeof CompressionStream, decompression: typeof DecompressionStream }))
  await two.getByText('I already have a wallet').click()
  await two.locator('textarea').fill(words.join(' '))
  await two.getByText('Continue').click()
  await two.getByText(/Today or yesterday/).click()
  await two.locator('.pin button').first().waitFor()
  await sh('input keyevent KEYCODE_ESCAPE').catch(() => {}) // the words field may have left the keyboard open
  await sleep(700)
  await pin(two); await pin(two)
  const tPin = Date.now()
  await two.getByText('Fee energy', { exact: true }).waitFor({ timeout: 180_000 })
  const t2 = await atTheTip(two, 'android', MAX_S)
  info.android = { secondsToTip: t2.seconds, statuses: t2.seen, handoffRequests: [...w2.hand], notes: [...w2.notes] }
  check('the Android app fetched the hand-off when it started', w2.hand.some((h) => /^GET 200/.test(h)), `requests: ${w2.hand.join(', ') || 'none'}`)
  check('the Android app (same words, imported) is at the tip in minutes instead of an hour', t2.seconds != null, t2.seconds != null ? `${t2.seconds.toFixed(0)} s after the PIN · ${t2.seen.slice(0, 4).join(' → ')}` : `not after ${MAX_S} s · ${t2.seen.slice(-3).join(' → ')}`)
  await shot('android-picked-up')
  await two.locator('button[title="Settings"]').click()
  await two.getByText('My devices').click()
  const says = await two.getByText(/Picked up from another device at/).waitFor({ timeout: 8000 }).then(() => true, () => false)
  check('the Android app says where its sync came from', says, w2.notes.slice(0, 2).join(' | '))
  await shot('android-my-devices')

  // ---- the other way: the app shares ----
  const before = w2.hand.length
  await two.getByText('Share sync from this device').click()
  const sent2 = await two.getByText(/^Sent at /).waitFor({ timeout: 90_000 }).then(() => true, () => false)
  const line = await two.getByText(/^(Sent at |Could not send|Not sent yet|Sending)/).first().innerText().catch(() => '')
  check('the Android app shares its own sync and the server stores it', sent2 && w2.hand.slice(before).some((h) => /^PUT 204/.test(h)), `${line} · requests: ${w2.hand.slice(before).join(', ') || 'none'}`)
  await shot('android-sharing')
  // the WebView asks for /favicon.ico by itself (404, not the app's request); its console line names no address
  const failed404 = await two.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => e.name)).catch(() => [])
  const onlyFavicon = failed404.every((u) => /\/favicon\.ico$/.test(u))
  const faults = w2.errors.filter((e) => !(onlyFavicon && /^Failed to load resource: the server responded with a status of 404/.test(e)))
  check('no page errors in the app during the hand-off', faults.length === 0, [...faults.slice(0, 3), ...failed404.filter((u) => !/\/favicon\.ico$/.test(u)).slice(0, 3)].join(' | '))
  info.secondsFromPinToTip = t2.seconds
  void tPin
} catch (e) {
  check('run completed', false, e.stack?.split('\n').slice(0, 3).join(' ') ?? String(e))
  await shot('failure')
} finally {
  await browser?.close().catch(() => {})
  await sleep(1000)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

const failed = checks.filter((c) => !c.ok)
writeFileSync(OUT + 'handoff-report.json', JSON.stringify({ at: new Date().toISOString(), seconds: Number(((Date.now() - t00) / 1000).toFixed(0)), passed: checks.length - failed.length, failed: failed.length, checks, info }, null, 2))
console.log(`\nhand-off on Android: ${checks.length - failed.length} passed, ${failed.length} failed`)
for (const c of failed) console.log('  FAIL', c.name, '·', c.detail)
await device.close().catch(() => {})
process.exit(failed.length ? 1 : 0)
