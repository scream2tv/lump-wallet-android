// Network endpoints.
//
// A build is tied to ONE deployment of the services in server/ (docs/SELF-HOSTING.md), named at build time:
//   VITE_WALLET_HOST   host[:port] that serves, over TLS: /wallet/ (server/static.mjs), /indexer/ (a Midnight
//                      indexer) and /node (server/node-guard.mjs in front of a Midnight node)
// Each service can also be named on its own (VITE_INDEXER_URL, VITE_INDEXER_WS_URL, VITE_NODE_WS, VITE_PROVER_URL),
// and every value is user-editable in Settings and kept per device.
//
// What each service learns is written down in docs/SECURITY.md. In short: the indexer learns which wallet is
// syncing, and the proof server receives the private inputs of what it proves, which for a spend of private coins
// includes key material. Point a build only at services you run yourself or trust with that.
export type Endpoints = {
  networkId: 'mainnet'
  indexerUrl: string
  indexerWsUrl: string
  nodeWs: string
  prover: string
}

const env = (name: string): string | undefined => { const v = (import.meta.env as Record<string, unknown>)[name]; return typeof v === 'string' && v.trim() ? v.trim() : undefined }
/** The wallet server of this build. Without one, nothing answers until endpoints are entered in Settings. */
const SERVER = env('VITE_WALLET_HOST') ?? 'wallet-server.invalid'
// dev server, or a build made with VITE_LOCAL=1 for the headless tests on this machine; the native shell also runs on "localhost" (capacitor://localhost) but must use the wallet server
const LOCAL_DEV = (import.meta.env.DEV || import.meta.env.VITE_LOCAL === '1') && typeof location !== 'undefined' && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)

/** Base for the wallet server's small APIs (prices, bootstrap snapshots, the prover door): same origin on the web, the wallet server in the app. */
export const API_BASE = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && (import.meta.env.DEV || import.meta.env.VITE_LOCAL === '1' || location.host === SERVER)
  ? import.meta.env.BASE_URL
  : `https://${SERVER}/wallet/`

export const DEFAULTS: Endpoints = {
  networkId: 'mainnet',
  // the deployment's mainnet indexer: desktop dev talks to it directly, phones through the rate-limited public path
  indexerUrl: LOCAL_DEV ? 'http://127.0.0.1:8188/api/v4/graphql' : (env('VITE_INDEXER_URL') ?? `https://${SERVER}/indexer/api/v4/graphql`),
  indexerWsUrl: LOCAL_DEV ? 'ws://127.0.0.1:8188/api/v4/graphql/ws' : (env('VITE_INDEXER_WS_URL') ?? `wss://${SERVER}/indexer/api/v4/graphql/ws`),
  // desktop dev talks to the node guard on this machine; phones go through the guarded public path
  nodeWs: LOCAL_DEV ? (env('VITE_DEV_NODE_WS') ?? 'ws://127.0.0.1:3142') : (env('VITE_NODE_WS') ?? `wss://${SERVER}/node`),
  // a ledger-9 proof server: the one on this machine in dev, the wallet server's own prover door for phones
  prover: LOCAL_DEV ? 'http://127.0.0.1:26300' : (env('VITE_PROVER_URL') ?? `https://${SERVER}/wallet/api/prover`),
}

/** Saved endpoints that can no longer work fall back to the default. */
const RETIRED: Array<{ keys: Array<keyof Endpoints>; test: (u: URL) => boolean }> = [
  // the public indexer was decommissioned 2026-10-09 (HTTP 410)
  { keys: ['indexerUrl', 'indexerWsUrl'], test: (u) => u.hostname === 'indexer.mainnet.midnight.network' },
  // ledger-8 proof servers: mainnet is on ledger 9 since 2026-11-06 and refuses what they prove
  { keys: ['prover'], test: (u) => (u.host === SERVER && /^\/(prove-station|prove-lite)?\/?$/.test(u.pathname)) || (/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && u.port === '6300') },
]

/**
 * A name for the deployment's indexer DATABASE (VITE_INDEXER_ID). Change it whenever that indexer is resynced from
 * scratch: its event ids (the wallet's sync offsets) change with it, and every cache and bootstrap snapshot carrying
 * the old name is then dropped once. Must be the same value as LW_INDEXER_ID of server/state-bot.mjs.
 */
export const OWN_INDEXER_ID = env('VITE_INDEXER_ID') ?? 'mainnet-1'

/**
 * Where the deployment's indexer has the ledger-9 fork in its DUST timeline: the id of the last DUST event before it
 * (VITE_DUST_FORK_CURSOR), and the protocol version of the first one after it. A DUST wallet that starts from nothing
 * starts here (all DUST was issued again at the fork; block 3,346,139 is the first on ledger 9), and with this value
 * it does not have to search the indexer for the place. Event ids are an indexer's own database ids, so the value
 * belongs to OWN_INDEXER_ID and has to be found again whenever that changes. Without it the wallet searches, which
 * is slower and never wrong. docs/SELF-HOSTING.md says how to find it.
 */
const forkCursor = env('VITE_DUST_FORK_CURSOR')
const OWN_DUST_FORK = forkCursor && /^\d+$/.test(forkCursor) ? { cursor: BigInt(forkCursor), version: 2_001_100n } : null
export const dustForkOf = (indexerUrl: string): { cursor: bigint; version: bigint } | null => (indexerId(indexerUrl) === OWN_INDEXER_ID ? OWN_DUST_FORK : null)

/**
 * Which indexer DEPLOYMENT a synced state belongs to. Sync offsets are indexer event ids and differ between
 * deployments, so a state synced against one must never resume against another: "values inserted non-linearly", or
 * a silently wrong state. The wallet server's public path and its local port are the same deployment; any other
 * indexer is identified by its host + path.
 */
export function indexerId(url: string): string {
  try {
    const u = new URL(url)
    if (u.host === SERVER && u.pathname.startsWith('/indexer/')) return OWN_INDEXER_ID
    if (/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && u.port === '8188') return OWN_INDEXER_ID
    return (u.host + u.pathname).toLowerCase().replace(/\/+$/, '')
  } catch { return url }
}

const KEY = 'lump.endpoints.v1'

export function loadEndpoints(): Endpoints {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Endpoints>
      // Settings saves every field, so a wallet that ever pressed Save has every endpoint of that day pinned
      for (const r of RETIRED) for (const k of r.keys) {
        try { if (saved[k] && r.test(new URL(saved[k] as string))) delete saved[k] } catch {}
      }
      return { ...DEFAULTS, ...saved }
    }
  } catch {}
  return DEFAULTS
}

/** Opt-in: send dApp-bridge diagnostics (method, outcome, timing, which site) to the wallet server. Default OFF. */
const DIAG_KEY = 'lump.diagnostics.v1'
export function diagnosticsOn(): boolean {
  try { return localStorage.getItem(DIAG_KEY) === '1' } catch { return false }
}
export function setDiagnostics(on: boolean) {
  try { if (on) localStorage.setItem(DIAG_KEY, '1'); else localStorage.removeItem(DIAG_KEY) } catch {}
}

export function saveEndpoints(e: Partial<Endpoints>) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...loadEndpoints(), ...e })) } catch {}
}
