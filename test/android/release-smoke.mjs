// The RELEASE build on a running emulator or phone: it starts, shows the welcome screen, and is closed up the way a
// release must be (not debuggable, WebViews not open to inspection, nothing of ours in the system log, no backups).
// A release build cannot be driven from outside, so this only looks at it: the screen, the package, the log.
//   node test/android/release-smoke.mjs <path to a signed release apk>
// CI signs its own copy with a throwaway key; a real release is signed where its key is kept (tools/android-release.sh).
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PKG = 'xyz.lumptools.wallet'
const APK = process.argv[2]
if (!APK) { console.error('usage: release-smoke.mjs <apk>'); process.exit(2) }
const OUT = fileURLToPath(new URL('../out/android/', import.meta.url))
mkdirSync(OUT, { recursive: true })

const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const sh = (cmd) => { try { return adb('shell', cmd).trim() } catch (e) { return String(e.stdout ?? '').trim() } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.log(ok ? 'PASS' : 'FAIL', name, detail ? `· ${String(detail).slice(0, 200)}` : '') }

try { adb('uninstall', PKG) } catch {}
adb('logcat', '-c')
console.log(adb('install', APK).trim().split('\n').pop())
sh(`am start -n ${PKG}/.MainActivity`)

// the welcome screen, read from what the screen exposes to accessibility (the page itself is closed to us)
let seen = false, ui = ''
for (let i = 0; i < 45 && !seen; i++) {
  await sleep(2000)
  sh('uiautomator dump /sdcard/lump-ui.xml')
  ui = sh('cat /sdcard/lump-ui.xml')
  // (a copy older than the published build may already have its "Update available" prompt over the welcome screen)
  seen = /Create new wallet|Update available/.test(ui)
  // a freshly booted emulator sometimes puts "<some system app> isn't responding" over everything: tap Wait
  const wait = !seen && /isn(&apos;|')t responding/.test(ui) && /text="Wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(ui)
  if (wait) { console.log('a system "not responding" dialog is in the way: tapping Wait'); sh(`input tap ${(Number(wait[1]) + Number(wait[3])) >> 1} ${(Number(wait[2]) + Number(wait[4])) >> 1}`) }
}
check('the release build starts and shows the welcome screen', seen, seen ? '' : ui.replace(/<[^>]*text="([^"]*)"[^>]*>/g, '$1 ').replace(/<[^>]+>/g, '').slice(0, 200))

// A copy older than the published build must say so, and one that is not must stay quiet (src/core/update.ts).
// Read from the screen as well; skipped when the wallet server cannot be asked from where this runs.
const installedCode = Number((sh(`dumpsys package ${PKG}`).match(/versionCode=(\d+)/) ?? [])[1])
const published = await fetch(`https://${process.env.WALLET_HOST ?? 'wallet-server.invalid'}/wallet/api/android/latest`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
if (seen && installedCode && Number.isSafeInteger(published?.code)) {
  const expected = published.code > installedCode
  let offered = /Update available/.test(ui)
  for (let i = 0; i < 12 && expected && !offered; i++) { await sleep(2000); sh('uiautomator dump /sdcard/lump-ui.xml'); ui = sh('cat /sdcard/lump-ui.xml'); offered = /Update available/.test(ui) }
  check(expected ? 'an older copy says that a newer build is out' : 'the published copy does not ask for an update', offered === expected, `installed build ${installedCode}, published ${published.code}${published.min ? `, floor ${published.min}` : ''}`)
  if (offered) {
    writeFileSync(OUT + 'release-update.png', execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }))
    const later = /text="Later"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(ui)
    if (later) { sh(`input tap ${(Number(later[1]) + Number(later[3])) >> 1} ${(Number(later[2]) + Number(later[4])) >> 1}`); await sleep(1200) }
  }
} else console.log(`SKIP the update prompt · installed build ${installedCode || '?'}, published ${published?.code ?? 'not reachable from here'}`)
writeFileSync(OUT + 'release-welcome.png', execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }))

const pid = sh(`pidof ${PKG}`).split(/\s+/)[0]
check('the app process is running', !!pid, `pid ${pid}`)

const pkg = sh(`dumpsys package ${PKG}`)
const flags = (pkg.match(/^\s*flags=\[([^\]]*)\]/m) ?? [])[1] ?? ''
const signer = (pkg.match(/signatures=PackageSignatures\{[^\n]*/) ?? [''])[0]
check('not debuggable', flags !== '' && !/DEBUGGABLE/.test(flags), `flags=[${flags.trim()}]`)
check('backups are off', flags !== '' && !/ALLOW_BACKUP/.test(flags), '')
const version = { name: (pkg.match(/versionName=(\S+)/) ?? [])[1], code: (pkg.match(/versionCode=(\d+)/) ?? [])[1], targetSdk: (pkg.match(/targetSdk=(\d+)/) ?? [])[1], minSdk: (pkg.match(/minSdk=(\d+)/) ?? [])[1] }
const perms = [...new Set([...pkg.matchAll(/android\.permission\.[A-Z_]+/g)].map((m) => m[0]))].sort()
check('asks only for internet, camera and what a sync in the background needs', perms.filter((p) => !/\.(INTERNET|CAMERA|ACCESS_NETWORK_STATE|FOREGROUND_SERVICE|FOREGROUND_SERVICE_DATA_SYNC|WAKE_LOCK|POST_NOTIFICATIONS)$/.test(p) && !/DYNAMIC_RECEIVER/.test(p)).length === 0, perms.join(', '))

// A phone's system build decides this as much as the app: on a development build of Android (what the plain
// emulator images are) the WebView opens every app to inspection and the app cannot turn it off; on a retail build
// (Play Store images, real phones) only a debuggable app is open. So the check means something on a retail build only.
const systemBuild = sh('getprop ro.build.type')
const sockets = sh('cat /proc/net/unix').split('\n').filter((l) => l.includes(`webview_devtools_remote_${pid}`))
if (systemBuild === 'user') check('its WebViews are closed to inspection', sockets.length === 0, sockets.join(' '))
else console.log(`SKIP its WebViews are closed to inspection · this is a "${systemBuild}" system build, which opens every app's WebViews (${sockets.length} socket)`)

// The framework writes a few start-up lines before it has read its own configuration (activity and plugin names).
// What must never be there: page console output, calls between page and app with their data, addresses.
const log = adb('logcat', '-d', `--pid=${pid}`)
const framework = log.split('\n').filter((l) => /Capacitor/i.test(l)).map((l) => l.replace(/^\S+\s+\S+\s+\d+\s+\d+\s+/, '').slice(0, 160))
const telling = log.split('\n').filter((l) => /Capacitor\/Console|To native|methodData|callbackId|mn_addr|mn_shield|mn_dust/i.test(l))
check('no wallet data, page output or app calls in the system log', telling.length === 0, `${telling.length} lines${telling.length ? ': ' + telling[0].slice(0, 120) : ''} · ${framework.length} framework start-up lines`)

const failed = checks.filter((c) => !c.ok)
writeFileSync(OUT + 'release-report.json', JSON.stringify({ at: new Date().toISOString(), apk: APK, systemBuild, version, permissions: perms, signer, frameworkLogLines: framework, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2))
console.log(`\nrelease build: ${checks.length - failed.length} passed, ${failed.length} failed · version ${version.name} (${version.code}) · target SDK ${version.targetSdk}, min SDK ${version.minSdk}`)
process.exit(failed.length ? 1 : 0)
