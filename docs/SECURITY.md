# Security model

What Lump Wallet protects, with what, and where it does not. This page is meant to be read critically: if a
statement here is wrong or incomplete, that is a finding, and we want to hear it
([how to report](../SECURITY.md)).

**The wallet has not been independently audited.** It has been reviewed internally, including adversarial review
of the key storage, the dApp connector, the transaction code and the servers, and automated review on changes to
security-sensitive code. That is not a substitute for an audit.

- [What you trust](#what-you-trust)
- [The recovery phrase at rest](#the-recovery-phrase-at-rest)
- [While the wallet is unlocked](#while-the-wallet-is-unlocked)
- [The proof server](#the-proof-server)
- [The indexer and the node](#the-indexer-and-the-node)
- [The wallet server](#the-wallet-server)
- [Sites in the in-app browser](#sites-in-the-in-app-browser)
- [The Cardano side](#the-cardano-side)
- [Distribution and updates](#distribution-and-updates)
- [Known limits](#known-limits)

## What you trust

| You trust | With | Because |
| --- | --- | --- |
| The device and its WebView | Everything | The phrase is decrypted and used there |
| Whoever built and signed your APK | Everything | They chose the code and the servers it talks to |
| The proof server | The private inputs of what it proves, which for a private spend includes key material | The wallet does not prove on the device yet |
| The indexer | Knowing which private coins are yours; honest chain data | It filters the chain for the wallet |
| The node | Honest chain data; relaying your transactions | The wallet does not verify consensus |
| The wallet server | Honest snapshots, prices and update notices; availability | See below; it cannot move funds |

A build made from this repository talks to the services named at build time (and to whatever is entered in
Settings). The official beta build talks to the services its publisher runs. If you would rather not extend that
trust, build your own copy against services you run: [Self-hosting](SELF-HOSTING.md).

## The recovery phrase at rest

The 24 words are stored encrypted twice (`src/core/vault.ts`): under a key derived from the PIN (scrypt, N = 2^16,
then AES-256-GCM) and then under a device key.

- **On Android the device key is kept by the Android Keystore** (`SecureStorePlugin.java`): it is encrypted with a
  Keystore key that cannot be taken off the phone (on phones with the hardware for it, the key never leaves that
  hardware), and only the encrypted value is in the app's files. A copy of the app's files is then useless without
  the phone: the stored phrase cannot even be tried against a PIN.
- **What that does not cover.** Someone with full control of the running phone (root, or malware with the app's own
  rights) can ask the Keystore to decrypt as the app does, and is then held back by the PIN alone. A six-digit PIN
  has one million values; scrypt slows each guess and does not make a million guesses infeasible. The Keystore key
  is not bound to the screen lock or to a fingerprint, on purpose: both bindings have a history of keys that stop
  working on some phones, and a device key that stops working means restoring from the 24 words.
- **Copies installed before 23 November 2026** kept the device key in the WebView's own storage, beside the data it
  locks. They move it into the Keystore at the first unlock after updating (`moveToSystemStore` in
  `src/core/vault.ts`): each wallet's outer lock is re-made and read back before it is stored, and the old key is
  deleted only when every wallet opens with the new one. A copy that has not updated is still held back by the PIN
  alone against someone who has its files.
- In a browser (the web build) there is no system key store: the device key is a non-extractable WebCrypto key in
  the browser's own storage, beside the data.
- The app's data is excluded from Android backup and device transfer.
- Wrong PINs make the wallet wait: after four misses, each further one costs half a minute, a minute, five
  minutes, fifteen, then an hour each. This protects against someone holding the phone, not against an offline
  copy.
- The encrypted sync cache is protected by a key derived from the PIN's scrypt output alone. It holds no recovery
  phrase and no spending key, but someone with a copy of it can test PIN guesses against it offline, and a found
  PIN reveals what the cache holds (which coins are the wallet's).

## While the wallet is unlocked

The seed and the SDK's secret keys are in the page's memory while the wallet is unlocked: a Midnight wallet cannot
follow the chain with public keys alone. Auto-lock (three minutes by default) covers the screen and asks for the
PIN again; the session keeps running behind it so that sync continues. A send, and approving a site's transaction,
ask for the PIN again unless that was switched off. The app does not currently set Android's `FLAG_SECURE`, so
screens can be captured by the system's screenshot and recents features.

## The proof server

A proof server receives the private inputs of the proof it computes. For a transfer of **private (shielded)
coins**, those inputs include the coin secret key: we confirmed this by test with a throwaway key, where the key's
bytes appear in the proving request. The same construction applies to the DUST key used for fees.

Consequences, plainly:

- Whoever operates the proof server a build uses, or breaks into it, can learn the keys that spend that user's
  private coins and fee energy.
- **Public (unshielded) coins are not exposed this way.** They are spent with a signature that is made on the
  device.
- The recovery phrase is never sent anywhere.

So the claim "your keys never leave the phone" would be false for this wallet, and the app does not make it. The
proof server is as trusted as the device. The mitigations are structural: run your own proof server and point the
wallet at it in Settings, or build your own copy of the app. Proving on the device removes the problem and is the
intended direction; the SDK's WASM prover needs more memory and time than most phones give a WebView today.

## The indexer and the node

- The indexer learns which private coins belong to the syncing wallet (it filters the chain for it) and the
  wallet's public address. It can show invented history or hide real history. It cannot spend funds.
- The node relays transactions and reports chain data; it is not verified against consensus by the wallet.
- Contract state for NFTs is read from the node.
- The node is reached through an allowlist proxy (`server/node-guard.mjs`) that passes read and submit methods
  only. That protects the node operator, not the user.

## The wallet server

`server/static.mjs` and its companions. What it can and cannot do:

| Service | It sees | It could, if hostile |
| --- | --- | --- |
| Snapshots | Nothing about the wallet (a public file is fetched) | Serve a wrong tree, making a wallet miss coins or build transactions the chain rejects. It cannot spend. |
| Hand-off | Ciphertext under an id derived from the phrase; size and time | Withhold or delete. It can neither read nor forge one. |
| Prover door | Everything the proof server sees (above) | Everything a proof server could |
| Cardano door | The wallet's Cardano address and DUST address | Build a wrong transaction: the app's byte-by-byte check is the defence. Refuse service. |
| Prices | That a client asked | Show wrong prices |
| Update notice | That a client asked, and its build number | Show "Update needed" and link to its download page. Android refuses an APK signed with another key over the installed app. |
| dApp trace | Only if switched on in Settings: site origin, method, outcome, timing | Nothing further |

Client addresses are visible to the server like to any web server. Rate limits are per client address.

## Sites in the in-app browser

- A site's identity is the origin the WebView reports for the top frame. Frames get no wallet object.
- A site learns nothing before the user connects it; then it can read addresses and balances.
- Every transaction a site asks for is shown on a sheet in the wallet's own page and needs a tap (and the PIN,
  by default). Approve buttons arm after about a second so that a tap aimed at the page cannot land on them.
- `signData` shows text as text. Data given as hex or base64 is shown as such and cannot be meaningfully read by
  a person: sign only what a site you trust asks for.
- **A site cannot name the wallet's coins itself** (`src/dapp/guard.ts`). Balancing a site's transaction ends with
  the wallet's signature on the site's intents, and that signature covers every public coin of the wallet they
  spend, whoever listed it. So a transaction that already spends a coin of this wallet, or registers its key for
  fee energy, is refused before any sheet comes up, and again on the exact bytes at the point of signing. The
  wallet's own coins enter a site's transaction only through balancing.
- **The amounts on a sheet are counted per part of the transaction.** A transaction has a part that always happens
  and parts that may fail on their own; a surplus in one does not offset a shortfall in another, so every shortfall
  is shown in full.
- A trade offer (`makeIntent`) whose proceeds go to an address that is not this wallet's says so on the sheet.
- Approval sheets summarise a transaction's effect on the wallet; they do not show the raw transaction. Connect
  only to sites you trust, as you would with any wallet.
- Connections do not expire by themselves. They are listed, and can be removed, in Settings.

## The Cardano side

The Cardano keys come from the same phrase and never leave the device. Transactions are built by the server and
verified on the device before signing (`src/core/cardanoTx.ts`): outputs, mint, fee, collateral and the absence of
every other field are checked, the fee and the collateral are capped, and the signed id is computed locally. The
door is treated as untrusted: it can refuse service, and it should not be able to redirect funds.

## Distribution and updates

- The beta is distributed as an APK outside any store. What stands between a user and a tampered copy is the
  download channel's TLS and, for updates, Android's signature check against the installed app. A first install
  has no such check: verify the SHA-256 shown on the download page against what the publisher announced elsewhere.
- The update notice is not signed separately from the transport.
- Whoever holds the release key can ship code to every install. Key custody is the publisher's responsibility;
  a fork must generate its own key (see [Building](BUILDING.md#release-signing)).
- A published build records the commit it was built from and the certificate that signed it
  (`out/android/published.json` on the wallet server), and the release script refuses to build from uncommitted
  changes.

## Known limits

- No independent audit.
- Android copies that have not updated since 23 November 2026 keep their device key outside the Keystore (above).
- The sync cache is a place to test PIN guesses for someone who has a copy of the app's files (above).
- The proof server sees private-spend key material (above).
- No biometric unlock on Android yet.
- No `FLAG_SECURE`.
- The PIN is six digits.
- One account per phrase; no hardware wallet support.
- Private (shielded) transaction history is incomplete: the SDK does not provide it, so the wallet records what it
  sent itself.
- Amount parsing treats a comma as a thousands separator, not a decimal point.
- Token names for unknown tokens are shortened type ids; unknown tokens are shown with six decimals.

If you find something that is not on this list, please [report it privately](../SECURITY.md).
