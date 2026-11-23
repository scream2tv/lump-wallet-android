# Self-hosting

A build of Lump Wallet is tied to one deployment of the services below. This repository names no server: you
choose where your build points. This page lists what a deployment consists of, what is optional, and every setting.

- [Why there is a server at all](#why-there-is-a-server-at-all)
- [What a deployment consists of](#what-a-deployment-consists-of)
- [Three sizes of deployment](#three-sizes-of-deployment)
- [Public paths](#public-paths)
- [Running the services](#running-the-services)
- [Pointing a build at your deployment](#pointing-a-build-at-your-deployment)
- [The indexer id and the fork position](#the-indexer-id-and-the-fork-position)
- [Operating notes](#operating-notes)

## Why there is a server at all

A Midnight wallet needs a node to submit transactions, an indexer to read the chain, and a proof server to make
zero-knowledge proofs. None of that is specific to this wallet. On top of it, this wallet uses a small server of
its own for things that make a phone wallet pleasant: a one-minute first sync, a Cardano transaction builder for
fee energy, an update channel. Each of those is optional, and the app degrades without it instead of breaking.

Running these services costs real resources (a Midnight archive node and indexer, a Cardano node, a machine that
proves) and, in the case of the proof server, carries real responsibility for other people's keys
([security model](SECURITY.md#the-proof-server)). That is why the official beta's servers are for the official
beta build, and why a build from source brings its own.

## What a deployment consists of

| Service | Software | What the app uses it for | Without it |
| --- | --- | --- | --- |
| Midnight node | `midnight-node` (ledger 9) | Submitting transactions, reading contract state | The wallet cannot send |
| Node guard | `server/node-guard.mjs` | Allowlist proxy in front of the node's RPC | Do not expose a node's RPC without one |
| Midnight indexer | `midnight-indexer` v4 API | Sync, activity | The wallet cannot sync |
| Proof server | `midnightntwrk/proof-server` (ledger 9) | Proofs for private transfers and contract calls | No private sends, no dApp transactions |
| Wallet server | `server/static.mjs` | Snapshots, hand-off, prover door, Cardano door pass-through, prices, update channel, the web build | See the rows below |
| State bot | `server/state-bot.mjs` | Writes the public snapshots | First sync replays the chain (about an hour or more) |
| Cardano door | `server/cardano/door.mjs` + Kupo + Ogmios + a Cardano node | Cardano balances, sends, DUST registration | No Cardano tab; users register for DUST elsewhere |

## Three sizes of deployment

**Minimal: node, indexer, proof server.** Give the build the four `VITE_*_URL` values and no `VITE_WALLET_HOST`.
The wallet syncs (slowly the first time), sends and receives, and runs dApps. No snapshots, hand-off, prices,
Cardano tab or update notices. Any provider of Midnight endpoints will do, including a hosted one, subject to its
terms. A proof server you run yourself on a machine you control is the recommended choice in every size.

**Standard: add the wallet server and the state bot.** New wallets are up to date in about a minute, devices can
hand sync to each other, and you can publish updates to your users.

**Full: add the Cardano door.** Users can fund, register and manage fee energy inside the app. This needs a synced
Cardano mainnet node with Kupo and Ogmios.

## Public paths

The app expects one HTTPS host (`VITE_WALLET_HOST`) with these paths, which any reverse proxy can provide:

| Public path | Goes to | Notes |
| --- | --- | --- |
| `/wallet/` | `server/static.mjs` (default `127.0.0.1:3143`) | The prefix may be stripped or kept |
| `/indexer/` | The indexer's HTTP and WebSocket API (strip the prefix) | Add your own rate limit |
| `/node` | `server/node-guard.mjs` (default `127.0.0.1:3142`) | WebSocket |

All services listen on localhost only and expect TLS and client rate limiting from the proxy. The servers read the
client address from the **last** entry of `x-forwarded-for`: your proxy must append the real client there.

## Running the services

Node 24. From the repository root:

```bash
npm ci
```

```bash
node server/node-guard.mjs
```

```bash
LW_INDEXER_ID=mainnet-1 node --max-semi-space-size=128 server/state-bot.mjs
```

```bash
npm run build:web && npm run serve
```

For the Cardano door:

```bash
cd server/cardano && npm ci && node door.mjs
```

### Settings

**`server/static.mjs`**

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATIC_PORT` | `3143` | Listening port (localhost) |
| `WALLET_PROVERS` | `http://127.0.0.1:26301,http://127.0.0.1:26300` | Proof servers in order of preference; the next is asked only when one is unreachable or answers 5xx |
| `CARDANO_DOOR` | `http://127.0.0.1:3148` | The Cardano door |
| `MARKET_URL`, `ADA_USD_URL` | LumpTools public feeds | Price sources |
| `WALLET_ANDROID_DIR` | `out/android/` | Published APKs and `published.json` |
| `WALLET_HANDOFF_DIR` | `out/handoff/` | Encrypted hand-offs |

Limits built in: proofs 64 MB a request, 3 at once, 30 a minute per client; hand-offs 3 MB each, kept 71 hours,
600 MB in all, 5 writes and 40 reads a minute per client; the dApp trace 90 lines a minute per client into a file
capped at 32 MB.

**`server/node-guard.mjs`**: `GUARD_PORT` (`3142`), `GUARD_UPSTREAM` (`ws://127.0.0.1:9944`). 48 clients, 512 KB a
message, 120 messages a second per client.

**`server/state-bot.mjs`**: `LW_INDEXER`, `LW_INDEXER_WS`, `LW_NODE_WS`, `LW_PROVER` (local defaults),
`LW_INDEXER_ID`, `LW_DUST_FORK_CURSOR`, `LW_PUBLIC_HOST` (below), `BOT_SNAPSHOT_MS` (five minutes). Its first sync
replays the chain's shielded events once: about an hour of one busy core, reading the indexer throughout. After
that it follows the tip. It runs at low priority. Its seed (`out/bootstrap/bot-seed.json`) belongs to a wallet
that must never be funded.

**`server/cardano/door.mjs`**: `CARDANO_DOOR_PORT` (`3148`), `KUPO_URL` (`http://127.0.0.1:1442`), `OGMIOS_URL`
(`http://127.0.0.1:1337`), `MN_INDEXER_URL`, `CARDANO_DOOR_BUILDS_PER_MIN` (`7`). It holds no keys and submits only
transactions it built itself.

## Pointing a build at your deployment

Copy `.env.example` to `.env.production.local` (never committed) and fill it in:

```ini
VITE_WALLET_HOST=wallet.example.org
VITE_INDEXER_ID=mainnet-1
```

A production build without a server named is refused with a message that says so. Every endpoint remains editable
by the user in Settings.

## The indexer id and the fork position

Two values tie the app, the state bot and the indexer together.

- **`VITE_INDEXER_ID` / `LW_INDEXER_ID`** is a name you give your indexer's database. Sync offsets are the
  indexer's own event ids, so a wallet's cache or a snapshot made against one database must never be continued
  against another. Change the name whenever you resync the indexer from scratch: every app then drops its cache
  once and starts again from a fresh snapshot. The app and the bot must use the same value.
- **`VITE_DUST_FORK_CURSOR` / `LW_DUST_FORK_CURSOR`** is optional: the id of the last DUST event before the
  ledger-9 fork in your indexer (the first block on ledger 9 is 3,346,139). With it, a DUST wallet that starts from
  nothing begins at the fork without searching. Without it the SDK searches for the place, which works and costs
  the indexer a few subscriptions per new wallet. Find it by querying your indexer's `dustLedgerEvents` around
  that block; it changes when the indexer is resynced. `tools/dust-days.mjs` needs it.

## Operating notes

- **The indexer is the bottleneck.** A wallet that replays the chain reads millions of events. Rate-limit the
  public path, and prefer snapshots over replays.
- **The proof server spends CPU (or GPU) per request.** The door's limits keep a single client from monopolising
  it; size them for your users.
- **Treat the machine that proves as key-holding.** See the [security model](SECURITY.md#the-proof-server).
- **Publishing a build** to your users: [Building](BUILDING.md#publishing-an-update).
- **The dApp trace** (`out/dapp-log.jsonl`) is written only for users who switched diagnostics on. It holds site
  origins, method names, outcomes and timings.
