// "A newer build is out": what an installed Android copy shows (core/update.ts, ui/Update.tsx), played by a desktop
// page of a test build (localStorage lump.test.android = the build it pretends to be). The published build comes from
// the real server route and the real publish tool, on a throwaway folder: nothing here touches out/android/.
//   - a newer build published: "Update available"; Update opens our download page; Later puts it off, also after a reload
//   - a still newer build: offered again although the older one was put off
//   - published with --required: "Update needed", no way around it; a later ordinary publish keeps that floor
//   - the same or a newer build installed, no build published, a server that answers nonsense: nothing is shown
//   - not the Android app (iOS, web): the server is not even asked
//   - Settings names the installed build and has the row to get the newer one
// Starts its own wallet server and dev server (ports 3154 / 5185) and stops them again.
//   node test/update.mjs
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const STATIC_PORT = 3154, DEV_PORT = 5185
const BASE = `http://127.0.0.1:${DEV_PORT}`
const PIN = '246802'
const dir = mkdtempSync(join(tmpdir(), 'lump-update-apk-'))
const profile = mkdtempSync(join(tmpdir(), 'lump-update-'))
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const env = { ...process.env, WALLET_ANDROID_DIR: dir, STATIC_PORT: String(STATIC_PORT), WALLET_API: `http://127.0.0.1:${STATIC_PORT}` }
const kids = [
  spawn(process.execPath, ['server/static.mjs'], { cwd: ROOT, env, stdio: 'ignore' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(DEV_PORT), '--strictPort'], { cwd: ROOT, env, stdio: 'ignore' }),
]
/** The real publish tool on the throwaway folder; returns what it printed. */
const publish = (version, code, ...flags) => {
  const f = join(dir, `LumpWallet-${version}-${code}.apk`)
  if (!existsSync(f)) writeFileSync(f, 'not an app: a stand-in for the update test\n')
  return execFileSync(process.execPath, ['tools/android-publish.mjs', f, ...flags], { cwd: ROOT, env, encoding: 'utf8' })
}
const latest = async () => { const r = await fetch(`http://127.0.0.1:${STATIC_PORT}/api/android/latest`); return { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: await r.json().catch(() => null) } }

