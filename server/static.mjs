// The wallet server: serves the web build in dist/ (built with base /wallet/) and the wallet's small APIs on
// 127.0.0.1:3143, behind a TLS reverse proxy. Accepts requests with or without the /wallet prefix (a proxy may or
// may not strip it) and falls back to
// index.html for app routes. Correct MIME types for .wasm and .webmanifest matter for the PWA and the ledger.
import { createServer } from 'node:http'
import { appendFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createGzip, gzipSync } from 'node:zlib'

const COMPRESS = new Set(['.html', '.js', '.css', '.wasm', '.json', '.webmanifest', '.svg'])
const gzCache = new Map()
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.STATIC_PORT ?? 3143)
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const PREFIX = '/wallet'
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
}

// Price relay: the LumpTools Midnight market feed has no CORS header, so the page asks us (cached 29 s).
// MARKET_URL: another feed of the same shape.
const MARKET = process.env.MARKET_URL ?? 'https://lumptools.xyz/api/midnight/market'
// the market feed prices NIGHT; ADA (what sits on a wallet's Cardano address) comes from the ADA/USD route and rides along as adaUsd
const ADA_USD = process.env.ADA_USD_URL ?? 'https://lumptools.xyz/api/ada-usd'
let marketCache = { at: 0, body: '' }
async function market(res) {
  if (Date.now() - marketCache.at > 29_000) {
    try {
      const [r, a] = await Promise.all([
        fetch(MARKET, { signal: AbortSignal.timeout(8_000) }),
        fetch(ADA_USD, { signal: AbortSignal.timeout(8_000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null),
      ])
      if (r.ok) {
        let body = await r.text()
        try {
          const j = JSON.parse(body)
          if (typeof j.adaUsd !== 'number' && typeof a?.adaUsd === 'number' && a.adaUsd > 0) { j.adaUsd = a.adaUsd; body = JSON.stringify(j) }
        } catch { /* not JSON: passed on as it came */ }
        marketCache = { at: Date.now(), body }
      }
    } catch {}
  }
  if (!marketCache.body) { res.writeHead(502); res.end(); return }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(marketCache.body)
}

// Bootstrap snapshots written by server/state-bot.mjs (public, wallet-independent sync state).
//   /api/bootstrap          -> latest.json
//   /api/bootstrap/days     -> ["2026-10-07", ...] available daily snapshots
//   /api/bootstrap/<day>    -> that day's first snapshot
const BOOT = fileURLToPath(new URL('../out/bootstrap/', import.meta.url))
function bootstrap(path, req, res) {
  const rest = path.slice('/api/bootstrap'.length).replace(/^\//, '')
  let file
  if (rest === '' ) file = BOOT + 'latest.json'
  else if (rest === 'days') {
    let days = []
    try { days = readdirSync(BOOT).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort() } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(JSON.stringify(days)); return
  } else if (rest === 'dust-days') {
    // DUST-only public states of earlier days (tools/dust-days.mjs): /api/bootstrap/dust/<day>
    let days = []
    try { days = readdirSync(BOOT + 'dust/').filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort() } catch {}
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(JSON.stringify(days)); return
  } else if (/^dust\/\d{4}-\d{2}-\d{2}$/.test(rest)) file = BOOT + rest + '.json'
  else if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) file = BOOT + rest + '.json'
  else { res.writeHead(404); res.end(); return }
  let st = null
  try { st = statSync(file) } catch {}
  if (!st?.isFile()) { res.writeHead(404); res.end(); return }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', 'last-modified': st.mtime.toUTCString(), ...(gzip ? { 'content-encoding': 'gzip' } : { 'content-length': st.size }) })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(file)
  stream.on('error', () => { try { res.destroy() } catch {} })
  if (gzip) stream.pipe(createGzip()).pipe(res); else stream.pipe(res)
}

// Android beta download: /android/ is a small page, /android/LumpWallet.apk the APK itself.
// Which APK is handed out is named in out/android/published.json (tools/android-publish.mjs), read on every
// request: a new build is not public until it is published, and publishing needs no restart.
const ANDROID = process.env.WALLET_ANDROID_DIR ? process.env.WALLET_ANDROID_DIR.replace(/[\\/]*$/, '/') : fileURLToPath(new URL('../out/android/', import.meta.url))
const ANDROID_PAGE = fileURLToPath(new URL('./android.html', import.meta.url))
function publishedApk() {
  try {
    const p = JSON.parse(readFileSync(ANDROID + 'published.json', 'utf8'))
    if (!/^LumpWallet-[\d.]+-\d+\.apk$/.test(String(p.file)) || !/^[0-9a-f]{64}$/.test(String(p.sha256))) return null
    const st = statSync(ANDROID + p.file)
    return st.isFile() ? { ...p, size: st.size } : null
  } catch { return null }
}
// What an installed app asks to learn whether a newer build is out (src/core/update.ts). `min`: copies with a lower
// build number are told they must update (tools/android-publish.mjs --required); 0 = no copy is forced.
function androidLatest(req, res) {
  const apk = publishedApk()
  const min = apk && Number.isSafeInteger(apk.min) && apk.min > 0 ? Math.min(apk.min, apk.code) : 0
  const body = JSON.stringify(apk ? { version: apk.version, code: apk.code, min, size: apk.size, sha256: apk.sha256, published: apk.published ?? apk.built ?? null } : {})
  res.writeHead(apk ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(req.method === 'HEAD' ? undefined : body)
}
function android(path, req, res) {
  // without the trailing slash the page's relative links would point one level up
  if (path === '/android') { res.writeHead(302, { location: 'android/' }); res.end(); return }
  const apk = publishedApk()
  if (!apk) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('No Android build is published yet.'); return }
  if (path === '/android/') {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    // the build number is what tells two downloads apart (every build is "0.1.0"); the app shows the same number in Settings
    const when = new Date(apk.published ?? apk.built ?? NaN)
    const two = (n) => String(n).padStart(2, '0')
    const date = Number.isNaN(when.getTime()) ? '' : `${when.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][when.getUTCMonth()]} ${when.getUTCFullYear()}, ${two(when.getUTCHours())}:${two(when.getUTCMinutes())} UTC`
    const fill = { version: apk.version, build: Number.isSafeInteger(apk.code) ? apk.code : '', file: apk.file, size: `${(apk.size / 1048576).toFixed(1)} MB`, date, sha256: apk.sha256 }
    let html
    try { html = readFileSync(ANDROID_PAGE, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => esc(fill[k] ?? '')) } catch { res.writeHead(500); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    res.end(req.method === 'HEAD' ? undefined : html)
    return
  }
  if (path === '/android/LumpWallet.apk') {
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive', 'content-length': apk.size,
      'content-disposition': `attachment; filename="${apk.file}"`,   // LumpWallet-<version>-<build>.apk: the saved file says which build it is
      'cache-control': 'no-cache', etag: `"${apk.sha256.slice(0, 32)}"`, 'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') { res.end(); return }
    console.log(`${new Date().toISOString().slice(11, 19)} android download ${apk.file}`)
    const stream = createReadStream(ANDROID + apk.file)
    stream.on('error', () => { try { res.destroy() } catch {} })
    stream.pipe(res)
    return
  }
  res.writeHead(404); res.end()
}

// phone-side dApp bridge trace (src/dapp/host.ts trace()): one JSON line per call, bounded file, no secrets in it
const DAPP_LOG = join(DIST, '..', 'out', 'dapp-log.jsonl')
const DAPP_LOG_MAX = 32 * 1024 * 1024
// per-address rate limit: a public path must not become a free log sink
const dappLogHits = new Map()
let dappLogAll = []
function dappLogAllowed(ip) {
  const now = Date.now()
  dappLogAll = dappLogAll.filter((t) => now - t < 60_000)
  if (dappLogAll.length >= 600) return false              // global ceiling: rotating addresses cannot flood the file
  const arr = (dappLogHits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (arr.length >= 90) { dappLogHits.set(ip, arr); return false }
  arr.push(now); dappLogHits.set(ip, arr); dappLogAll.push(now)
  if (dappLogHits.size > 5000) dappLogHits.clear()
  return true
}
function dappLog(req, res) {
  // the reverse proxy APPENDS the real client to x-forwarded-for: trust the last entry, never the first (client-supplied)
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const ip = xff.length ? xff[xff.length - 1] : String(req.socket?.remoteAddress ?? '?')
  if (!dappLogAllowed(ip)) { try { res.writeHead(429); res.end() } catch {}; return }
  const chunks = []; let n = 0
  req.on('data', (c) => { n += c.length; if (n > 4096) { try { res.writeHead(413); res.end() } catch {}; req.destroy() } else chunks.push(c) })
  req.on('end', () => {
    try {
      const j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const line = JSON.stringify({ at: String(j.at ?? '').slice(0, 40), origin: String(j.origin ?? '').slice(0, 120), method: String(j.method ?? '').slice(0, 60), outcome: String(j.outcome ?? '').slice(0, 200), ms: Number(j.ms) || 0, phase: String(j.phase ?? '').slice(0, 20), sync: j.sync && typeof j.sync === 'object' ? JSON.parse(JSON.stringify(j.sync).slice(0, 300)) : undefined, ua: String(req.headers['user-agent'] ?? '').slice(0, 60) })
      let size = 0; try { size = statSync(DAPP_LOG).size } catch {}
      if (size < DAPP_LOG_MAX) appendFileSync(DAPP_LOG, line + '\n')
      res.writeHead(204); res.end()
    } catch { try { res.writeHead(400); res.end() } catch {} }
  })
}

// Prover door: /api/prover/{prove,check,version,ready} -> a LEDGER-9 proof server on this machine (mainnet has been on
// ledger 9 since 2026-11-06; what a ledger-8 proof server proves is refused). The wallet sends an unproven
// transaction (or a dApp's proof inputs with its circuit keys) and gets the proof back. What it sends holds the
// private inputs of the proof (for a spend of private coins: key material, see docs/SECURITY.md), so this door and the
// proof servers behind it are trusted with them; nothing is kept or logged beyond size and timing. It only spends CPU, so it is bounded: bodies up to 64 MB (a
// dApp's circuit key travels with its proof), 3 proofs at once, 30 requests a minute per client.
//   WALLET_PROVERS  proof servers in order of preference, comma separated (for example a fast one first and a
//                   spare behind it). Default: one proof server on its standard port (:6300), which has to be one
//                   for the ledger version the chain is on. The next one is asked only when one cannot be reached or answers 5xx;
//                   a 4xx (a request the prover refuses) is final.
const PROVERS = (process.env.WALLET_PROVERS ?? process.env.WALLET_PROVER ?? 'http://127.0.0.1:6300').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean)
/** Ask the proof servers in order; resolves with the first answer that is not a server-side failure. */
async function askProver(path, init, timeoutMs) {
  let last = null
  for (let i = 0; i < PROVERS.length; i++) {
    try {
      const r = await fetch(PROVERS[i] + path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (r.status < 500 || i === PROVERS.length - 1) return { r, i }
      last = new Error('status ' + r.status)
      try { await r.arrayBuffer() } catch {}
    } catch (e) { last = e }
  }
  throw last ?? new Error('no prover')
}
const PROVER_MAX_BODY = 64 * 1024 * 1024, PROVER_MAX_INFLIGHT = 3, PROVER_PER_MIN = 30, PROVER_TIMEOUT_MS = 300_000
let proving = 0
const proverHits = new Map()
function clientOf(req) {
  // the reverse proxy APPENDS the real client to x-forwarded-for: trust the last entry, never the first (client-supplied)
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  return xff.length ? xff[xff.length - 1] : String(req.socket?.remoteAddress ?? '?')
}
// The Cardano door (server/cardano/door.mjs on this machine): what is on a wallet's Cardano address, and the
// registration / move-out transactions it builds for the app to check and sign. Only these four paths pass.
const CARDANO_DOOR = (process.env.CARDANO_DOOR ?? 'http://127.0.0.1:3148').replace(/\/+$/, '')
async function cardano(path, req, res) {
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  const end = (status, body = '{}') => { try { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(body) } catch {} }
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); res.end(); return }
  const what = path.slice('/api/cardano'.length)
  const post = ['/register', '/send', '/moveout', '/submit'].includes(what)
  if (!(post && req.method === 'POST') && !((what === '/state' || what === '/activity') && req.method === 'GET')) { end(404); return }
  let body
  if (post) {
    const chunks = []; let n = 0
    for await (const c of req) { n += c.length; if (n > 16_384) { end(413); req.destroy(); return } chunks.push(c) }
    body = Buffer.concat(chunks)
  }
  const q = (req.url ?? '').split('?')[1]
  try {
    const r = await fetch(CARDANO_DOOR + what + (q ? '?' + q.slice(0, 600) : ''), { method: req.method, body, headers: { 'x-lump-client': clientOf(req), 'content-type': 'application/json' }, signal: AbortSignal.timeout(110_000) })
    end(r.status, await r.text())
  } catch { end(502, JSON.stringify({ error: 'The Cardano service is not answering right now' })) }
}
async function prover(path, req, res) {
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  const end = (status, body = '') => { try { res.writeHead(status, { ...cors, 'content-type': 'text/plain' }); res.end(body) } catch {} }
  const what = path.slice('/api/prover'.length)
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); res.end(); return }
  if (req.method === 'GET' && (what === '/version' || what === '/ready' || what === '/health')) {
    try { const { r } = await askProver(what === '/health' ? '/version' : what, {}, 4_000); end(r.status, await r.text()) } catch { end(502, 'prover not reachable') }
    return
  }
  if (req.method !== 'POST' || (what !== '/prove' && what !== '/check')) { end(404); return }
  const ip = clientOf(req), now = Date.now()
  const hits = (proverHits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= PROVER_PER_MIN) { proverHits.set(ip, hits); end(429, 'too many requests'); return }
  hits.push(now); proverHits.set(ip, hits)
  if (proverHits.size > 5000) proverHits.clear()
  if (Number(req.headers['content-length'] ?? 0) > PROVER_MAX_BODY) { end(413); return }
  if (proving >= PROVER_MAX_INFLIGHT) { end(503, 'prover busy'); return }
  proving++
  const t0 = Date.now()
  try {
    const chunks = []; let n = 0
    for await (const c of req) { n += c.length; if (n > PROVER_MAX_BODY) { end(413); req.destroy(); return } chunks.push(c) }
    const { r, i } = await askProver(what, { method: 'POST', body: Buffer.concat(chunks), headers: { 'content-type': 'application/octet-stream' } }, PROVER_TIMEOUT_MS)
    const out = Buffer.from(await r.arrayBuffer())
    console.log(`${new Date().toISOString().slice(11, 19)} prover ${what} ${(n / 1024).toFixed(0)} KB -> ${r.status} ${(out.length / 1024).toFixed(0)} KB ${((Date.now() - t0) / 1000).toFixed(1)}s${i ? ` (prover ${i + 1} of ${PROVERS.length})` : ''}`)
    res.writeHead(r.status, { ...cors, 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'content-length': out.length })
    res.end(out)
  } catch (e) {
    console.log(`${new Date().toISOString().slice(11, 19)} prover ${what} failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(e?.name ?? e)}`)
    end(502, 'prover did not answer')
  } finally { proving-- }
}

