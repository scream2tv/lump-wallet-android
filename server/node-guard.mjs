// Node RPC guard: a WebSocket proxy that sits between the public path and the Midnight node
// (ws://127.0.0.1:9944). The node answers unsafe methods (author_rotateKeys, author_insertKey,
// system_addReservedPeer, offchain_*) to any localhost caller, and a reverse proxy on the same machine arrives as localhost,
// so only an allowlist of read/submit methods passes. Everything else gets a JSON-RPC error and a log line.
//
//   node server/node-guard.mjs            (listens on 127.0.0.1:3142; public path /node -> here)
//   GUARD_PORT / GUARD_UPSTREAM override.  GET / on the same port = health JSON.
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.env.GUARD_PORT ?? 3142)
const UPSTREAM = process.env.GUARD_UPSTREAM ?? 'ws://127.0.0.1:9944'
const MAX_CLIENTS = 48
const MAX_MSG_BYTES = 512 * 1024
const MAX_MSGS_PER_SEC = 120

const ALLOW = [
  /^chain_/, /^state_/, /^chainHead_v1_/, /^chainSpec_v1_/, /^archive_v1_/, /^archive_unstable_/,
  /^transaction_v1_/, /^transactionWatch_v1_/, /^payment_/, /^midnight_/, /^rpc_methods$/,
  /^author_(submitExtrinsic|submitAndWatchExtrinsic|unwatchExtrinsic|pendingExtrinsics)$/,
  /^system_(chain|chainType|health|name|properties|version|syncState|accountNextIndex|dryRun|localPeerId|nodeRoles|peers)$/,
]
const allowed = (m) => typeof m === 'string' && ALLOW.some((re) => re.test(m))

const ts = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(ts(), ...a)
let clients = 0, denied = 0, forwarded = 0

const http = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, clients, forwarded, denied, upstream: UPSTREAM }))
})
const wss = new WebSocketServer({ server: http, maxPayload: MAX_MSG_BYTES })

wss.on('connection', (client, req) => {
  if (clients >= MAX_CLIENTS) { client.close(1013, 'busy'); return }
  clients++
  const ip = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress
  const up = new WebSocket(UPSTREAM)
  const queue = []
  let windowStart = Date.now(), windowCount = 0

  const reject = (id, method) => {
    denied++
    log('deny', ip, method)
    client.send(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: 'method not allowed' } }))
  }
  const forward = (raw) => { if (up.readyState === WebSocket.OPEN) up.send(raw); else queue.push(raw) }

  client.on('message', (buf, isBinary) => {
    if (isBinary) return
    const now = Date.now()
    if (now - windowStart > 1000) { windowStart = now; windowCount = 0 }
    if (++windowCount > MAX_MSGS_PER_SEC) { client.close(1008, 'rate'); return }
    let msg
    try { msg = JSON.parse(buf.toString()) } catch { return }
    // forward the re-serialized object, never the raw text: what was checked is exactly what the node receives
    // (raw text could carry duplicate keys or other parser-dependent ambiguities)
    const clean = (m) => (m && typeof m === 'object' && !Array.isArray(m) && typeof m.method === 'string' ? { jsonrpc: '2.0', id: m.id ?? null, method: m.method, params: m.params ?? [] } : null)
    if (Array.isArray(msg)) {
      if (msg.length > 32) { client.close(1009, 'batch too large'); return }
      const ok = [], bad = []
      for (const m of msg) { const c = clean(m); (c && allowed(c.method) ? ok : bad).push(c ?? m) }
      bad.forEach((m) => reject(m?.id, m?.method))
      if (ok.length) { forwarded += ok.length; forward(JSON.stringify(ok)) }
      return
    }
    const c = clean(msg)
    if (!c || !allowed(c.method)) { reject(msg?.id, msg?.method); return }
    forwarded++
    forward(JSON.stringify(c))
  })
  up.on('open', () => { for (const raw of queue.splice(0)) up.send(raw) })
  up.on('message', (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }) })
  const closeBoth = () => { clients--; try { up.close() } catch {} try { client.close() } catch {} }
  up.on('close', () => { if (client.readyState === WebSocket.OPEN) client.close(1012, 'upstream closed') })
  up.on('error', (e) => { log('upstream error', e.message); if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream') })
  client.on('close', closeBoth)
  client.on('error', () => {})
})

// keepalive: drop dead clients so the counter stays honest
setInterval(() => { for (const c of wss.clients) { if (c.isAlive === false) { c.terminate(); continue } c.isAlive = false; c.ping() } }, 30_000)
wss.on('connection', (c) => { c.isAlive = true; c.on('pong', () => { c.isAlive = true }) })

http.listen(PORT, '127.0.0.1', () => log(`node guard on 127.0.0.1:${PORT} -> ${UPSTREAM}`))
process.on('uncaughtException', (e) => log('uncaught', e?.message ?? e))
process.on('unhandledRejection', (e) => log('unhandled', e?.message ?? e))
