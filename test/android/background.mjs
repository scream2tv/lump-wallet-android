// A sync goes on after the Android app is left (SyncService.java, KeepAwakePlugin.java).
// A throwaway wallet (24 words made here, never funded, never printed or pictured) is imported as "Earlier, or not
// sure": that is the sync that takes an hour, the one a person walks away from. Then, with NOTHING attached to the
// app (an inspected page is treated differently by the browser engine):
//   - Home is pressed: Android shows the sync service as a foreground service, with its notification
//   - 45 s later the page has kept its normal pace (a hidden page gets one timer a second) and is the same process
//   - the wallet saying "done" ends the service; asking for it from the background does no harm
//   - back in front: no service
// Needs the DEBUG build installed (the test reads the app's page).
//   adb install -r android/app/build/outputs/apk/debug/app-debug.apk && node test/android/background.mjs
import { _android as android } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

const PKG = 'xyz.lumptools.wallet'
const PIN = '246802'
const AWAY_S = Number(process.argv[2] ?? 45)
const OUT = fileURLToPath(new URL('../out/android/', import.meta.url))
mkdirSync(OUT, { recursive: true })

const checks = [], info = {}
const t00 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t00) / 1000).toFixed(0).padStart(4)}s`, ...a)
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); log(ok ? 'PASS' : 'FAIL', name, detail ? `· ${String(detail).slice(0, 240)}` : '') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const adb = (...args) => { try { return execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim() } catch { return '' } }
const pidNow = () => adb('shell', `pidof ${PKG}`).split(/\s+/)[0] || ''
/** what Android says about the sync service: running at all, and as a foreground service */
const service = () => {
  const s = adb('shell', `dumpsys activity services ${PKG}`)
  const at = s.indexOf('SyncService')
  const part = at < 0 ? '' : s.slice(at, at + 3000)
  return { there: at >= 0, foreground: /isForeground=true/.test(part), type: (part.match(/foregroundServiceType=(\w+)/) ?? part.match(/types=(\w+)/) ?? [])[1] ?? '' }
}
const noteShown = () => /SyncService|channel=sync|lumpwallet|Syncing/.test(adb('shell', `dumpsys notification --noredact | grep -A 30 "pkg=${PKG}"`))
const inFront = () => adb('shell', 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -4').includes(PKG)

let device = null
const attach = async () => {
  ;[device] = await android.devices()
  if (!device) { console.error('no device on adb'); process.exit(2) }
  device.setDefaultTimeout(90_000)
  const pid = pidNow()
  for (let i = 0; i < 120; i++) { const w = device.webViews().find((v) => String(v.pid()) === pid); if (w) return w.page(); await sleep(500) }
  throw new Error('the app WebView never showed up for inspection')
}
const detach = async () => { await device?.close().catch(() => {}); device = null }
const pin = async (page) => { for (const d of PIN) await page.locator('.pin button', { hasText: d }).click() }
const status = (page) => page.locator('.balance + .muted').innerText().catch(() => '')
const shell = (page) => page.evaluate(() => window.Capacitor.nativePromise('KeepAwake', 'state', {}))

let failedHard = null
try {
  adb('shell', `am force-stop ${PKG}`)
  adb('shell', `pm clear ${PKG}`)
  // the question a person gets once, during a long sync; answered here so that no system window covers the app
  adb('shell', `pm grant ${PKG} android.permission.POST_NOTIFICATIONS`)
  adb('shell', `am start -n ${PKG}/.MainActivity`)
  for (let i = 0; i < 60 && !pidNow(); i++) await sleep(500)
  let page = await attach()
  await page.getByText('I already have a wallet').waitFor({ timeout: 120_000 })
  const later = page.getByRole('dialog', { name: 'Update available' }).getByRole('button', { name: 'Later' })
  if (await later.waitFor({ timeout: 20_000 }).then(() => true, () => false)) await later.click()
  await page.getByText('I already have a wallet').click()
  await page.locator('textarea').fill(generateMnemonic(wordlist, 256))
  await page.getByText('Continue').click()
  await page.getByText('Earlier, or not sure').click()
  await page.locator('.pin button').first().waitFor()
  adb('shell', 'input keyevent KEYCODE_ESCAPE') // the words field may have left the keyboard open
  await sleep(700)
  await pin(page); await pin(page)
  await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 180_000 })
  // the sync has started when the shell has been told so
  let st = null
  for (let i = 0; i < 60; i++) { st = await shell(page).catch(() => null); if (st?.syncing) break; await sleep(1000) }
  const before = { status: (await status(page)).replace(/\s+/g, ' '), shell: st, service: service(), pid: pidNow() }
  info.before = before
  check('in front and syncing: the shell knows, and no service runs', !!st?.syncing && st.inFront && !st.service && !before.service.there, `${before.status} · ${JSON.stringify(st)}`)

  // the page keeps its own record: a mark every 250 ms, with what it believes about being seen
  await page.evaluate(() => {
    const marks = []
    window.__away = marks
    setInterval(() => { marks.push([Date.now(), document.visibilityState === 'visible' ? 1 : 0]) }, 250)
  })
  await sleep(16_000)   // its pace in front, with the sync running: what the pace away is measured against
  await detach()

  // ---- the app is left, with nothing attached ----
  adb('shell', 'input keyevent KEYCODE_HOME')
  const tLeft = Date.now()
  await sleep(4000)
  const away1 = { service: service(), note: noteShown(), front: inFront(), pid: pidNow() }
  info.left = away1
  check('left during a sync: Android runs the sync service in the foreground, with its notification', !away1.front && away1.service.there && away1.service.foreground && away1.note, JSON.stringify(away1))
  await sleep(AWAY_S * 1000)
  const tBack = Date.now()
  const away2 = { service: service(), pid: pidNow() }
  check(`${AWAY_S} s later the app is the same process and the service still runs`, !!away2.pid && away2.pid === before.pid && away2.service.foreground, `pid ${before.pid} → ${away2.pid || 'gone'}`)

  // ---- what the page did meanwhile (attached again, still not in front) ----
  page = await attach()
  const marks = await page.evaluate(() => window.__away ?? [])
  // by the page's own clock (the device's and this machine's need not agree): the first 15 s were in front, the last 35 s away
  const t0 = marks[0]?.[0] ?? 0, tN = marks.at(-1)?.[0] ?? 0
  const front = marks.filter(([t]) => t <= t0 + 15_000).length / 15
  const during = marks.filter(([t]) => t > tN - 35_000)
  const perSecond = during.length / 35
  const seen = during.filter(([, v]) => v).length
  const st2 = await shell(page)
  info.away = { inFrontPerSecond: Number(front.toFixed(2)), perSecond: Number(perSecond.toFixed(2)), believedVisible: seen, shell: st2, status: (await status(page)).replace(/\s+/g, ' ') }
  check('away, the page kept the pace it had in front', front > 0 && perSecond >= front * 0.6, `in front ${front.toFixed(2)} marks a second, away ${perSecond.toFixed(2)} (a timer every 250 ms, between the work of the sync) · ${seen}/${during.length} as a page that is seen · ${JSON.stringify(st2)}`)
  check('away, the wallet is still syncing', st2.syncing && st2.service && !st2.inFront, `${before.status} → ${info.away.status}`)

  // ---- the sync is done (the wallet's own word for it, said here in its place): the service ends ----
  await page.evaluate(() => window.Capacitor.nativePromise('KeepAwake', 'set', { on: false }))
  await sleep(3000)
  const done = service()
  check('the wallet says the sync is done: the service ends', !done.foreground && !noteShown(), JSON.stringify(done))
  // a sync that starts while the app is not in front: Android may refuse the service, and that must be all
  const again = await page.evaluate(() => window.Capacitor.nativePromise('KeepAwake', 'set', { on: true }).then(() => 'ok', (e) => String(e?.message ?? e)))
  await sleep(3000)
  const st3 = await shell(page).catch((e) => ({ error: String(e?.message ?? e).slice(0, 80) }))
  info.fromBackground = { answer: again, service: service(), shell: st3 }
  check('a sync that starts while the app is away does no harm', again === 'ok' && pidNow() === before.pid && st3.syncing === true, `${JSON.stringify(info.fromBackground.service)} · ${JSON.stringify(st3)}`)
  await detach()

  // ---- back in front ----
  adb('shell', `am start -n ${PKG}/.MainActivity`)
  await sleep(4000)
  const back = { service: service(), front: inFront(), pid: pidNow() }
  page = await attach()
  const st4 = await shell(page)
  check('back in front: no service, same process, the screen is the wallet', back.front && !back.service.foreground && back.pid === before.pid && st4.inFront && !st4.service, `${JSON.stringify(back)} · ${JSON.stringify(st4)}`)
  try { writeFileSync(OUT + 'background-back-in-front.png', execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })) } catch {}
} catch (e) {
  failedHard = e
  check('run completed', false, e.stack?.split('\n').slice(0, 3).join(' ') ?? String(e))
} finally {
  await detach()
  adb('shell', `am force-stop ${PKG}`)
  adb('shell', `pm clear ${PKG}`)   // the throwaway wallet goes with it
}

const failed = checks.filter((c) => !c.ok)
writeFileSync(OUT + 'background-report.json', JSON.stringify({ at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks, info }, null, 2))
console.log(`\nbackground sync on Android: ${checks.length - failed.length} passed, ${failed.length} failed`)
for (const c of failed) console.log('  FAIL', c.name, '·', c.detail)
process.exit(failed.length || failedHard ? 1 : 0)
