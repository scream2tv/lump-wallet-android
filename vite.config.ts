import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { fileURLToPath } from 'node:url'

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url))

// The ledger is Rust compiled to WebAssembly and its loader imports the .wasm as an ES module
// (bundler target), so the build targets modern engines only (iOS 16.4+ / current Android WebView).
const WASM_PKGS = ['@midnightntwrk/ledger-v8', '@midnightntwrk/ledger-v9', '@midnightntwrk/zkir-v2', '@midnightntwrk/zkir-v3']

// the wallet server the dev pages use for snapshots, the dApp trace and device hand-offs (WALLET_API: a test instance)
const WALLET_API = process.env.WALLET_API ?? 'http://127.0.0.1:3143'

// A build that is handed to a phone has to know its services: see .env.example and docs/SELF-HOSTING.md.
function needsServer(): import('vite').Plugin {
  return {
    name: 'wallet-needs-server',
    apply: 'build',
    configResolved(config) {
      const e = config.env as Record<string, string | undefined>
      const each = e.VITE_INDEXER_URL && e.VITE_INDEXER_WS_URL && e.VITE_NODE_WS && e.VITE_PROVER_URL
      if (!e.VITE_WALLET_HOST && !each && e.VITE_LOCAL !== '1') {
        throw new Error('No wallet server is named for this build. Set VITE_WALLET_HOST (or the four VITE_*_URL values) in .env.production.local: see .env.example and docs/SELF-HOSTING.md.')
      }
    },
  }
}

export default defineConfig({
  // WALLET_BASE=/wallet/ builds for the wallet server's public path; dev and the native shell serve from /
  base: process.env.WALLET_BASE ?? '/',
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0') },
  plugins: [needsServer(), wasm(), react()],
  // Node builtins the SDK touches at runtime (assert in the SCALE codec, randomUUID, Buffer) get browser stand-ins
  resolve: { alias: { assert: shim('assert'), 'node:assert': shim('assert'), crypto: shim('crypto'), 'node:crypto': shim('crypto') } },
  build: { target: 'esnext', sourcemap: false },
  // dev: prices, bootstrap snapshots, the dApp trace and hand-offs from the wallet server (server/static.mjs :3143)
  server: { proxy: {
    '/api/market': { target: WALLET_API },   // the wallet server's relay, as a phone gets it (NIGHT from the market feed, ADA riding along)
    '/api/bootstrap': { target: WALLET_API },
    '/api/dapp-log': { target: WALLET_API },
    '/api/handoff': { target: WALLET_API },
    '/api/android': { target: WALLET_API },
    '/api/cardano': { target: WALLET_API },
  } },
  optimizeDeps: { exclude: WASM_PKGS, esbuildOptions: { target: 'esnext' } },
  worker: { format: 'es' },
})