// Device hand-off: a wallet's synced state for its owner's other devices, so a second device does not sync from the
// start. The wallet encrypts it on the device with a key made from its recovery phrase and names it with an id made
// from the same phrase; this server keeps an opaque id and ciphertext it can neither read nor forge. Nothing is logged
// beyond size. Bounded like everything on a public path: 3 MB a wallet, kept 71 hours, 600 MB in all (oldest go first).
//   PUT /api/handoff/<id>   the encrypted state                      -> 204 + etag
//   GET /api/handoff/<id>   -> the state (etag; if-none-match -> 304), 204 when there is none
// WALLET_HANDOFF_DIR: another folder (a test instance keeps its own)
const HAND = process.env.WALLET_HANDOFF_DIR ? process.env.WALLET_HANDOFF_DIR.replace(/[\\/]*$/, '/') : fileURLToPath(new URL('../out/handoff/', import.meta.url))
const HAND_MAX_BODY = 3 * 1024 * 1024, HAND_MAX_TOTAL = 600 * 1024 * 1024, HAND_KEEP_MS = 71 * 3600_000, HAND_PUT_PER_MIN = 5, HAND_GET_PER_MIN = 40
const handHits = { put: new Map(), get: new Map() }
function handAllowed(kind, ip, perMin) {
  const m = handHits[kind], now = Date.now()
  const arr = (m.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (arr.length >= perMin) { m.set(ip, arr); return false }
  arr.push(now); m.set(ip, arr)
  if (m.size > 5000) m.clear()
  return true
}
/** Drop what is past its time, then the oldest until `room` more bytes fit under the total. */
function handSweep(room) {
  let files = []
  try { files = readdirSync(HAND).filter((f) => /^[0-9a-f]{40}$/.test(f)).map((f) => { const st = statSync(HAND + f); return { f, at: st.mtimeMs, size: st.size } }) } catch { return }
  const now = Date.now()
  files.sort((a, b) => a.at - b.at)
  let total = files.reduce((n, x) => n + x.size, 0)
  for (const x of files) {
    if (now - x.at <= HAND_KEEP_MS && total + room <= HAND_MAX_TOTAL) continue
    try { unlinkSync(HAND + x.f); total -= x.size } catch {}
  }
}
const handTag = (st) => `"${Math.round(st.mtimeMs).toString(36)}-${st.size.toString(36)}"`
async function handoff(path, req, res) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'etag', 'cache-control': 'no-store' }
  const end = (status, headers = {}) => { try { res.writeHead(status, { ...cors, ...headers }); res.end() } catch {} }
  if (req.method === 'OPTIONS') { end(204, { 'access-control-allow-methods': 'GET, PUT', 'access-control-allow-headers': 'content-type, if-none-match', 'access-control-max-age': '86400' }); return }
  const id = path.slice('/api/handoff/'.length)
  if (!/^[0-9a-f]{40}$/.test(id)) { end(404); return }
  const ip = clientOf(req), file = HAND + id
  if (req.method === 'GET') {
    if (!handAllowed('get', ip, HAND_GET_PER_MIN)) { end(429); return }
    let st = null
    try { st = statSync(file) } catch {}
    // none is an ordinary answer (most wallets have a single device): 204, not an error in the browser's console
    if (!st?.isFile() || Date.now() - st.mtimeMs > HAND_KEEP_MS) { end(204); return }
    const etag = handTag(st)
    if (req.headers['if-none-match'] === etag) { end(304, { etag }); return }
    let body
    try { body = readFileSync(file) } catch { end(404); return }
    res.writeHead(200, { ...cors, etag, 'content-type': 'application/octet-stream', 'content-length': body.length })
    res.end(body)
    return
  }
  if (req.method !== 'PUT') { end(405); return }
  if (!handAllowed('put', ip, HAND_PUT_PER_MIN)) { end(429); return }
  if (Number(req.headers['content-length'] ?? 0) > HAND_MAX_BODY) { end(413); return }
  const chunks = []; let n = 0
  for await (const c of req) { n += c.length; if (n > HAND_MAX_BODY) { end(413); req.destroy(); return } chunks.push(c) }
  // version byte + 12-byte nonce + at least the 16-byte tag: anything shorter is not a hand-off
  if (n < 29) { end(400); return }
  try {
    mkdirSync(HAND, { recursive: true })
    handSweep(n)
    writeFileSync(file + '.part', Buffer.concat(chunks))
    renameSync(file + '.part', file)
    console.log(`${new Date().toISOString().slice(11, 19)} handoff stored ${(n / 1024).toFixed(0)} KB`)
    end(204, { etag: handTag(statSync(file)) })
  } catch (e) { console.error('handoff store', e?.message ?? e); end(500) }
}

