// A site may wrap the wallet's connected API in a Proxy that hands out its own functions (to show progress, to note
// errors). JavaScript forbids that over a FROZEN object: reading any method then throws ("Proxy handler's 'get'
// result of a non-configurable and non-writable property should be the same value as the target's property" on
// iOS; "'get' on proxy: property ... is a read-only and non-configurable data property" elsewhere), and every wallet
// call of that site fails. This loads the injected provider with a stand-in wallet behind it and uses the connected
// API and the proving provider through such a Proxy. No browser, no chain.
//   node test/provider-proxy.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../src/dapp/provider.js', import.meta.url), 'utf8')
const calls = []
const sandbox = { crypto: globalThis.crypto, btoa, atob, setTimeout, clearTimeout, console, Uint8Array, ArrayBuffer }
sandbox.window = sandbox
// the stand-in wallet: answers every call on the next tick with the method's name
sandbox.webkit = { messageHandlers: { lumpWallet: { postMessage: (raw) => {
  const m = JSON.parse(raw)
  calls.push(m.method)
  // (circuit keys travel as blobs: "blobHas" answers which ones the wallet still lacks; none here)
  const result = m.method === 'proverCheck' ? [null] : m.method === 'blobHas' ? [] : { answered: m.method }
  setTimeout(() => sandbox.__lumpBridge.deliver(JSON.stringify({ id: m.id, result })), 0)
} } } }
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const wrap = (o) => new Proxy(o, { get(target, property) {
  const value = Reflect.get(target, property)
  return typeof value === 'function' ? (...args) => value.apply(target, args) : value
} })

const wallet = sandbox.midnight?.lumpwallet
check(!!wallet && typeof wallet.connect === 'function', 'the provider is on the page')
const api = await wallet.connect('mainnet')
try {
  const r = await wrap(api).getConfiguration()
  check(r?.answered === 'getConfiguration', 'a call through a wrapping Proxy reaches the wallet')
} catch (e) { check(false, `a call through a wrapping Proxy: ${String(e?.message ?? e).slice(0, 160)}`) }
try {
  const r = await wrap(api).submitTransaction('00')
  check(r?.answered === 'submitTransaction', 'submitTransaction through the Proxy')
} catch (e) { check(false, `submitTransaction through the Proxy: ${String(e?.message ?? e).slice(0, 160)}`) }
try {
  const proving = await wrap(api).getProvingProvider({ getZKIR: async () => new Uint8Array([1]), getProverKey: async () => new Uint8Array([2]), getVerifierKey: async () => new Uint8Array([3]) })
  const r = await wrap(proving).check(new Uint8Array([9]), 'mint')
  check(Array.isArray(r) && r[0] === undefined, 'the proving provider through a Proxy as well')
} catch (e) { check(false, `the proving provider through a Proxy: ${String(e?.message ?? e).slice(0, 160)}`) }
// what must stay fixed: the entry on window.midnight itself, so no later script can swap the wallet for its own
const d = Object.getOwnPropertyDescriptor(sandbox.midnight, 'lumpwallet')
check(d.writable === false && d.configurable === false && Object.isFrozen(wallet), 'the wallet entry on the page cannot be replaced')
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
