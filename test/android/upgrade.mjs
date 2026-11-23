// An update over an installed copy, on a phone or emulator on adb: a wallet made by the build people have today must
// open after the new build is installed over it, and its device key must have moved from the web view's own store
// into the Android Keystore (SecureStorePlugin.java, core/vault.ts moveToSystemStore).
//   node test/android/upgrade.mjs <old debug apk> <new debug apk>
// Both are DEBUG builds signed with the same key (the test drives the app's page through its inspection socket, and
// the new build must install over the old one). A throwaway wallet, never funded; its words stay inside the page.
// Report: test/out/android/upgrade.json. Exit code 1 when a check fails.
import { _android as android } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [OLD, NEW] = process.argv.slice(2)
if (!OLD || !NEW) { console.error('usage: node test/android/upgrade.mjs <old debug apk> <new debug apk>'); process.exit(2) }
const PKG = 'xyz.lumptools.wallet'
const PIN = '246802'
const OUT = fileURLToPath(new URL('../out/android/', import.meta.url))
mkdirSync(OUT, { recursive: true })

const checks = []
const t00 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t00) / 1000).toFixed(0).padStart(4)}s`, ...a)
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); log(ok ? 'PASS' : 'FAIL', name, detail ? `· ${String(detail).slice(0, 200)}` : '') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim()

const [device] = await android.devices()
if (!device) { console.error('no device on adb'); process.exit(2) }
device.setDefaultTimeout(90_000)
const sh = async (cmd) => (await device.shell(cmd)).toString().trim()
const pidOf = async () => (await sh(`pidof ${PKG}`).catch(() => '')).split(/\s+/)[0] || ''
async function walletPage() {
  let pid = ''
  for (let i = 0; i < 60 && !pid; i++) { pid = await pidOf(); if (!pid) await sleep(500) }
  if (!pid) throw new Error('app process did not start')
  for (let i = 0; i < 120; i++) {
    const w = device.webViews().find((v) => String(v.pid()) === pid)
    if (w) return w.page()
    await sleep(500)
  }
  throw new Error('the app WebView never showed up for inspection')
}
const launch = async () => { await sh(`am start -n ${PKG}/.MainActivity`); return walletPage() }
const pin = async (page) => { for (const d of PIN) await page.locator('.pin button', { hasText: d }).click() }
/** the "Update available" sheet (a debug build is number 1) is put off, whenever it shows */
const putOffUpdate = async (page, waitMs) => {
  const offer = page.getByRole('dialog', { name: 'Update available' })
  if (!(await offer.waitFor({ timeout: waitMs }).then(() => true, () => false))) return
  await offer.getByRole('button', { name: 'Later' }).click().catch(() => {})
  await offer.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {})
}
const stored = (page) => page.evaluate(() => {
  const blob = JSON.parse(localStorage.getItem('lump.vault.v1') ?? 'null')
  return new Promise((res) => {
    const r = indexedDB.open('lump-device', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('keys')
    r.onsuccess = () => { const q = r.result.transaction('keys').objectStore('keys').get('vault-v1'); q.onsuccess = () => { r.result.close(); res({ blob, ownKey: q.result instanceof CryptoKey }) }; q.onerror = () => { r.result.close(); res({ blob, ownKey: false }) } }
    r.onerror = () => res({ blob, ownKey: false })
  })
})
/** the public address of the wallet in use, as Home notes it in the list of wallets once the session has it */
const address = async (page) => {
  for (let i = 0; i < 120; i++) {
    const a = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('lump.wallets.v1') ?? 'null')?.list?.find((w) => w.id === 'w1')?.address ?? '' } catch { return '' } }).catch(() => '')
    if (a) return a
    await sleep(1000)
  }
  return ''
}
const home = (page) => page.getByText('Fee energy', { exact: true })
/** what the app keeps for the Keystore store in its own files (a debug build lets adb look) */
const prefsFile = () => sh(`run-as ${PKG} cat shared_prefs/lump.securestore.xml 2>/dev/null`).catch(() => '')

let failedHard = null
try {
  // ---- the build people have: a wallet made by it ----
  try { adb('uninstall', PKG) } catch { /* not installed */ }
  adb('install', OLD)
  await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => {})
  let page = await launch()
  await page.getByText('Create new wallet').waitFor({ timeout: 120_000 })
  await putOffUpdate(page, 20_000)
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
  await page.locator('.pin button').first().waitFor()
  await sh('input keyevent KEYCODE_ESCAPE').catch(() => {})
  await sleep(700)
  await pin(page); await pin(page)
  await home(page).waitFor({ timeout: 180_000 })
  await sleep(1500)
  const before = await stored(page)
  const addrBefore = await address(page)
  check('the old build made a wallet whose device key the web view itself keeps', before.blob?.v === 2 && before.blob.where === 'browser' && before.ownKey === true, JSON.stringify({ v: before.blob?.v, where: before.blob?.where, ownKey: before.ownKey }))
  check('the old build keeps nothing in the Keystore store', (await prefsFile()) === '', 'no settings file of the store')

  // ---- the update: the new build over it ----
  await sh(`am force-stop ${PKG}`)
  adb('install', '-r', NEW)
  page = await launch()
  await page.getByText('Enter your PIN').waitFor({ timeout: 120_000 })
  check('after the update the app asks for the PIN (the wallet is still there)', true)
  await putOffUpdate(page, 6_000)
  await pin(page)
  const opened = await home(page).waitFor({ timeout: 120_000 }).then(() => true, () => false)
  check('the PIN opens the wallet made by the old build', opened, opened ? '' : (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200))
  if (!opened) throw new Error('the wallet did not open after the update')
  await putOffUpdate(page, 3_000)
  await sleep(1500)
  const after = await stored(page)
  check('its device key moved into the Keystore store', after.blob?.where === 'keychain' && after.blob.salt === before.blob.salt && after.blob.iv === before.blob.iv && after.blob.ct !== before.blob.ct, JSON.stringify({ where: after.blob?.where }))
  check('and the web view\'s own copy of the key is gone', after.ownKey === false)
  check('it is the same wallet', (await address(page)) === addrBefore && addrBefore.length > 8, addrBefore.slice(0, 18))
  const file = await prefsFile()
  const entry = (file.match(/<string name="vault-device-key-v1">([^<]*)<\/string>/) ?? [])[1] ?? ''
  // 12-byte nonce + the 44 characters of a 32-byte key + 16-byte tag = 72 bytes = 96 characters of base64
  check('the app\'s files hold the key only as what the Keystore encrypted', entry.length === 96, `stored value: ${entry.length} characters`)

  await page.locator('.icon-btn[title="Settings"]').click()
  await page.getByText('Security', { exact: true }).click()
  await page.getByText(/Lock again after/).waitFor({ timeout: 10_000 })
  const security = (await page.locator('.screen').first().innerText()).replace(/\s+/g, ' ')
  check('Settings says the key is in the Keystore of this device', /a key kept in the Keystore of this device/.test(security), security.slice(0, 160))

  // ---- after a restart ----
  await sh(`am force-stop ${PKG}`)
  page = await launch()
  await page.getByText('Enter your PIN').waitFor({ timeout: 120_000 })
  await putOffUpdate(page, 6_000)
  await pin(page)
  const again = await home(page).waitFor({ timeout: 120_000 }).then(() => true, () => false)
  check('after a restart the PIN opens it with the key from the Keystore', again && (await address(page)) === addrBefore)

  // ---- the app's data without what the Keystore store kept: nothing opens it ----
  await sh(`am force-stop ${PKG}`)
  await sh(`run-as ${PKG} rm shared_prefs/lump.securestore.xml`)
  page = await launch()
  await page.getByText('Enter your PIN').waitFor({ timeout: 120_000 })
  await putOffUpdate(page, 6_000)
  await pin(page)
  const restore = await page.getByText('Restore needed').waitFor({ timeout: 30_000 }).then(() => true, () => false)
  check('with the stored key taken away, the right PIN opens nothing: "Restore needed"', restore, restore ? '' : (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200))
} catch (e) {
  failedHard = String(e?.stack ?? e).slice(0, 600)
  check('run completed', false, failedHard)
} finally {
  const failed = checks.filter((c) => !c.ok)
  writeFileSync(OUT + 'upgrade.json', JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
  console.log(`\nupdate over an installed copy: ${checks.length - failed.length} passed, ${failed.length} failed`)
  for (const c of failed) console.log('  FAIL', c.name, '·', c.detail)
  try { await device.close() } catch {}
  process.exit(failed.length ? 1 : 0)
}
