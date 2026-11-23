// Make one built release APK the one the download page hands out (server/static.mjs: /wallet/android/).
//   node tools/android-publish.mjs out/android/LumpWallet-0.1.0-29921316.apk [--required | --min <code>]
// Writes out/android/published.json; the static server reads it on every request, no restart needed.
// A fresh `tools/android-release.sh` build is NOT handed out until it is published here (try it first).
//
// Installed copies ask the server which build is published (/wallet/api/android/latest) and offer the update.
//   --required     every copy older than THIS build must update before it can be used again
//   --min <code>   every copy with a build number below <code> must update (0 = nobody is forced)
// Without either, the floor of the previous publish stays as it was: a later ordinary build does not lift it.
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// WALLET_ANDROID_DIR: another folder than out/android/ (the same variable moves the server's; the tests use it)
const OUT = process.env.WALLET_ANDROID_DIR ? resolve(process.env.WALLET_ANDROID_DIR) : fileURLToPath(new URL('../out/android/', import.meta.url))
const args = process.argv.slice(2)
const usage = () => { console.error('usage: node tools/android-publish.mjs <apk in out/android/> [--required | --min <code>]'); process.exit(2) }
if (!args[0] || args[0].startsWith('--')) usage()
const apk = resolve(args[0])
const file = basename(apk)
const m = /^LumpWallet-(\d+\.\d+\.\d+)-(\d+)\.apk$/.exec(file)
if (!m || resolve(dirname(apk)) !== resolve(OUT)) { console.error('expected out/android/LumpWallet-<version>-<code>.apk (made by tools/android-release.sh)'); process.exit(2) }
const code = Number(m[2])

let before = null
try { before = JSON.parse(readFileSync(join(OUT, 'published.json'), 'utf8')) } catch { /* the first publish */ }
let min = Number.isSafeInteger(before?.min) && before.min > 0 ? before.min : 0
const rest = args.slice(1)
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--required') min = code
  else if (rest[i] === '--min' && /^\d+$/.test(rest[i + 1] ?? '')) min = Number(rest[++i])
  else usage()
}
if (min > code) { console.error(`the floor ${min} is above this build (${code}): no copy could ever satisfy it`); process.exit(2) }

const st = statSync(apk)
const sha256 = createHash('sha256').update(readFileSync(apk)).digest('hex')
const entry = { file, version: m[1], code, min, size: st.size, sha256, built: st.mtime.toISOString(), published: new Date().toISOString() }
writeFileSync(join(OUT, 'published.json'), JSON.stringify(entry, null, 2) + '\n')
console.log(`published ${file}\n  version ${entry.version} (code ${entry.code}) · ${(st.size / 1048576).toFixed(1)} MB\n  sha256 ${sha256}`)
console.log(min ? `  copies below build ${min} are told they MUST update${min === code ? ' (every older copy)' : ''}` : '  older copies are offered the update and may put it off')
