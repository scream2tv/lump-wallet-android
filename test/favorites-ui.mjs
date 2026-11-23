// Favorite sites on the Apps screen (core/favorites.ts, ui/Apps.tsx), in a web build with a THROWAWAY new wallet.
//   - a device starts with the three default sites as favorites, in order
//   - Edit removes one; a removed default stays removed after a restart
//   - a site that was opened stands under Recent with a star; the star makes it a favorite and it leaves Recent
//   - the list is kept on the device and nothing else is stored with it
// The star in the browser's own top bar needs the in-app browser: test/android/emu.mjs taps it on a device.
// Starts its own wallet server and dev server (3154 / 5185) and stops them again.
//   node test/favorites-ui.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = 'http://127.0.0.1:5185', PIN = '246802'
const profile = mkdtempSync(join(tmpdir(), 'lump-favorites-'))
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, STATIC_PORT: '3154', WALLET_API: 'http://127.0.0.1:3154' }
const kids = [
  spawn(process.execPath, ['server/static.mjs'], { cwd: ROOT, env, stdio: 'ignore' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5185', '--strictPort'], { cwd: ROOT, env, stdio: 'ignore' }),
]

let ctx
try {
  for (let i = 0; i < 240; i++) { if (await fetch(BASE).then((r) => r.ok).catch(() => false)) break; await sleep(500) }
  ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  const page = ctx.pages()[0] ?? await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Normal Closure|closed before the connection|WebSocket is not connected/.test(m.text())) errors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`))
  // a site handed to the device's browser must not load the real site during the test
  await ctx.route((u) => !u.href.startsWith(BASE) && !/127\.0\.0\.1|localhost/.test(u.hostname), (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }))
  const pin = async () => { for (const d of PIN) await page.locator('.pin button', { hasText: d }).click() }
  const text = async () => (await page.locator('.screen').first().innerText()).replace(/\s+/g, ' ')
  const names = () => page.locator('[data-favorites] .token .name').allInnerTexts()
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('lump.browser.favorites.v1') ?? 'null'))
  const openApps = async () => { await page.locator('.action', { hasText: 'Apps' }).click(); await page.getByPlaceholder('Search or enter address').waitFor({ timeout: 15_000 }) }

  await page.goto(BASE, { waitUntil: 'load' })
  await page.getByText('Create new wallet').click()
  await page.locator('.words').click()
  const words = await page.locator('.words .word').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()))
  await page.getByText('I wrote them down').click()
  const labels = page.locator('label')
  for (let k = 0; k < await labels.count(); k++) { const n = Number((await labels.nth(k).locator('span').innerText()).replace(/[^0-9]/g, '')); await labels.nth(k).locator('input').fill(words[n - 1]) }
  await page.getByText('Continue').click()
  await pin(); await pin()
  await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 120_000 })

  // ---- the defaults ----
  await openApps()
  let n = await names()
  check(JSON.stringify(n) === JSON.stringify(['LumpTools', 'LumpFun', 'Midnight Station']), `a device starts with the three default sites as favorites, in order: ${n.join(', ')}`)
  let t = await text()
  check(/Favorites Edit/.test(t) && /Markets, wallets and NFTs on Midnight/.test(t) && /NFT marketplace on Midnight/.test(t) && !/Recent/.test(t), 'each has its line, and there is an Edit; nothing is under Recent yet')
  check((await page.locator('[data-favorites] img.logo.site').count()) === 3, 'each shows its site\'s own mark')
  await page.screenshot({ path: join(ROOT, 'test/out/favorites-1.png'), fullPage: true })

  // ---- a favorite opens; Edit removes one ----
  let popup = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null)
  await page.locator('[data-favorites] .token', { hasText: 'Midnight Station' }).first().click()
  let p = await popup
  check(!!p && p.url().startsWith('https://midnightstation.io'), `a tap opens the favorite (${p ? p.url() : 'not opened'})`)
  if (p) await p.close().catch(() => {})
  await page.getByText('Edit', { exact: true }).click()
  popup = ctx.waitForEvent('page', { timeout: 1500 }).catch(() => null)
  await page.locator('[data-favorites] .token', { hasText: 'LumpTools' }).locator('button').first().click()
  check((await popup) === null, 'while editing, a tap on a row opens nothing')
  await page.getByRole('button', { name: 'Remove LumpFun' }).click()
  await page.getByText('Done', { exact: true }).click()
  n = await names()
  check(JSON.stringify(n) === JSON.stringify(['LumpTools', 'Midnight Station']), `Edit, the cross on LumpFun, Done: ${n.join(', ')}`)

  // ---- a site that was opened: under Recent with a star; the star makes it a favorite ----
  await page.getByPlaceholder('Search or enter address').fill('example.org/shop?x=1')
  popup = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null)
  await page.keyboard.press('Enter')
  p = await popup
  if (p) await p.close().catch(() => {})
  await page.getByText('Recent', { exact: true }).waitFor({ timeout: 10_000 })
  t = await text()
  check(/Recent Clear .{0,6}example\.org/.test(t), 'a site opened from the address field stands under Recent')
  // LumpFun is no favorite any more: opened again, it is a recent site like any other
  await page.getByPlaceholder('Search or enter address').fill('lumpfun.com')
  popup = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null)
  await page.keyboard.press('Enter')
  p = await popup
  if (p) await p.close().catch(() => {})
  await page.getByRole('button', { name: 'Add to favorites' }).first().waitFor({ timeout: 10_000 })
  check((await page.getByRole('button', { name: 'Add to favorites' }).count()) === 2, 'each recent site has a star')
  await page.locator('.token', { hasText: 'example.org' }).getByRole('button', { name: 'Add to favorites' }).click()
  n = await names()
  t = await text()
  check(n.length === 3 && n[2] === 'example.org' && !/Recent Clear .{0,6}example\.org/.test(t), `the star makes it a favorite, last in the list, and it leaves Recent: ${n.join(', ')}`)
  await page.locator('.token', { hasText: 'lumpfun.com' }).getByRole('button', { name: 'Add to favorites' }).click()
  n = await names()
  t = await text()
  check(n.length === 4 && n[3] === 'LumpFun' && /Launch and trade tokens/.test(t) && !/Recent/.test(t), `one of the default sites put back has its name and line again: ${n.join(', ')}`)
  await page.screenshot({ path: join(ROOT, 'test/out/favorites-2.png'), fullPage: true })

  // ---- kept on the device ----
  const s = await stored()
  check(s && s.list.length === 4 && s.offered.length === 3 && Object.keys(s).sort().join() === 'list,offered' && s.list.every((f) => Object.keys(f).every((k) => ['url', 'name', 'hint'].includes(k))), 'the list is kept on the device: addresses, names and lines, nothing else')
  await page.getByText('Edit', { exact: true }).click()
  await page.getByRole('button', { name: 'Remove Midnight Station' }).click()
  await page.getByText('Done', { exact: true }).click()
  await page.reload({ waitUntil: 'load' })
  await page.getByText('Enter your PIN').waitFor({ timeout: 60_000 })
  await pin()
  await page.getByText('Fee energy', { exact: true }).waitFor({ timeout: 120_000 })
  await openApps()
  n = await names()
  check(JSON.stringify(n) === JSON.stringify(['LumpTools', 'example.org', 'LumpFun']), `after a restart the list is as it was left, and a removed default stays removed: ${n.join(', ')}`)
  // every one removed: the screen says how to get one
  await page.getByText('Edit', { exact: true }).click()
  for (const name of n) await page.getByRole('button', { name: `Remove ${name}` }).click()
  await page.getByText('Done', { exact: true }).click()
  check(/Favorites None\. Open a site and tap the star at the top to keep it here/.test(await text()), 'with none left the screen says how to keep one')
  check(errors.length === 0, `no page errors (${errors.length}${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''})`)
} catch (e) {
  failed++
  console.log('FAILED', String(e?.message ?? e).slice(0, 500))
} finally {
  await ctx?.close().catch(() => {})
  for (const k of kids) k.kill()
  await sleep(600)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