let ctx
try {
  for (let i = 0; i < 120; i++) { if (await fetch(BASE).then((r) => r.ok).catch(() => false)) break; await sleep(500) }

  // ---- the server route ----
  let l = await latest()
  check(l.status === 404, `nothing published: the route answers 404 (${l.status})`)
  publish('9.9.1', 30000500)
  l = await latest()
  check(l.status === 200 && l.body.code === 30000500 && l.body.min === 0 && l.body.version === '9.9.1' && l.cors === '*', `published build 30000500: ${JSON.stringify(l.body).slice(0, 90)}… (readable from the app's origin: ${l.cors})`)

  // the download page names the build and when it was published; the saved file carries the build number
  {
    const html = await fetch(`http://127.0.0.1:${STATIC_PORT}/android/`).then((r) => r.text())
    const meta = (html.match(/<p class="meta">([\s\S]*?)<\/p>/)?.[1] ?? '').replace(/<br>/g, ' | ')
    check(/Version 9\.9\.1 · build 30000500 · /.test(meta) && /Published \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d UTC/.test(meta) && html.includes('download="LumpWallet-9.9.1-30000500.apk"'), `the download page says which build it hands out: "${meta}"`)
    const head = await fetch(`http://127.0.0.1:${STATIC_PORT}/android/LumpWallet.apk`, { method: 'HEAD' })
    check(head.headers.get('content-disposition') === 'attachment; filename="LumpWallet-9.9.1-30000500.apk"', `the saved file is named after the build: ${head.headers.get('content-disposition')}`)
  }

  ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  const page = ctx.pages()[0] ?? await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Normal Closure/.test(m.text())) errors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`))
  let asked = 0
  page.on('request', (r) => { if (r.url().includes('/api/android/latest')) asked++ })
  const installed = (code) => page.evaluate((c) => { if (c) localStorage.setItem('lump.test.android', JSON.stringify({ version: '9.9.0', code: c })); else localStorage.removeItem('lump.test.android') }, code)
  const open = async () => { asked = 0; await page.goto(BASE, { waitUntil: 'networkidle' }); await page.waitForTimeout(900) }
  const sheet = page.getByRole('dialog', { name: 'Update available' })
  const wall = page.getByRole('dialog', { name: 'Update needed' })

  // ---- not the Android app ----
  await open()
  check(asked === 0 && !(await sheet.isVisible()) && !(await wall.isVisible()), `a web or iOS copy does not ask the server and shows nothing (${asked} requests)`)

  // ---- an older copy ----
  await installed(30000400)
  await open()
  await sheet.waitFor({ timeout: 10_000 }).catch(() => {})
  const said = (await sheet.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check(/Update available/.test(said) && /Version 9\.9\.1 · build 30000500/.test(said) && /Later/.test(said), `build 30000400 installed, 30000500 published: "${said.slice(0, 140)}"`)
  await page.screenshot({ path: join(ROOT, 'test/out/update-1-available.png') })
  await sheet.getByRole('button', { name: 'Update', exact: true }).click()
  const opened = await page.evaluate(() => window.__lumpOpened ?? [])
  check(opened.length === 1 && /\/android\/$/.test(opened[0]), `Update opens our own download page (${opened[0]})`)
  await sheet.getByRole('button', { name: 'Later' }).click()
  await page.waitForTimeout(300)
  check(!(await sheet.isVisible()), 'Later takes the prompt away')
  await open()
  check(asked >= 1 && !(await sheet.isVisible()), `after a restart it stays put off (the server was still asked: ${asked})`)

  // ---- a still newer build ----
  publish('9.9.2', 30000600)
  await open()
  await sheet.waitFor({ timeout: 10_000 }).catch(() => {})
  check(/build 30000600/.test(await sheet.innerText().catch(() => '')), 'a still newer build (30000600) is offered although 30000500 was put off')
  await sheet.getByRole('button', { name: 'Later' }).click()

  // ---- Settings (needs a wallet: a throwaway new one) ----
  await page.getByText('Create new wallet').click()
  await page.locator('.words').click()
  const words = await page.locator('.words .word').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()))
  await page.getByText('I wrote them down').click()
  const labels = page.locator('label')
  for (let k = 0; k < await labels.count(); k++) {
    const n = Number((await labels.nth(k).locator('span').innerText()).replace(/[^0-9]/g, ''))
    await labels.nth(k).locator('input').fill(words[n - 1])
  }
  await page.getByText('Continue').click()
  const pin = async () => { for (const d of PIN) await page.locator('.pin button', { hasText: d }).click() }
  await pin(); await pin()
  await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 120_000 })
  check(!(await sheet.isVisible()), 'put off: the wallet opens without the prompt')
  await page.locator('button[title="Settings"]').click()
  await page.getByText('Update available').waitFor({ timeout: 10_000 }).catch(() => {})
  const settings = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check(/Update available Build 30000600 is ready/.test(settings) && /Lump Wallet [\d.]+ \(30000400\)/.test(settings), 'Settings has the row to get build 30000600 and names the installed build (30000400)')
  await page.screenshot({ path: join(ROOT, 'test/out/update-2-settings.png') })
  await page.getByText('Update available').click()
  check((await page.evaluate(() => window.__lumpOpened ?? [])).length === 1, 'the Settings row opens the download page')

  // ---- a build nobody may skip ----
  const out = publish('9.9.3', 30000700, '--required')
  l = await latest()
  check(l.body.code === 30000700 && l.body.min === 30000700 && /MUST update/.test(out), `published with --required: min ${l.body.min}`)
  await open()
  await wall.waitFor({ timeout: 10_000 }).catch(() => {})
  const must = (await wall.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check(/Update needed/.test(must) && /Get the update/.test(must) && !/Later/.test(must), `"${must.slice(0, 150)}"`)
  const covered = await page.evaluate(() => { const el = document.elementFromPoint(195, 600); return !!el?.closest('[aria-label="Update needed"]') })
  check(covered && !(await sheet.isVisible()), 'the wallet (here: its PIN screen) is behind it, and there is no Later')
  await page.screenshot({ path: join(ROOT, 'test/out/update-3-needed.png') })
  await wall.getByRole('button', { name: 'Get the update' }).click()
  check((await page.evaluate(() => window.__lumpOpened ?? [])).length === 1, 'Get the update opens the download page')
  publish('9.9.4', 30000800)
  l = await latest()
  check(l.body.code === 30000800 && l.body.min === 30000700, `a later ordinary publish keeps the floor (code ${l.body.code}, min ${l.body.min})`)
  await installed(30000750)
  await open()
  await sheet.waitFor({ timeout: 10_000 }).catch(() => {})
  check((await sheet.isVisible()) && !(await wall.isVisible()), 'a copy at or above the floor (30000750) is only offered the update')
  await installed(7)
  await open()
  await sheet.waitFor({ timeout: 10_000 }).catch(() => {})
  check((await sheet.isVisible()) && !(await wall.isVisible()), 'a development build (number 7) is offered the update, never made to take it')

  // ---- nothing to say ----
  await installed(30000800)
  await open()
  check(asked >= 1 && !(await sheet.isVisible()) && !(await wall.isVisible()), 'the published build installed: nothing shown')
  await installed(30000900)
  await open()
  check(!(await sheet.isVisible()) && !(await wall.isVisible()), 'a newer build than the published one installed (a tester): nothing shown')
  await installed(30000400)
  writeFileSync(join(dir, 'published.json'), '{"file":"LumpWallet-9.9.4-30000800.apk","sha256":"zz"')
  await open()
  check((await latest()).status === 404 && !(await sheet.isVisible()) && !(await wall.isVisible()), 'a broken publish record: the route answers 404, the app shows nothing')
  unlinkSync(join(dir, 'published.json'))
  await open()
  check(!(await sheet.isVisible()) && !(await wall.isVisible()), 'no build published: nothing shown')
  await page.route('**/api/android/latest', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"code":"<script>","min":999999999999,"version":"<b>x</b>"}' }))
  await open()
  check(!(await sheet.isVisible()) && !(await wall.isVisible()), 'an answer that is not a build number: nothing shown, nobody locked out')
  await page.unroute('**/api/android/latest')

  check(errors.length === 0, `no page errors (${errors.length}${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''})`)
} catch (e) {
  console.error('FAILED', e?.message ?? e); failed++
} finally {
  await ctx?.close().catch(() => {})
  for (const k of kids) k.kill()
  await sleep(700)
  for (const d of [dir, profile]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
