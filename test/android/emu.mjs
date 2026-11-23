// The Android app on a running emulator or a phone on adb: a new (throwaway, never funded) wallet from first launch
// to "Up to date", the system Back button, the in-app browser with a real connect from a real site, what the
// browser view is not allowed to reach, and the wallet surviving an app restart. Needs a DEBUG build (the test
// drives the app's WebViews through their inspection socket, which a release build does not open).
//   adb install -r android/app/build/outputs/apk/debug/app-debug.apk && node test/android/emu.mjs
// Screenshots of the real screen + report.json go to test/out/android/. Exit code 1 when a check fails.
import { _android as android } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const PKG = 'xyz.lumptools.wallet'
const PIN = '246802'
const SITE = { name: 'LumpTools', host: 'lumptools.xyz' }
const SYNC_MAX_S = Number(process.env.SYNC_MAX_S ?? 420)
const OUT = fileURLToPath(new URL('../out/android/', import.meta.url))
mkdirSync(OUT, { recursive: true })

const checks = []
const info = {}
const t00 = Date.now()
const stamp = () => `${((Date.now() - t00) / 1000).toFixed(0).padStart(4)}s`
const log = (...a) => console.log(stamp(), ...a)
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); log(ok ? 'PASS' : 'FAIL', name, detail ? `· ${String(detail).slice(0, 200)}` : '') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim()

const [device] = await android.devices()
if (!device) { console.error('no device on adb'); process.exit(2) }
device.setDefaultTimeout(90_000)
const sh = async (cmd) => (await device.shell(cmd)).toString().trim()
let shotN = 0
// the picture is taken a moment later: the screen is a frame or two behind what the page already reports
const shot = async (name) => { const f = `${String(++shotN).padStart(2, '0')}-${name}.png`; await sleep(800); await device.screenshot({ path: OUT + f }).catch((e) => log('screenshot failed', f, e.message)); return f }

info.device = { model: await sh('getprop ro.product.model'), android: await sh('getprop ro.build.version.release'), sdk: await sh('getprop ro.build.version.sdk') }
info.webviewPackage = (await sh('dumpsys webviewupdate | grep -i "current webview package"').catch(() => '')).replace(/\s+/g, ' ')
log('device', JSON.stringify(info.device), info.webviewPackage)

const pidOf = async () => (await sh(`pidof ${PKG}`).catch(() => '')).split(/\s+/)[0] || ''
/** The wallet page of the running app (a fresh inspection connection per app process). */
async function walletPage() {
  let pid = ''
  for (let i = 0; i < 60 && !pid; i++) { pid = await pidOf(); if (!pid) await sleep(500) }
  if (!pid) throw new Error('app process did not start')
  for (let i = 0; i < 120; i++) {
    const w = device.webViews().find((v) => String(v.pid()) === pid)
    if (w) { const page = await w.page(); return { page, pid } }
    await sleep(500)
  }
  throw new Error('the app WebView never showed up for inspection')
}
const pin = async (page) => { for (const d of PIN) await page.locator('.pin button', { hasText: d }).click() }
const status = (page) => page.locator('.balance + .muted').innerText().catch(() => '')
const foreground = async () => { const s = await sh('dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -4').catch(() => ''); return s.includes(PKG) }
// at a person's pace: a Back sent 100 ms after the previous one's screen change raced the window manager once
// (run 4: the app asked to go to the background and the emulator left it in front)
const pressBack = async () => { await sleep(1200); return sh('input keyevent KEYCODE_BACK') }

