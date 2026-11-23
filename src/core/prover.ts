// One way to the proof server for everything this wallet proves: its own transfers and fee payments (through the
// SDK facade) and what sites ask it to prove (src/dapp/host.ts).
//
// Why not the SDK's own proof-server client: it asks `/prove` and `/check` at the ROOT of the prover's host and drops
// the path of the address it was given. Our prover door lives under a path (…/wallet/api/prover), and the root of
// that host is another service. Here the address is used as written.
//
// What the proof server is sent: the private inputs of the proof it is asked for. For a spend of private (shielded)
// coins those inputs include the coin secret key, so whoever runs the proof server could spend those coins. Public
// coins are spent with a signature made on the device and are not exposed this way. See docs/SECURITY.md.
import * as ledger from '@midnightntwrk/ledger-v9'
import { loadEndpoints } from './net'

const TIMEOUT_MS = 297_000
/** proofs waiting at the prover at once: a transaction asks for all of its proofs up front, the door takes 3 */
const AT_ONCE = 2
const TRIES = 4
/** a refusal that came back this fast was "busy" or "not reachable", not a proof that failed after minutes of work */
const QUICK_MS = 20_000

export class ProverError extends Error {
  constructor(readonly status: number) { super(status ? `prover answered ${status}` : 'the prover did not answer') }
}

let running = 0
const waiting: Array<() => void> = []
async function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go))
  running++
  try { return await fn() } finally { running--; waiting.shift()?.() }
}

/** POST one request to the prover (`/prove` or `/check`) and return its answer. */
export function proverPost(path: '/prove' | '/check', body: Uint8Array): Promise<Uint8Array> {
  const url = loadEndpoints().prover.replace(/\/+$/, '') + path
  return inTurn(async () => {
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now()
      let status = 0
      try {
        const r = await fetch(url, { method: 'POST', body: body as BodyInit, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (r.ok) return new Uint8Array(await r.arrayBuffer())
        status = r.status
      } catch { /* not reachable, or no answer in time */ }
      const again = attempt < TRIES && Date.now() - t0 < QUICK_MS && (status === 0 || status === 429 || (status >= 502 && status <= 504))
      if (!again) throw new ProverError(status)
      await new Promise((res) => setTimeout(res, 1_700 * 2 ** (attempt - 1)))
    }
  })
}

/** Proves with the proof server's built-in keys (the wallet's own circuits: transfers, fee payments). */
export const builtInProver = {
  check: async (pre: Uint8Array) => ledger.parseCheckResult(await proverPost('/check', ledger.createCheckPayload(pre, undefined))),
  prove: async (pre: Uint8Array, _keyLocation: string, overwrite?: bigint) => proverPost('/prove', ledger.createProvingPayload(pre, overwrite, undefined)),
  lookupKey: async () => undefined,
}

/** What the SDK facade proves its transactions with (WalletFacade.init `provingService`). */
export function provingService() {
  return {
    prove: async (tx: unknown): Promise<unknown> => {
      // everything this wallet builds is a ledger-9 transaction
      if (!(tx instanceof ledger.Transaction)) throw new Error('prover: not a ledger-9 transaction')
      return tx.prove(builtInProver as never, ledger.CostModel.initialCostModel())
    },
  }
}
