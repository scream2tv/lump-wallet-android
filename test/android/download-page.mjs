// The download page as an Android phone and as an iPhone see it (screenshots to the folder given, or test/out/android/).
//   node test/android/download-page.mjs [url=http://127.0.0.1:3143/wallet/android/] [outDir]
import { chromium, devices } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const url = process.argv[2] ?? 'http://127.0.0.1:3143/wallet/android/'
const out = process.argv[3] ?? fileURLToPath(new URL('../out/android/', import.meta.url))
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
for (const [name, dev] of [['android', devices['Pixel 7']], ['iphone', devices['iPhone 14']]]) {
  const ctx = await browser.newContext({ ...dev })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url, { waitUntil: 'networkidle' })
  const href = await page.locator('a.get').getAttribute('href')
  const iosNote = await page.locator('#ios').isVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  await page.screenshot({ path: `${out}/download-page-${name}.png`, fullPage: true })
  console.log(`${name}: download link "${href}" · iPhone note shown: ${iosNote} · sideways scroll: ${overflow} · console errors: ${errors.length}${errors.length ? ' ' + errors[0] : ''}`)
  await ctx.close()
}
await browser.close()