// ---- raw inspection access to the second (dApp) WebView: its page is a separate target on the same socket ----
const DEVTOOLS_PORT = 9333
async function dappTarget(pid, hostPart, maxS = 60) {
  try { adb('forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${pid}`) } catch (e) { throw new Error('adb forward failed: ' + e.message) }
  for (let i = 0; i < maxS * 2; i++) {
    const list = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`).then((r) => r.json()).catch(() => [])
    const t = list.find((x) => x.type === 'page' && String(x.url).includes(hostPart))
    if (t) return t
    await sleep(500)
  }
  throw new Error(`no inspectable page for ${hostPart}`)
}
function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  let id = 0
  const waiting = new Map()
  ws.on('message', (m) => { const j = JSON.parse(String(m)); const w = waiting.get(j.id); if (w) { waiting.delete(j.id); j.error ? w.reject(new Error(j.error.message)) : w.resolve(j.result) } })
  const open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const send = async (method, params = {}) => { await open; const n = ++id; return new Promise((resolve, reject) => { waiting.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })) }) }
  /** Evaluate in the page; promises are awaited; the value comes back by JSON. */
  const evaluate = async (expression, timeoutMs = 60_000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
      sleep(timeoutMs).then(() => { throw new Error('evaluate timed out') }),
    ])
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  return { evaluate, close: () => ws.close() }
}

let failedHard = null
try {
  // ---- first launch ----
  await sh(`am force-stop ${PKG}`)
  await sh(`pm clear ${PKG}`)
  await sh(`pm grant ${PKG} android.permission.CAMERA`).catch(() => {})
  // asked once during a long sync (KeepAwakePlugin): answered here, so that no system window ever covers the app
  await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => {})
  const tLaunch = Date.now()
  await sh(`am start -n ${PKG}/.MainActivity`)
  let { page, pid } = await walletPage()
  const errors = []
  const badResponses = []
  const watch = (p) => {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)) })
    p.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 240)))
    p.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().slice(0, 160)}`) })
    // a request the page itself called off (ERR_ABORTED: a lookup it no longer needs) is not a failure
    p.on('requestfailed', (r) => { const why = r.failure()?.errorText ?? ''; if (!/ERR_ABORTED/.test(why)) badResponses.push(`failed ${r.url().slice(0, 160)} ${why}`) })
  }
  watch(page)
  // the wallet's live connections (node, indexer): which are open, and whether anything arrives on them
  const sockets = []
  page.on('websocket', (ws) => {
    const rec = { path: ws.url().replace(/^wss?:\/\/[^/]+/, '').slice(0, 60), at: Date.now(), frames: 0, closed: false }
    sockets.push(rec)
    ws.on('framereceived', () => { rec.frames++ })
    ws.on('close', () => { rec.closed = true })
  })
  await page.getByText('Create new wallet').waitFor({ timeout: 120_000 })
  info.failedAtLoad = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => `${e.responseStatus} ${e.name}`)).catch(() => [])
  info.firstScreenSeconds = Number(((Date.now() - tLaunch) / 1000).toFixed(1))
  info.wallet = await page.evaluate(() => ({ origin: location.origin, ua: navigator.userAgent, platform: window.Capacitor?.getPlatform?.(), native: window.Capacitor?.isNativePlatform?.(), w: innerWidth, h: innerHeight, dpr: devicePixelRatio, safeTop: getComputedStyle(document.documentElement).getPropertyValue('--sat') }))
  info.webviewVersion = (info.wallet.ua.match(/Chrome\/([\d.]+)/) ?? [])[1] ?? ''
  check('app starts and shows the welcome screen', true, `${info.firstScreenSeconds} s · WebView ${info.webviewVersion} · ${info.wallet.origin}`)
  check('runs as the native Android app', info.wallet.platform === 'android' && info.wallet.native === true, JSON.stringify({ platform: info.wallet.platform, native: info.wallet.native }))
  await shot('welcome')

  // ---- a newer build is out: this debug build is number 1, far below whatever the download page hands out ----
  // (judged only when the wallet server names a published build: a server that does not serve the route yet says nothing)
  const published = await fetch(`https://${process.env.WALLET_HOST ?? 'wallet-server.invalid'}/wallet/api/android/latest`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  info.published = Number.isSafeInteger(published?.code) ? { version: published.version, code: published.code, min: published.min } : null
  const offer = page.getByRole('dialog', { name: 'Update available' })
  const offered = await offer.waitFor({ timeout: info.published ? 30_000 : 12_000 }).then(() => true, () => false)
  info.updateOffer = offered ? (await offer.innerText()).replace(/\s+/g, ' ').slice(0, 160) : ''
  if (info.published) check('an older build says that a newer one is out', offered && info.updateOffer.includes(`build ${info.published.code}`), info.updateOffer || 'no prompt within 30 s')
  else log('SKIP an older build says that a newer one is out · the wallet server does not name a published build (route not live?)')
  if (offered) {
    await shot('update-available')
    // Update hands our download page to the phone's own browser, which comes to the front
    await offer.getByRole('button', { name: 'Update', exact: true }).click()
    let front = ''
    for (let i = 0; i < 20; i++) { await sleep(700); front = await sh('dumpsys window | grep -E "mCurrentFocus" | head -2').catch(() => ''); if (front && !front.includes(PKG)) break }
    check('Update opens the download page outside the app', !!front && !front.includes(PKG), front.replace(/\s+/g, ' ').slice(0, 140))
    await shot('update-browser')
    await sh(`am start -n ${PKG}/.MainActivity`)
    for (let i = 0; i < 20 && !(await foreground()); i++) await sleep(500)
    // system Back on the prompt = Later; the app stays in front and the welcome screen is free again
    await pressBack()
    const putOff = await offer.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true, () => false)
    check('system Back puts the update off and leaves the app in front', putOff && await foreground())
  }

  // ---- create a wallet (the words stay inside the page: the quiz is answered there, nothing is printed or pictured) ----
  await page.getByText('Create new wallet').click()
  await page.locator('.words').click()
  const words = await page.locator('.words .word').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()))
  check('24 recovery words are made', words.length === 24 && words.every((w) => /^[a-z]+$/.test(w)), `${words.length} words`)
  await page.getByText('I wrote them down').click()
  const labels = page.locator('label')
  for (let k = 0; k < await labels.count(); k++) {
    const n = Number((await labels.nth(k).locator('span').innerText()).replace(/[^0-9]/g, ''))
    await labels.nth(k).locator('input').fill(words[n - 1])
  }
  await page.getByText('Continue').click()
  await page.locator('.pin button').first().waitFor()
  await sh('input keyevent KEYCODE_ESCAPE').catch(() => {}) // the quiz may have left the keyboard open
  await sleep(700)
  await shot('pin')
  await pin(page); await pin(page)
  const t0 = Date.now()
  await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 180_000 })
  check('wallet created, Home shows', true, `${((Date.now() - t0) / 1000).toFixed(1)} s after the PIN`)
  await shot('home-syncing')
  let s = '', last = ''
  while (Date.now() - t0 < SYNC_MAX_S * 1000) {
    s = await status(page)
    if (s !== last) { log('status:', s); last = s }
    if (/Up to date/.test(s)) break
    await sleep(1500)
  }
  info.syncSeconds = Number(((Date.now() - t0) / 1000).toFixed(0))
  check('new wallet syncs to "Up to date" (node, indexer and snapshot of the build's wallet server)', /Up to date/.test(s), `${info.syncSeconds} s · last status "${s}"`)
  await shot('home')

  // ---- the Cardano tab: the wallet's Cardano address, what is on it and its buttons, on the device ----
  await page.locator('.seg button', { hasText: 'Cardano' }).click()
  await page.locator('[data-energy]').waitFor({ timeout: 8000 })
  await page.locator('[data-energy="none"]').waitFor({ timeout: 45_000 }).catch(() => {})
  info.cardanoText = (await page.locator('[data-energy]').innerText()).replace(/\s+/g, ' ')
  const cardanoButtons = await page.getByRole('button', { name: 'Register', exact: true }).isVisible() && await page.getByRole('button', { name: 'Move NIGHT and ADA out' }).isVisible() && await page.getByRole('button', { name: 'Copy address' }).isVisible()
  check('Cardano tab shows the address, what is on it, and its three buttons (the wallet server's Cardano service)', /addr1q[0-9a-z]{40,}/.test(info.cardanoText) && /On it now 0 NIGHT · 0\.00 ADA/.test(info.cardanoText) && cardanoButtons, info.cardanoText.slice(0, 200))
  await shot('home-cardano')
  // Receive and Send on this tab are about the Cardano address
  await page.locator('.action', { hasText: 'Receive' }).click()
  await page.locator('img.qr').waitFor({ timeout: 8000 }).catch(() => {})
  info.receiveCardano = (await page.locator('.screen').innerText()).replace(/\s+/g, ' ')
  check('Receive on the Cardano tab shows the Cardano address and its QR code', /addr1q[0-9a-z]{40,}/.test(info.receiveCardano) && /Your address on Cardano/.test(info.receiveCardano) && await page.locator('img.qr').isVisible(), info.receiveCardano.slice(0, 140))
  await shot('receive-cardano')
  await pressBack()
  await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 8000 }).catch(() => {})
  await page.locator('.action', { hasText: 'Send' }).click()
  await page.getByText('Send on Cardano').waitFor({ timeout: 8000 }).catch(() => {})
  await page.getByText(/Free to send/).waitFor({ timeout: 30_000 }).catch(() => {})
  info.sendCardano = (await page.locator('.screen').innerText()).replace(/\s+/g, ' ')
  check('Send on the Cardano tab opens the Cardano send (ADA or NIGHT, what is free to send)', /Send on Cardano/.test(info.sendCardano) && /Free to send: 0\.00 ADA/.test(info.sendCardano), info.sendCardano.slice(0, 140))
  await shot('send-cardano')
  await pressBack()
  await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 8000 }).catch(() => {})
  await page.locator('.seg button', { hasText: 'Public' }).click()

  // ---- Receive + the system Back button ----
  await page.locator('.action', { hasText: 'Receive' }).click()
  await page.locator('button[data-back]').first().waitFor()
  await sleep(900)
  info.receiveText = (await page.locator('.screen').innerText()).replace(/\s+/g, ' ').slice(0, 160)
  check('Receive shows a Midnight address', /mn_[a-z-]*addr/.test(info.receiveText) || /mn_/.test(await page.locator('.screen').innerHTML()), info.receiveText)
  await shot('receive')
  await pressBack()
  const homeAgain = await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 8000 }).then(() => true, () => false)
  check('system Back returns from Receive to Home', homeAgain)

  // ---- Send (screen only, nothing is sent) ----
  await page.locator('.action', { hasText: 'Send' }).click()
  await page.locator('button[data-back]').first().waitFor()
  await sleep(700)
  await shot('send')
  await pressBack()
  await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 8000 }).catch(() => {})

  // ---- Apps + the in-app browser ----
  await page.locator('.action', { hasText: 'Apps' }).click()
  await page.getByPlaceholder('Search or enter address').waitFor()
  await shot('apps')
  await page.locator('.token', { hasText: SITE.name }).first().click()
  await page.locator('.browser-bar').waitFor({ timeout: 15_000 })
  let bar = ''
  for (let i = 0; i < 90; i++) { bar = (await page.locator('.browser-bar').innerText().catch(() => '')).replace(/\s+/g, ' '); if (bar.includes(SITE.host) && !/loading/.test(bar)) break; await sleep(1000) }
  check('in-app browser opens the site and reports its address and title to the wallet bar', bar.includes(SITE.host) && !/loading/.test(bar), bar)
  // the star in the bar: lit, because this site is one of the favorites a device starts with; a tap takes it out of
  // the list, another puts it back
  {
    const star = page.locator('.browser-bar [data-fav]')
    const lit = () => star.getAttribute('data-fav', { timeout: 5000 }).catch(() => null)
    const stored = () => page.evaluate(() => (JSON.parse(localStorage.getItem('lump.browser.favorites.v1') ?? '{"list":[]}').list ?? []).map((x) => x.name))
    const first = await lit(), before = await stored()
    check('the star in the browser bar is lit on a favorite site', first === '1' && before.includes(SITE.name), `star ${first}, favorites: ${before.join(', ')}`)
    await star.click(); await sleep(400)
    const off = await lit(), without = await stored()
    await star.click(); await sleep(400)
    const on = await lit(), again = await stored()
    check('a tap on the star takes the site out of the favorites, another puts it back under its own name', off === '0' && !without.includes(SITE.name) && on === '1' && again.includes(SITE.name) && again.length === before.length, `${off} [${without.join(', ')}] then ${on} [${again.join(', ')}]`)
  }
  await sleep(2500)
  await shot('browser')

  let dapp = null
  try {
    dapp = cdp(await dappTarget(pid, SITE.host))
    const p = await dapp.evaluate(`(() => { const w = window.midnight && window.midnight.lumpwallet; return { has: !!w, name: w && w.name, apiVersion: w && w.apiVersion, rdns: w && w.rdns, origin: location.origin, ua: navigator.userAgent, bridge: typeof window.lumpWalletNative, top: window === window.top } })()`)
    info.dapp = p
    check('the site finds the wallet (connector injected before the page ran)', p.has === true, JSON.stringify({ name: p.name, apiVersion: p.apiVersion, origin: p.origin }))
    check('the browser view names itself in its user agent', /LumpWallet\/1/.test(p.ua), p.ua.slice(-60))

    // a real connect: the site asks, the wallet shows its sheet, we approve, the site gets an address back
    await dapp.evaluate(`(() => { window.__lumpTest = window.midnight.lumpwallet.connect('mainnet').then(async (api) => { const a = await api.getUnshieldedAddress(); const c = await api.getConfiguration().catch((e) => ({ error: String(e && (e.reason || e.message)) })); let proxy; try { const w = new Proxy(api, { get(t, p) { const v = Reflect.get(t, p); return typeof v === 'function' ? (...x) => v.apply(t, x) : v } }); proxy = JSON.stringify(await w.getUnshieldedAddress()).includes('mn_') ? 'ok' : 'unexpected answer' } catch (e) { proxy = 'threw: ' + String(e && e.message).slice(0, 140) } return { ok: true, address: JSON.stringify(a).slice(0, 200), config: Object.keys(c || {}), proxy } }, (e) => ({ ok: false, error: String(e && (e.reason || e.message || e)) })); return 'asked' })()`)
    const connectBtn = page.locator('button.btn:not(.ghost)', { hasText: 'Connect' })
    const sheet = await connectBtn.waitFor({ timeout: 20_000 }).then(() => true, () => false)
    check('the wallet shows its Connect sheet for the site', sheet)
    await sleep(1200) // the sheet's buttons arm after ~1 s
    await shot('connect-sheet')
    if (sheet) {
      info.sheetText = (await page.locator('.sheet, .screen').last().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
      await connectBtn.click()
      const r = await dapp.evaluate('window.__lumpTest', 60_000)
      info.connect = r
      check('approved: the site receives the wallet address through the bridge', r && r.ok === true && /mn_/.test(r.address ?? ''), JSON.stringify(r).slice(0, 220))
      // some sites wrap the connected wallet in a Proxy that hands out their own functions (mint.midnightstation.io
      // does); that only works when the wallet's object is not frozen (src/dapp/provider.js, test/provider-proxy.mjs)
      check('a site that wraps the wallet in its own Proxy can still call it', r && r.proxy === 'ok', r?.proxy ?? '')
    }
    await sleep(800)
    await shot('browser-connected')

    // what the browser view must not reach: this device's own "localhost" (where the wallet page lives)
    const reach = await dapp.evaluate(`fetch('https://localhost/', { mode: 'no-cors' }).then((r) => 'answered ' + r.status + ' ' + r.type, (e) => 'refused: ' + e.message)`, 20_000)
    const img = await dapp.evaluate(`new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('refused'); i.src = 'https://localhost/icon-192.png?' + Date.now(); setTimeout(() => res('no answer'), 8000) })`, 20_000)
    info.localhost = { fetch: reach, image: img }
    check('the browser view cannot load anything from the wallet page\'s own address', img !== 'loaded', JSON.stringify(info.localhost))
    await dapp.evaluate(`(() => { setTimeout(() => { location.href = 'https://localhost/' }, 50); return 1 })()`).catch(() => {})
    await sleep(2500)
    const stillThere = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`).then((r) => r.json()).then((l) => l.filter((x) => x.type === 'page').map((x) => x.url)).catch(() => [])
    info.afterLocalhostNav = stillThere
    check('the browser view cannot navigate to the wallet page\'s address', stillThere.filter((u) => u.startsWith('https://localhost')).length === 1 && stillThere.some((u) => u.includes(SITE.host)), stillThere.join(' | '))
  } catch (e) {
    check('in-app browser bridge checks ran', false, e.message)
  } finally {
    try { dapp?.close() } catch {}
  }

  // ---- Back: closes the browser (first page), then Apps -> Home, then Home -> background ----
  await pressBack()
  const appsAgain = await page.getByPlaceholder('Search or enter address').waitFor({ timeout: 10_000 }).then(() => true, () => false)
  check('system Back closes the in-app browser', appsAgain)
  await sleep(600)
  {
    const favs = await page.locator('[data-favorites] .token .name').allInnerTexts().catch(() => [])
    check('Apps lists the favorites: our four sites', favs.length === 4 && ['LumpTools', 'LumpFun', 'Midnight Station', 'Mint testing'].every((n) => favs.includes(n)), favs.join(', '))
  }
  await shot('apps-after-browser')
  await pressBack()
  const home3 = await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 8000 }).then(() => true, () => false)
  check('system Back returns from Apps to Home', home3)
  const errorsInUse = errors.length // what the page logs while it is being cut off in the background is looked at separately
  const requestsInUse = badResponses.length // the same for requests: Android takes the network away from a background app
  await pressBack()
  await sleep(2000)
  const fg = await foreground()
  check('system Back on Home puts the app in the background (does not kill it)', !fg && (await pidOf()) === pid, `foreground=${fg} · same process=${(await pidOf()) === pid}`)

  // ---- coming back: Android closes a background app's connections after a few seconds; the wallet has to pick up again ----
  await sleep(Number(process.env.BACKGROUND_S ?? 25) * 1000)
  const tBack = Date.now()
  await sh(`am start -n ${PKG}/.MainActivity`)
  await sleep(1500)
  if (await page.getByText('Enter your PIN').isVisible().catch(() => false)) { log('locked while away: unlocking'); await pin(page) }
  const seen = []
  let live = false, cur = ''
  while (Date.now() - tBack < 150_000) {
    cur = (await status(page)).replace(/\s+/g, ' ')
    const key = cur.replace(/[\d:.%]+/g, '#')
    if (seen[seen.length - 1]?.key !== key) { seen.push({ key, text: cur, s: Number(((Date.now() - tBack) / 1000).toFixed(0)) }); log('after return:', cur) }
    const fresh = sockets.filter((w) => w.at > tBack && !w.closed && w.frames > 0)
    live = /Up to date/.test(cur) && sockets.filter((w) => w.at <= tBack && !w.closed).length + fresh.length >= 2 && Date.now() - tBack > 20_000
    if (live) break
    await sleep(1500)
  }
  info.afterReturn = { statuses: seen.map((x) => `${x.s}s ${x.text}`), sockets: sockets.map((w) => ({ path: w.path, openedAfterReturn: w.at > tBack, frames: w.frames, closed: w.closed })) }
  check('back from the background the wallet is connected and "Up to date" again', live, `${seen.map((x) => `${x.s}s ${x.text}`).join(' → ').slice(0, 160)} · open connections ${sockets.filter((w) => !w.closed).length} (${sockets.filter((w) => w.at > tBack && !w.closed).length} new)`)
  await shot('home-after-return')

  // the node connection logs its routine reconnects ("Normal Closure") as errors: not a fault
  const real = errors.slice(0, errorsInUse).filter((e) => !/Normal Closure/.test(e))
  info.consoleErrors = real.slice(0, 12)
  info.loggedWhileAway = errors.slice(errorsInUse).filter((e) => !/Normal Closure/.test(e)).map((e) => e.slice(0, 80)).slice(0, 12)
  info.badResponses = badResponses.slice(0, 20)
  info.failedLater = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => `${e.responseStatus} ${e.name}`)).catch(() => [])
  // the WebView asks every site for /favicon.ico by itself (the page names its icon, the app has no such file): not ours
  info.failedWhileAway = badResponses.slice(requestsInUse).slice(0, 12)
  const failedRequests = [...new Set([...badResponses.slice(0, requestsInUse), ...info.failedAtLoad, ...info.failedLater])].filter((u) => !/\/favicon\.ico$/.test(u))
  const faults = failedRequests.length ? real : real.filter((e) => !/^Failed to load resource: the server responded with a status of 404/.test(e))
  check('no page errors in the wallet during the run', faults.length === 0 && failedRequests.length === 0, [...faults.slice(0, 3), ...failedRequests.slice(0, 4)].join(' | '))

  // ---- the wallet survives the app being killed ----
  await sh(`am force-stop ${PKG}`)
  await sleep(1500)
  await sh(`am start -n ${PKG}/.MainActivity`)
  ;({ page, pid } = await walletPage())
  const unlock = await page.getByText('Enter your PIN').waitFor({ timeout: 120_000 }).then(() => true, () => false)
  check('after a full restart the app asks for the PIN (the wallet is still on the device)', unlock)
  await sleep(600)
  await shot('unlock')
  if (unlock) {
    await pin(page)
    const t1 = Date.now()
    const back = await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 120_000 }).then(() => true, () => false)
    let s2 = ''
    while (back && Date.now() - t1 < 180_000) { s2 = await status(page); if (/Up to date/.test(s2)) break; await sleep(1500) }
    check('PIN unlocks and the wallet resumes from its saved state', back && /Up to date/.test(s2), `${((Date.now() - t1) / 1000).toFixed(0)} s · "${s2}"`)
    await shot('home-after-restart')
  }

  // ---- a second wallet: added under the same PIN, with its own address; then back to the first, with no PIN ----
  {
    const address = () => page.locator('.avatar + div .mono').innerText().catch(() => '')
    const first = await address()
    await page.locator('[data-wallets]').click()
    const sheet = await page.locator('[data-wallets-sheet]').waitFor({ timeout: 8000 }).then(() => true, () => false)
    await shot('wallets')
    await page.getByRole('button', { name: 'Add a wallet' }).click()
    await page.getByText('Create new wallet').click()
    await page.locator('.words').click()
    const words2 = await page.locator('.words .word').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()))
    await page.getByText('I wrote them down').click()
    const labels2 = page.locator('label')
    for (let k = 0; k < await labels2.count(); k++) {
      const n = Number((await labels2.nth(k).locator('span').innerText()).replace(/[^0-9]/g, ''))
      await labels2.nth(k).locator('input').fill(words2[n - 1])
    }
    await page.getByText('Continue').click()
    const added = await page.locator('[data-wallets]', { hasText: 'Wallet 2' }).waitFor({ timeout: 120_000 }).then(() => true, () => false)
    let second = ''
    for (let i = 0; i < 90 && (!/^mn_/.test(second) || second === first); i++) { second = await address(); await sleep(1000) }
    check('a second wallet is added with no second PIN and has its own address', sheet && added && /^mn_/.test(first) && /^mn_/.test(second) && second !== first, `${first} / ${second}`)
    await shot('wallet-2')
    await page.locator('[data-wallets]').click()
    await page.locator('[data-wallet="w1"]').click()
    const backOnFirst = await page.locator('[data-wallets]', { hasText: 'Wallet 1' }).waitFor({ timeout: 60_000 }).then(() => true, () => false)
    let again = ''
    for (let i = 0; i < 90 && again !== first; i++) { again = await address(); await sleep(1000) }
    const asked = await page.getByText('Enter your PIN').isVisible().catch(() => false)
    check('switching back needs no PIN and shows the first wallet\'s address again', backOnFirst && again === first && !asked, again)
    await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 120_000 }).catch(() => {})
    let s3 = ''
    const t3 = Date.now()
    while (Date.now() - t3 < 180_000) { s3 = await status(page); if (/Up to date/.test(s3)) break; await sleep(1500) }
    check('the first wallet is up to date again from its own saved state', /Up to date/.test(s3), `${((Date.now() - t3) / 1000).toFixed(0)} s · "${s3}"`)
  }

  // ---- the screen is held on while the wallet syncs, and only then ----
  // Looked at with NOTHING attached to the app. On Android the browser engine keeps the screen on by itself for as
  // long as a page is being inspected (run 44934844270: the app cleared its own hold 6 s into the run, per its log,
  // and the window stayed "held" for as long as this test was connected). So this part lets go of the app, starts
  // it again and unlocks it with real taps, reading the screen through accessibility like a person would.
  await sh(`am force-stop ${PKG}`)
  await device.close().catch(() => {})
  const adbTry = (...a) => { try { return adb(...a) } catch { return '' } }
  // the window that holds the screen on right now (that line of the dump also names the window covering the screen, always ours: read the one field)
  const holdsScreen = () => ((adbTry('shell', 'dumpsys window | grep -E "mHoldScreenWindow"').match(/mHoldScreenWindow=(.*?)(?:\s+m[A-Z]\w+=|$)/) ?? [])[1] ?? '').includes(PKG)
  const onScreen = () => {
    adbTry('shell', 'uiautomator dump /sdcard/lump-ui.xml')
    return [...adbTry('shell', 'cat /sdcard/lump-ui.xml').matchAll(/<node[^>]*?\btext="([^"]*)"[^>]*?\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)].map((m) => ({ text: m[1], x: (Number(m[2]) + Number(m[4])) >> 1, y: (Number(m[3]) + Number(m[5])) >> 1 }))
  }
  await sleep(1500)
  adb('shell', `am start -n ${PKG}/.MainActivity`)
  let keys = null
  for (let i = 0; i < 40 && !keys; i++) { await sleep(1500); const n = onScreen(); if (n.some((x) => /Enter your PIN/.test(x.text))) keys = n }
  if (!keys) check('the screen is held on while the wallet syncs, and only then', false, 'the PIN screen did not show with nothing attached')
  else {
    const heldBefore = holdsScreen()
    const missing = [...new Set(PIN)].filter((d) => !keys.some((k) => k.text === d))
    for (const d of PIN) { const k = keys.find((x) => x.text === d); if (k) adb('shell', `input tap ${k.x} ${k.y}`); await sleep(300) }
    const looks = []
    const tS = Date.now()
    while (Date.now() - tS < 50_000) { looks.push(holdsScreen()); await sleep(250) }
    const first = looks.indexOf(true), lastHeld = looks.lastIndexOf(true)
    const perLook = 50 / looks.length
    info.screenHold = { heldBeforeUnlock: heldBefore, looks: looks.length, held: looks.filter(Boolean).length, fromSecond: first < 0 ? null : Number((first * perLook).toFixed(1)), toSecond: lastHeld < 0 ? null : Number((lastHeld * perLook).toFixed(1)), heldAtTheEnd: looks.slice(-8).some(Boolean), pinKeysNotFound: missing }
    check('the screen is held on while the wallet syncs, and only then', !heldBefore && first >= 0 && !info.screenHold.heldAtTheEnd,
      `locked: ${heldBefore ? 'held' : 'not held'} · after unlocking: held from ${info.screenHold.fromSecond ?? '-'} s to ${info.screenHold.toSecond ?? '-'} s · 50 s later: ${info.screenHold.heldAtTheEnd ? 'STILL held' : 'not held'}${missing.length ? ` · PIN keys not found on screen: ${missing.join(' ')}` : ''}`)
    try { writeFileSync(OUT + `${String(++shotN).padStart(2, '0')}-home-unlocked-by-taps.png`, execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })) } catch {}
  }
} catch (e) {
  failedHard = e
  check('run completed', false, e.stack?.split('\n').slice(0, 3).join(' ') ?? String(e))
  await shot('failure').catch(() => {})
}

const failed = checks.filter((c) => !c.ok)
writeFileSync(OUT + 'report.json', JSON.stringify({ at: new Date().toISOString(), seconds: Number(((Date.now() - t00) / 1000).toFixed(0)), passed: checks.length - failed.length, failed: failed.length, checks, info }, null, 2))
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed`)
for (const c of failed) console.log('  FAIL', c.name, '·', c.detail)
await device.close().catch(() => {})
process.exit(failed.length || failedHard ? 1 : 0)
