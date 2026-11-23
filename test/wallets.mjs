// Several wallets on one device (core/vault.ts, core/scope.ts, ui/Wallets.tsx), with THROWAWAY wallets that are
// never funded:
//   - a device with one wallet is what it always was: its stored phrase is not rewritten by anything below
//   - Add a wallet: a new one (words, check, no second PIN) and one brought along with its 24 words; the same words
//     twice are turned down
//   - switching needs no PIN, each wallet comes back with its own addresses, and each has its own connected sites
//     and its own sync cache
//   - the wallet in use is the one a lock, and a restart, come back to; a wallet can be renamed
//   - removing ONE wallet leaves the others (also when it is the first one), and its id is not used again
//   - Forgot PIN takes every wallet, and says so
// Starts its own wallet server and dev server (3154 / 5185) and stops them again.
//   node test/wallets.mjs            BROWSER=webkit for the engine an iPhone runs the app in
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = 'http://127.0.0.1:5185', PIN = '246802'
const profile = mkdtempSync(join(tmpdir(), 'lump-wallets-'))
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
  ctx = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  const page = ctx.pages()[0] ?? await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Normal Closure|closed before the connection|WebSocket is not connected/.test(m.text())) errors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`))
  const pin = async () => { for (const d of PIN) await page.locator('.pin button', { hasText: d }).click() }
  const text = async () => (await page.locator('.screen').first().innerText()).replace(/\s+/g, ' ')
  const stored = (k) => page.evaluate((key) => localStorage.getItem(key), k)
  const keys = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lump.')).sort())
  const stateRows = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('lump', 1); r.onupgradeneeded = () => r.result.createObjectStore('state'); r.onsuccess = () => { const q = r.result.transaction('state').objectStore('state').getAllKeys(); q.onsuccess = () => { r.result.close(); res(q.result.map(String).sort()) }; q.onerror = () => res(['?']) }; r.onerror = () => res(['?']) }))
  const home = page.getByText('Fee energy', { exact: true })
  /** Home of the wallet named `name` is up and its session has an address; returns it. */
  const onWallet = async (name) => {
    await page.locator('[data-wallets]', { hasText: name }).waitFor({ timeout: 120_000 })
    await home.waitFor({ timeout: 120_000 })
    await page.waitForFunction(() => !!window.__lump?.session?.snap?.unshieldedAddress, null, { timeout: 180_000 })
    return page.evaluate(() => ({ id: window.__lump.session.walletId, address: window.__lump.session.snap.unshieldedAddress, cardano: window.__lump.session.cardano?.address }))
  }
  /** shows the words, answers the check; returns the words */
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
  const openSheet = async () => { await page.locator('[data-wallets]').click(); await page.locator('[data-wallets-sheet]').waitFor({ timeout: 5_000 }) }
  const sheetText = async () => (await page.locator('[data-wallets-sheet]').innerText()).replace(/\s+/g, ' ')
  const switchTo = async (id, name) => { await openSheet(); await page.locator(`[data-wallet="${id}"]`).click(); return onWallet(name) }
  const settings = async () => { await page.locator('.icon-btn[title="Settings"]').click(); await page.getByText('Recovery phrase', { exact: true }).waitFor({ timeout: 10_000 }) }
  const back = () => page.getByText('‹ Back').click()
  const unlock = async () => { await page.getByText('Enter your PIN').waitFor({ timeout: 30_000 }); await pin() }

  // ---- one wallet: a device as it has always been ----
  await page.goto(BASE, { waitUntil: 'load' })
  await page.getByText('Create new wallet').click()
  const words1 = await writeDown()
  await pin(); await pin()
  const w1 = await onWallet('Wallet 1')
  const blob1 = await stored('lump.vault.v1')
  // the list of wallets may be there already (it remembers the wallet's public address), naming only this one
  const list1 = JSON.parse((await stored('lump.wallets.v1')) ?? 'null')
  check(w1.id === 'w1' && !!blob1 && (!list1 || (list1.list.length === 1 && list1.list[0].id === 'w1')) && !(await keys()).some((k) => k.includes('@')), 'the first wallet is stored as it always was: its phrase under the old name, and nothing under another wallet\'s name')
  await openSheet()
  check(/Wallet 1 .*In use/.test(await sheetText()) && await page.getByRole('button', { name: 'Add a wallet' }).isEnabled(), 'the wallet\'s name opens the list: Wallet 1, in use, and Add a wallet')
  await page.screenshot({ path: join(ROOT, 'test/out/wallets-1-sheet.png') })

  // ---- add a new wallet ----
  await page.getByRole('button', { name: 'Add a wallet' }).click()
  await page.getByText('Add a wallet', { exact: true }).waitFor({ timeout: 5_000 })
  check(/Its own 24 words, the same PIN/.test(await text()), 'Add a wallet: a new one or one you already have, under the same PIN')
  await page.getByText('Create new wallet').click()
  const words2 = await writeDown()
  const w2 = await onWallet('Wallet 2')
  check(w2.id === 'w2' && w2.address !== w1.address && w2.cardano !== w1.cardano && words2.join(' ') !== words1.join(' ') && !(await page.getByText('Set a PIN').isVisible()), 'a new wallet was added with no second PIN: Wallet 2, its own words and addresses')
  check((await stored('lump.vault.v1')) === blob1 && !!(await stored('lump.vault.v1@w2')) && JSON.parse(await stored('lump.wallets.v1')).active === 'w2', 'the first wallet\'s stored phrase is byte for byte what it was; the new one is stored beside it and is the wallet in use')
  check(JSON.parse(await stored('lump.vault.v1@w2')).salt === JSON.parse(blob1).salt && JSON.parse(await stored('lump.vault.v1@w2')).ct !== JSON.parse(blob1).ct, 'both are under the same PIN (one salt), each with its own phrase')

  // ---- switching: no PIN, each wallet its own ----
  await page.evaluate(() => localStorage.setItem('lump.dapp.connections.v1', JSON.stringify([{ origin: 'https://example.org', since: new Date().toISOString() }])))   // a site the FIRST wallet connected to
  await settings()
  check(/Connected apps None/.test(await text()), 'a site the first wallet connected to is not connected for the second')
  await back()
  let now = await switchTo('w1', 'Wallet 1')
  check(now.id === 'w1' && now.address === w1.address && now.cardano === w1.cardano && !(await page.getByText('Enter your PIN').isVisible()), 'switching back needs no PIN and brings Wallet 1 back with its own addresses')
  await settings()
  check(/Connected apps 1 connected/.test(await text()), 'and with its own connected site')
  await back()
  await page.waitForFunction(() => window.__lump.session.snap.phase !== 'starting', null, { timeout: 180_000 })
  now = await switchTo('w2', 'Wallet 2')
  check(now.address === w2.address, 'and Wallet 2 comes back with its own')
  await page.waitForFunction(() => window.__lump.session.snap.phase !== 'starting', null, { timeout: 180_000 })
  now = await switchTo('w1', 'Wallet 1')
  const rows = await stateRows()
  check(rows.includes('wallet-v1') && rows.includes('wallet-v1@w2'), `each wallet keeps its own sync cache (${rows.join(', ')})`)

  // ---- bring a wallet along; the same words twice are turned down ----
  await openSheet()
  await page.getByRole('button', { name: 'Add a wallet' }).click()
  await page.getByText('I already have a wallet').click()
  await page.locator('textarea').fill(words2.join(' '))
  await page.getByText('Continue').click()
  await page.getByText(/Today or yesterday/).click()
  await page.getByText('That wallet is on this device already').waitFor({ timeout: 20_000 })
  check(JSON.parse(await stored('lump.wallets.v1')).list.length === 2, 'the words of a wallet that is here already are turned down, and nothing is added')
  const brought = generateMnemonic(wordlist, 256)
  await page.locator('textarea').fill(brought)
  await page.getByText('Continue').click()
  await page.getByText(/Today or yesterday/).click()
  const w3 = await onWallet('Wallet 3')
  check(w3.id === 'w3' && ![w1.address, w2.address].includes(w3.address), 'a wallet brought along with its 24 words is added as Wallet 3')

  // ---- a name of its own; the wallet in use is the one a lock and a restart come back to ----
  await settings()
  await page.getByText('Wallet name', { exact: true }).click()
  await page.getByLabel('Wallet name').fill('Savings')
  await page.getByRole('button', { name: 'Save' }).click()
  await back()
  await page.locator('[data-wallets]', { hasText: 'Savings' }).waitFor({ timeout: 5_000 })
  await openSheet()
  check(/Wallet 1 .*Wallet 2 .*Savings .*In use/.test(await sheetText()), 'renamed: the list shows Wallet 1, Wallet 2 and Savings (in use)')
  await page.screenshot({ path: join(ROOT, 'test/out/wallets-2-three.png') })
  await page.getByRole('button', { name: 'Close' }).click()
  await settings()
  await page.getByText('Lock now', { exact: true }).click()
  await unlock()
  now = await onWallet('Savings')
  check(now.address === w3.address, 'after a lock the PIN opens the wallet that was in use')
  await page.reload({ waitUntil: 'load' })
  await unlock()
  now = await onWallet('Savings')
  check(now.address === w3.address, 'and after a restart too')
  await settings()
  await page.getByText('Recovery phrase', { exact: true }).click()
  await pin()
  await page.locator('.words .word').first().waitFor({ timeout: 20_000 })
  const shown = await page.locator('.words .word').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()).join(' '))
  check(shown === brought, 'Recovery phrase shows the words of the wallet in use')
  await page.getByRole('button', { name: 'Done' }).click()

  // ---- remove one wallet: the others stay ----
  await page.getByText('Remove wallet from this device').click()
  check(/of Savings from this device/.test(await text()) && /Your other 2 wallets stay/.test(await text()), 'Remove says which wallet goes and that the other two stay')
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  now = await onWallet('Wallet 1')
  check(now.address === w1.address && (await stored('lump.vault.v1@w3')) === null && !(await keys()).some((k) => k.endsWith('@w3')) && !(await stateRows()).includes('wallet-v1@w3') && (await stored('lump.vault.v1')) === blob1,
    'the removed wallet\'s phrase, cache and notes are gone; Wallet 1 is in use and its stored phrase is still untouched')
  // the first wallet goes, the second stays and still opens with the PIN after a restart
  await settings()
  await page.getByText('Remove wallet from this device').click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  now = await onWallet('Wallet 2')
  check(now.address === w2.address && (await stored('lump.vault.v1')) === null && (await stored('lump.dapp.connections.v1')) === null, 'the FIRST wallet removed: Wallet 2 takes over, and the first one\'s phrase and connected sites are gone')
  await page.reload({ waitUntil: 'load' })
  await unlock()
  now = await onWallet('Wallet 2')
  check(now.address === w2.address, 'the PIN still opens the device with only Wallet 2 on it')
  await openSheet()
  await page.getByRole('button', { name: 'Add a wallet' }).click()
  await page.getByText('Create new wallet').click()
  await writeDown()
  const w4 = await onWallet('Wallet 4')
  check(w4.id === 'w4' && (await stored('lump.vault.v1@w4')) !== null, 'the next wallet is Wallet 4: a removed wallet\'s place is not used again')

  // ---- Forgot PIN takes every wallet ----
  await settings()
  await page.getByText('Lock now', { exact: true }).click()
  await page.getByText('Enter your PIN').waitFor({ timeout: 30_000 })
  await page.getByText('Forgot PIN').click()
  check(/Resetting removes all 2 wallets from the device/.test(await text()), 'Forgot PIN says it removes both wallets')
  await page.getByRole('button', { name: 'Remove all wallets' }).click()
  await page.getByText('Create new wallet').waitFor({ timeout: 20_000 })
  const left = (await keys()).filter((k) => /vault|wallets|@w\d|connections|birthday/.test(k))
  check(left.length === 0 && (await stateRows()).length === 0, `afterwards nothing of any wallet is left on the device (${left.join(', ') || 'none'})`)
  check(errors.length === 0, `no page errors (${errors.length}${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''})`)
} catch (e) {
  console.error('FAILED', String(e?.message ?? e).slice(0, 500)); failed++
  // what the screen showed when it stopped
  const p = ctx?.pages()[0]
  await p?.screenshot({ path: join(ROOT, 'test/out/wallets-failed.png') }).catch(() => {})
  console.error('screen:', (await p?.locator('body').innerText().catch(() => '') ?? '').replace(/\s+/g, ' ').slice(0, 300))
  console.error('state:', JSON.stringify(await p?.evaluate(() => ({ wrongPins: localStorage.getItem('lump.pin.attempts.v1'), padOff: document.querySelectorAll('.pin button:disabled').length, wallets: localStorage.getItem('lump.wallets.v1')?.replace(/"address":"[^"]*"/g, '"address":"…"') })).catch(() => null)))
} finally {
  await ctx?.close().catch(() => {})
  for (const k of kids) k.kill()
  await sleep(700)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