createServer((req, res) => {
  let path
  try { path = decodeURIComponent((req.url ?? '/').split('?')[0]) } catch { res.writeHead(400); res.end(); return }
  if (path.includes('\0') || path.length > 2048) { res.writeHead(400); res.end(); return }
  if (path === PREFIX || path.startsWith(PREFIX + '/')) path = path.slice(PREFIX.length) || '/'
  if (path.startsWith('/api/handoff/')) { handoff(path, req, res).catch(() => { try { res.writeHead(500); res.end() } catch {} }); return }
  if (path.startsWith('/api/cardano/')) { cardano(path, req, res).catch(() => { try { res.writeHead(502); res.end() } catch {} }); return }
  if (path === '/api/prover' || path.startsWith('/api/prover/')) { prover(path, req, res).catch(() => { try { res.writeHead(502); res.end() } catch {} }); return }
  if (path === '/api/dapp-log') {
    res.setHeader('access-control-allow-origin', '*')
    if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-methods', 'POST'); res.setHeader('access-control-allow-headers', 'content-type'); res.writeHead(204); res.end(); return }
    if (req.method === 'POST') { dappLog(req, res); return }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
  if (path.startsWith('/api/')) res.setHeader('access-control-allow-origin', '*')
  if (path === '/api/market') { market(res).catch(() => { try { res.writeHead(502); res.end() } catch {} }); return }
  if (path === '/api/bootstrap' || path.startsWith('/api/bootstrap/')) { bootstrap(path, req, res); return }
  if (path === '/api/android/latest') { androidLatest(req, res); return }
  if (path === '/android' || path.startsWith('/android/')) { android(path, req, res); return }
  if (path === '/') path = '/index.html'
  let file = normalize(join(DIST, path))
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return }
  let st = null
  try { st = statSync(file) } catch {}
  if (!st || !st.isFile()) { file = join(DIST, 'index.html'); try { st = statSync(file) } catch { res.writeHead(404); res.end(); return } }
  const ext = extname(file)
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=31536000, immutable',
    vary: 'accept-encoding',
  }
  // compressible assets are gzipped once and kept in memory (the 10 MB ledger WASM -> ~4.6 MB over cellular)
  if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    const key = file + ':' + st.mtimeMs
    let gz = gzCache.get(key)
    if (!gz) { gz = gzipSync(readFileSync(file), { level: 9 }); gzCache.set(key, gz) }
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': gz.length })
    res.end(req.method === 'HEAD' ? undefined : gz)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': st.size })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(file)
  stream.on('error', () => { try { res.destroy() } catch {} })
  stream.pipe(res)
}).listen(PORT, '127.0.0.1', () => console.log(`static ${DIST} on 127.0.0.1:${PORT} (prefix ${PREFIX} optional)`))

// a bad request must never take the server down
process.on('uncaughtException', (e) => console.error('uncaught', e?.message ?? e))
process.on('unhandledRejection', (e) => console.error('unhandled', e?.message ?? e))
