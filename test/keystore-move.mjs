// The device key moves from the web view's own store into the system's key store when the app's shell gets one
// (core/vault.ts moveToSystemStore; on Android the store is SecureStorePlugin.java, the Android Keystore).
// The upgrade every installed Android copy goes through, played in a browser: two wallets are made as an app WITHOUT
// a system key store makes them, then the same data is opened by a page that has one (a stand-in for the native
// plugin, answering through Capacitor's own native-call path). Checked: nothing is lost when the move is stopped
// half-way, every wallet ends up under the system store's key, the old key is gone only then, the wallets still open
// (after a restart too), and the app's data without the system store's key cannot be opened at all.
// Throwaway wallets, never funded. Starts its own servers (dev 5186, wallet server 3155).
//   node test/keystore-move.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = 'http://127.0.0.1:5186', PIN = '246802'
const profile = mkdtempSync(join(tmpdir(), 'lump-keystore-'))
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, STATIC_PORT: '3155', WALLET_API: 'http://127.0.0.1:3155' }
const kids = [
  spawn(process.execPath, ['server/static.mjs'], { cwd: ROOT, env, stdio: 'ignore' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5186', '--strictPort'], { cwd: ROOT, env, stdio: 'ignore' }),
]

// A stand-in for the native SecureStore plugin, installed before the page's own code runs. Capacitor then reports
// the platform as android and sends the plugin's calls through `nativePromise`, as it does in the app. What the
// stand-in keeps lives under one localStorage name of its own, so a test can take it away ("another phone").
// `window.__storeFault`: 'down' makes every call fail (a key store with a problem).
const NATIVE = `
  window.CapacitorCustomPlatform = { name: 'android' }
  ;(() => {
    const AT = '__system_store__'
    const all = () => JSON.parse(localStorage.getItem(AT) || '{}')
    const methods = ['get', 'set', 'remove', 'biometry', 'setBio', 'getBio', 'removeBio']
    window.Capacitor = {
      PluginHeaders: [{ name: 'SecureStore', methods: methods.map((name) => ({ name, rtype: 'promise' })) }],
      nativePromise: async (plugin, method, o) => {
        if (plugin !== 'SecureStore') throw new Error('not implemented')
        if (localStorage.getItem('__store_fault__') === 'down') throw new Error('the key store could not be read: KeyStoreException')
        const s = all()
        if (method === 'get') return { value: Object.prototype.hasOwnProperty.call(s, o.key) ? s[o.key] : null }
        if (method === 'set') { s[o.key] = o.value; localStorage.setItem(AT, JSON.stringify(s)); return }
        if (method === 'remove') { delete s[o.key]; localStorage.setItem(AT, JSON.stringify(s)); return }
        if (method === 'biometry') return { kind: 'none' }
        if (method === 'getBio') return { value: null }
        if (method === 'removeBio') return
        throw new Error('not available')
      },
    }
  })()
`
// the move stopped half-way: storing the second wallet's moved lock fails once
const STOP_AT_SECOND = `
  ;(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (k, v) {
      if (String(k) === 'lump.vault.v1@w2' && /"where":"keychain"/.test(String(v)) && !sessionStorage.getItem('__stopped__')) { sessionStorage.setItem('__stopped__', '1'); throw new Error('storage failed (test)') }
      return set.call(this, k, v)
    }
  })()
`

let ctx
try {
  for (let i = 0; i < 240; i++) { if (await fetch(BASE).then((r) => r.ok).catch(() => false)) break; await sleep(500) }
  ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  const errors = []
  const watch = (page) => {
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Normal Closure|closed before the connection|WebSocket is not connected|not implemented/i.test(m.text())) errors.push(m.text().slice(0, 200)) })
    page.on('pageerror', (e) => { if (!/not implemented/i.test(String(e))) errors.push(`pageerror: ${String(e).slice(0, 200)}`) })
  }
  let page = ctx.pages()[0] ?? await ctx.newPage()
  watch(page)
  const pin = async () => { for (const d of PIN) await page.locator('.pin button', { hasText: d }).click() }
  const home = () => page.getByText('Fee energy', { exact: true })
  const blob = (id) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), id === 'w1' ? 'lump.vault.v1' : `lump.vault.v1@${id}`)
  const systemStore = () => page.evaluate(() => JSON.parse(localStorage.getItem('__system_store__') ?? '{}'))
  const browserKey = () => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('lump-device', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('keys')
    r.onsuccess = () => { const q = r.result.transaction('keys').objectStore('keys').get('vault-v1'); q.onsuccess = () => { r.result.close(); res(q.result instanceof CryptoKey) }; q.onerror = () => { r.result.close(); res(false) } }
    r.onerror = () => res(false)
  }))
  const writeDown = async () => {
    await page.locator('.words').click()
    const words = await page.locator('.words .word').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()))
    await page.getByText('I wrote them down').click()
    const labels = page.locator('label')
    for (let k = 0; k < await labels.count(); k++) {
      const n = Number((await labels.nth(k).locator('span').innerText()).replace(/[^0-9]/g, ''))
      await labels.nth(k).locator('input').fill(words[n - 1])
    }
    await page.getByText('Continue').click()
    return words
  }
  const onWallet = async (name) => {
    await page.locator('[data-wallets]', { hasText: name }).waitFor({ timeout: 120_000 })
    await home().waitFor({ timeout: 120_000 })
    await page.waitForFunction(() => !!window.__lump?.session?.snap?.unshieldedAddress, null, { timeout: 180_000 })
    return page.evaluate(() => window.__lump.session.snap.unshieldedAddress)
  }
  /** A new page of the same device, with or without the system key store (and with more start-up script). */
  const restart = async (script) => {
    await page.close()
    page = await ctx.newPage()
    watch(page)
    if (script) await page.addInitScript({ content: script })
    await page.goto(BASE, { waitUntil: 'load' })
  }
  const unlock = async () => { await page.getByText('Enter your PIN').waitFor({ timeout: 30_000 }); await pin() }

  // ---- an app without a system key store: two wallets, their device key in the web view's own store ----
  await page.goto(BASE, { waitUntil: 'load' })
  await page.getByText('Create new wallet').click()
  await writeDown()
  await pin(); await pin()
  const a1 = await onWallet('Wallet 1')
  await page.locator('[data-wallets]').click()
  await page.getByRole('button', { name: 'Add a wallet' }).click()
  await page.getByText('Create new wallet').click()
  await writeDown()
  const a2 = await onWallet('Wallet 2')
  const before1 = await blob('w1'), before2 = await blob('w2')
  check(before1?.v === 2 && before1.where === 'browser' && before2?.v === 2 && before2.where === 'browser' && await browserKey(), 'before: two wallets, each under the PIN and a device key that the web view itself keeps')

  // ---- the update arrives: the same data, now with a system key store. The move is stopped half-way ----
  await restart(NATIVE + STOP_AT_SECOND)
  await unlock()
  const mid = await onWallet('Wallet 2')
  const mid1 = await blob('w1'), mid2 = await blob('w2')
  check(mid === a2, 'the wallet opens with the PIN as before, although the move did not finish')
  check(mid1.where === 'keychain' && mid2.where === 'browser' && mid2.ct === before2.ct, `stopped half-way, each wallet names the store its key is in (first: ${mid1.where}, second: ${mid2.where}, untouched)`)
  check(await browserKey() && typeof (await systemStore())['vault-device-key-v1'] === 'string', 'and both keys are still there: nothing is thrown away before every wallet is moved')
  check(mid1.salt === before1.salt && mid1.iv === before1.iv && mid1.ct !== before1.ct, 'the moved wallet kept its PIN lock (same salt and inner nonce) under a new outer lock')
  // both wallets open in this state
  await page.locator('[data-wallets]').click()
  await page.locator('[data-wallet="w1"]').click()
  check((await onWallet('Wallet 1')) === a1, 'the wallet whose lock was moved opens')
  const keyMid = (await systemStore())['vault-device-key-v1']

  // ---- the next unlock finishes the move ----
  await restart(NATIVE)
  await unlock()
  await onWallet('Wallet 1')
  const end1 = await blob('w1'), end2 = await blob('w2')
  check(end1.where === 'keychain' && end2.where === 'keychain' && end1.ct === mid1.ct, 'the next unlock moves the rest: every wallet is under the system store\'s key, and what was moved already is left alone')
  check((await systemStore())['vault-device-key-v1'] === keyMid, 'under the SAME system key as the first half (no second key was made)')
  check(!(await browserKey()), 'only now is the old key gone from the web view\'s store')
  await page.locator('[data-wallets]').click()
  await page.locator('[data-wallet="w2"]').click()
  check((await onWallet('Wallet 2')) === a2, 'the other wallet opens too')

  // ---- Settings says where the key is ----
  await page.locator('.icon-btn[title="Settings"]').click()
  await page.getByText('Security', { exact: true }).click()
  await page.getByText(/Lock again after/).waitFor({ timeout: 10_000 })
  const settings =(await page.locator('.screen').first().innerText()).replace(/\s+/g, ' ')
  check(/a key kept in the Keystore of this device/.test(settings) && /cannot be opened anywhere else/.test(settings), 'Settings: the phrase is locked with the PIN and a key in the Keystore of this device')

  // ---- a third wallet after the move goes under the system key as well ----
  for (let i = 0; i < 3 && !(await home().isVisible().catch(() => false)); i++) { await page.getByText('‹ Back').click(); await page.waitForTimeout(300) }
  await page.locator('[data-wallets]').click()
  await page.getByRole('button', { name: 'Add a wallet' }).click()
  await page.getByText('Create new wallet').click()
  await writeDown()
  await onWallet('Wallet 3')
  const b3 = await blob('w3')
  check(b3?.v === 2 && b3.where === 'keychain' && (await systemStore())['vault-device-key-v1'] === keyMid && !(await browserKey()), 'a wallet added afterwards is locked with the same system key')

  // ---- after a restart everything opens with the key from the system store ----
  await restart(NATIVE)
  await unlock()
  check(!!(await onWallet('Wallet 3')), 'after a restart the PIN opens the wallet in use')
  check(JSON.stringify(await blob('w1')) === JSON.stringify(end1), 'and nothing is rewritten when there is nothing left to move')

  // ---- a key store with a problem is not "no key": nothing is given up ----
  await restart(NATIVE)
  await page.evaluate(() => localStorage.setItem('__store_fault__', 'down'))
  await page.reload({ waitUntil: 'load' })
  await unlock()
  await page.getByText(/Could not read this device's secure storage/).waitFor({ timeout: 20_000 }).catch(() => {})
  const faultText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check(/Could not read this device's secure storage/.test(faultText) && !/Restore needed/.test(faultText), 'while the key store cannot be read, the wallet says so and asks to try again (no "Restore needed")')
  await page.evaluate(() => localStorage.removeItem('__store_fault__'))
  await page.reload({ waitUntil: 'load' })
  await unlock()
  check(!!(await onWallet('Wallet 3')), 'and opens again once the key store answers')

  // ---- the app's data without the phone's key store: nothing opens it ----
  await page.evaluate(() => localStorage.removeItem('__system_store__'))
  await restart(NATIVE)
  await unlock()
  await page.getByText('Restore needed').waitFor({ timeout: 20_000 }).catch(() => {})
  check(await page.getByText('Restore needed').isVisible(), 'the same files with another phone\'s (empty) key store: "Restore needed", with the right PIN')
  check(JSON.stringify(await blob('w1')) === JSON.stringify(end1) && Object.keys(await systemStore()).length === 0, 'and no new key was put in the missing one\'s place')

  check(errors.length === 0, `no errors in the page's console (${errors.slice(0, 3).join(' | ') || 'none'})`)
} catch (e) {
  console.log('FAIL the test itself: ' + String(e?.stack ?? e).slice(0, 700)); failed++
  try { await ctx?.pages().at(-1)?.screenshot({ path: join(ROOT, 'test/out/keystore-move-failed.png') }) } catch {}
} finally {
  await ctx?.close().catch(() => {})
  for (const k of kids) k.kill()
  await sleep(700)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
