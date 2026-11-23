// Injected at document start into every page the in-app browser opens (and into the desktop harness page).
// Self-contained: no imports, runs before the page's own scripts. Defines window.midnight.lumpwallet with the
// Midnight DApp Connector v4 API. Every call is a message to the wallet; the wallet decides, and anything that
// moves funds is approved by the user there. The page cannot reach keys: only results come back.
(() => {
  'use strict'
  const KEY = 'lumpwallet'
  const API_VERSION = '4.1.0'
  // the way to the wallet: a WebKit message handler in the iOS app (and the desktop harness), an object the app's
  // WebView adds to the page in the Android app (answers come back on that same object)
  const ios = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lumpWallet
  const droid = !ios && window.lumpWalletNative && typeof window.lumpWalletNative.postMessage === 'function' ? window.lumpWalletNative : null
  const handler = ios || droid
  if (!handler || (window.midnight && window.midnight[KEY])) return

  // ---- value codec: JSON plus bigint and bytes (shared format with src/dapp/codec.ts) ----
  const b64 = (u8) => {
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  }
  const unb64 = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8 }
  const enc = (v) => {
    if (typeof v === 'bigint') return { $big: v.toString() }
    if (v instanceof Uint8Array) return { $b64: b64(v) }
    if (v instanceof ArrayBuffer) return { $b64: b64(new Uint8Array(v)) }
    if (Array.isArray(v)) return v.map(enc)
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = enc(v[k]); return o }
    return v
  }
  const dec = (v) => {
    if (Array.isArray(v)) return v.map(dec)
    if (v && typeof v === 'object') {
      if (typeof v.$big === 'string') return BigInt(v.$big)
      if (typeof v.$b64 === 'string') return unb64(v.$b64)
      const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k]); return o
    }
    return v
  }

  // ---- request / response ----
  // ids carry a per-page random prefix: a response meant for a previous page can never resolve a call here
  const page = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
  let seq = 0
  const pending = new Map()
  const apiError = (code, reason) => Object.assign(new Error(reason), { type: 'DAppConnectorAPIError', code, reason })

  // calls that wait on the user have no deadline; everything else fails loudly instead of hanging forever
  const DEADLINE = { connect: 0, signData: 0, makeIntent: 0, balanceUnsealedTransaction: 0, balanceSealedTransaction: 0, makeTransfer: 0, submitTransaction: 0, proverProve: 307_000, proverCheck: 127_000 }
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = `${page}.${++seq}`
    const ms = DEADLINE[method] ?? 61_000
    const timer = ms ? setTimeout(() => { if (pending.delete(id)) reject(apiError('InternalError', `wallet did not answer ${method}`)) }, ms) : 0
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    try { handler.postMessage(JSON.stringify({ id, method, params: enc(params === undefined ? [] : params) })) }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(apiError('InternalError', 'wallet bridge unavailable')) }
  })

  const deliver = (raw) => {
    let msg
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
    const p = msg && pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(apiError(msg.error.code || 'InternalError', msg.error.reason || 'wallet error'))
    else p.resolve(dec(msg.result))
  }
  Object.defineProperty(window, '__lumpBridge', { value: Object.freeze({ deliver }), enumerable: false })
  if (droid) droid.onmessage = (e) => deliver(e.data)

  // ---- proving: key material comes from the dApp, the wallet's prover does the work ----
  // Circuit keys are large (10-25 MB). They travel as content-addressed blobs (sha256) in small pieces, once per
  // wallet session: a single huge bridge message is not reliable on mobile WebViews.
  const PIECE = 512 * 1024
  const sha = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)), (b) => b.toString(16).padStart(2, '0')).join('')
  const upload = async (blobs) => {
    const ids = await Promise.all(blobs.map(sha))
    const missing = new Set(await call('blobHas', [ids]))
    for (let i = 0; i < blobs.length; i++) {
      if (!missing.has(ids[i])) continue
      const b = blobs[i], total = Math.max(1, Math.ceil(b.length / PIECE))
      for (let k = 0; k < total; k++) await call('blobPut', [ids[i], k, total, b.subarray(k * PIECE, (k + 1) * PIECE)])
    }
    return ids
  }
  const material = async (kmp, loc) => {
    // built-in circuits (zswap, dust) have no dApp keys: the prover already knows them
    let keys
    try { keys = await Promise.all([kmp.getProverKey(loc), kmp.getVerifierKey(loc), kmp.getZKIR(loc)]) } catch { return undefined }
    const [proverKey, verifierKey, ir] = await upload(keys)
    return { proverKey, verifierKey, ir }
  }
  const zkir = async (kmp, loc) => {
    let ir
    try { ir = await kmp.getZKIR(loc) } catch { return undefined }
    return (await upload([ir]))[0]
  }

  const connected = (networkId) => {
    let live = true
    const m = (name) => (...args) => (live ? call(name, args) : Promise.reject(apiError('Disconnected', 'connection closed')))
    const api = {
      getShieldedBalances: m('getShieldedBalances'),
      getUnshieldedBalances: m('getUnshieldedBalances'),
      getDustBalance: m('getDustBalance'),
      getShieldedAddresses: m('getShieldedAddresses'),
      getUnshieldedAddress: m('getUnshieldedAddress'),
      getDustAddress: m('getDustAddress'),
      getTxHistory: m('getTxHistory'),
      balanceUnsealedTransaction: m('balanceUnsealedTransaction'),
      balanceSealedTransaction: m('balanceSealedTransaction'),
      makeTransfer: m('makeTransfer'),
      makeIntent: m('makeIntent'),
      signData: m('signData'),
      submitTransaction: m('submitTransaction'),
      getConfiguration: m('getConfiguration'),
      getConnectionStatus: async () => {
        if (!live) return { status: 'disconnected' }
        try { return await call('getConnectionStatus', []) } catch { return { status: 'disconnected' } }
      },
      hintUsage: m('hintUsage'),
      getProvingProvider: async (kmp) => {
        if (!live) throw apiError('Disconnected', 'connection closed')
        await call('getProvingProvider', [])
        // not frozen, like the connected API below
        return {
          check: async (preimage, loc) => {
            const r = await call('proverCheck', [preimage, loc, await zkir(kmp, loc)])
            return r.map((x) => (x == null ? undefined : x))
          },
          prove: async (preimage, loc, overwriteBindingInput) =>
            call('proverProve', [preimage, loc, overwriteBindingInput, await material(kmp, loc)]),
        }
      },
    }
    void networkId
    // NOT frozen. This object is the page's own copy of the connection, so freezing it protects nothing, and a page
    // that wraps it in a Proxy handing out its own functions (to show progress or note errors) cannot read a single
    // method of a frozen object: the language forbids it, and every wallet call of that page then fails
    // (test/provider-proxy.mjs). The entry on window.midnight below stays frozen and fixed: that one is shared.
    return api
  }

  const initial = Object.freeze({
    rdns: 'xyz.lumptools.wallet',
    name: 'Lump Wallet',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="21" fill="#0C0E13"/><g transform="translate(6.719999999999999 7.579999999999999) scale(0.86)"><path d="M45 37V24.5a10.5 10.5 0 0 1 21 0V26" fill="none" stroke="#5D79FF" stroke-width="4.2" stroke-linecap="round"/><circle cx="66.5" cy="28.5" r="6.2" fill="#FFFFFF"/><ellipse cx="48" cy="56" rx="25" ry="24" fill="#2B49FF"/><circle cx="27" cy="65" r="11" fill="#2B49FF"/><circle cx="69" cy="65" r="11" fill="#2B49FF"/><ellipse cx="48" cy="68" rx="22" ry="14" fill="#2B49FF"/><circle cx="37" cy="52" r="7" fill="#FFFFFF"/><circle cx="59" cy="52" r="7" fill="#FFFFFF"/><circle cx="37" cy="52" r="3.4" fill="#0C0E13"/><circle cx="59" cy="52" r="3.4" fill="#0C0E13"/><path d="M34 66.9 37 61.2 40 69.1ZM41.4 69.8 44.4 63.1 47.2 70.3ZM48.8 70.3 51.6 63.1 54.6 69.8ZM56 69.1 59 61.2 62 66.9Z" fill="#FFFFFF"/><path d="M27.5 62.5Q48 78 68.5 62.5" fill="none" stroke="#0C0E13" stroke-width="2.6" stroke-linecap="round"/></g></svg>'),
    apiVersion: API_VERSION,
    connect: async (networkId) => {
      await call('connect', [String(networkId)])
      return connected(String(networkId))
    },
  })

  if (!window.midnight || typeof window.midnight !== 'object') window.midnight = {}
  Object.defineProperty(window.midnight, KEY, { value: initial, enumerable: true, configurable: false, writable: false })
})()
