# Building

- [Requirements](#requirements)
- [Development in a browser](#development-in-a-browser)
- [A debug APK](#a-debug-apk)
- [Release signing](#release-signing)
- [Publishing an update](#publishing-an-update)
- [Tests](#tests)
- [Making it your own](#making-it-your-own)

## Requirements

- Node 24 and npm
- JDK 21
- Android SDK with platform 36 and build-tools 36.0.0 (`android/build.gradle` pins every module to 36.0.0)
- A deployment of the services, or at least a node, an indexer and a proof server: [Self-hosting](SELF-HOSTING.md)

The Midnight ledger is Rust compiled to WebAssembly and is loaded as an ES module, so the build targets current
engines only (a current Android System WebView). The bundle carries two ledger versions and is about 20 MB before
compression.

## Development in a browser

```bash
npm ci
```

```bash
npm run dev
```

The dev server (`http://127.0.0.1:5179`) expects the services on the same machine: an indexer on `:8188`, the node
guard on `:3142` (`npm run guard`), a proof server on `:6300`, and the wallet server on `:3143` (`npm run serve`).
`VITE_DEV_NODE_WS` and `WALLET_API` point it elsewhere.

Everything except the in-app browser, the back button and background sync works in a desktop browser, which is
where most development happens.

## A debug APK

```bash
cp .env.example .env.production.local
```

Name your server in that file, then:

```bash
npm run build
```

```bash
npx cap sync android
```

```bash
cd android && ./gradlew assembleDebug
```

Install `android/app/build/outputs/apk/debug/app-debug.apk` with `adb install -r`. A debug build's WebViews are
open to inspection (`chrome://inspect`); a release build's are not.

`CAP_WEB_DIR` chooses the folder Capacitor copies from (default `dist`). If `dist/` on your machine is a web build
that a wallet server is serving, build the app's copy somewhere else:

```bash
npx vite build --outDir dist-android && CAP_WEB_DIR=dist-android npx cap sync android
```

## Release signing

A release APK is signed with a key that you generate once and keep for the life of the app. **Lose the key and no
installed copy can ever be updated; leak it and anyone can ship an update to your users.** Keep it outside the
repository, back it up offline, and never give it to CI.

```bash
keytool -genkeypair -alias lumpwallet -keyalg RSA -keysize 4096 -validity 10950 -dname "CN=My Wallet" -keystore /secure/place/release.jks
```

Put the keystore password in a file next to it (`keystore-pass.txt`), readable only by you. Then:

```bash
LUMP_KEYSTORE=/secure/place/release.jks EXPECT_SIGNER="CN=My Wallet" bash tools/android-release.sh
```

The script builds the web code, syncs it into the Android project, runs `assembleRelease`, verifies that the APK
is signed by the certificate you named, **scans the finished APK for anything that names the build machine or its
user** (user name, home folders, local paths; `LUMP_PRIVACY_NEEDLES` adds patterns), and writes
`out/android/LumpWallet-<version>-<code>.apk` with its SHA-256.

The version code defaults to minutes since 1970, so every build is newer than the last. Gradle reads the keystore
from `LUMP_KEYSTORE` and `LUMP_KEYSTORE_PASS`; without them `assembleRelease` leaves the APK unsigned.

## Publishing an update

The wallet server hands out whichever build `out/android/published.json` names, at `/wallet/android/`, and answers
installed apps at `/wallet/api/android/latest`.

```bash
node tools/android-publish.mjs out/android/LumpWallet-0.1.0-<code>.apk
```

- Without a flag, older copies are offered the update and may put it off for a day.
- `--required` makes every older copy show "Update needed" until it updates. `--min <code>` sets that floor
  explicitly; `--min 0` lifts it. The floor carries over to later publishes.
- Publishing needs no restart. A build is not public until it is published: try it first.

## Tests

Self-contained (no network, no wallet):

```bash
node test/provider-proxy.mjs
```

```bash
node test/split.mjs
```

```bash
node test/dapp-guard.mjs
```

The last one builds hostile site transactions with the real ledger and the SDK's own signing step and checks that
the wallet refuses them.

With a browser (`npx playwright install chromium`); each starts the dev server and a wallet server of its own on
spare ports and uses throwaway wallets:

| Test | Covers |
| --- | --- |
| `test/update.mjs` | The update channel end to end: publish, offer, put off, required |
| `test/wallets.mjs` | Several wallets: add, switch, remove, storage separation |
| `test/favorites-ui.mjs` | Browser favorites |
| `test/dapp-queue.mjs` | Approval queue: one send per transaction, late requests, expiry |
| `test/dapp-hostile.mjs` | A hostile site at the connector: refused before any sheet, nothing signed; full amounts on the sheet; trades paid to another address |
| `test/smoke.mjs` | New wallet to the home screen (needs the local services) |
| `test/cardano-keys.mjs` | Cardano key derivation and signatures against a full Cardano library (`npm ci` in `server/cardano` first) |

On a device or emulator (`test/android/`, debug build installed, `adb` connected, `WALLET_HOST` set to your
server):

| Test | Covers |
| --- | --- |
| `emu.mjs` | First launch to "Up to date", Back on every level, the in-app browser with a real connect, what the browser view may not reach, restart |
| `release-smoke.mjs <apk>` | A release build starts, is not debuggable, has backups off, asks only for its listed permissions, keeps its WebViews closed, logs no wallet data |
| `handoff.mjs` | A browser creates a wallet and shares its sync; the app imports the same words and picks it up |
| `background.mjs` | A sync continues at the same pace after the app is left |

The emulator needs a "Google Play" system image to behave like a retail phone: plain images open every app's
WebViews to inspection and would hide whether a release build is closed.

CI in this repository (`.github/workflows/ci.yml`) type-checks, runs the self-contained tests, builds the web code
and assembles a debug APK. It does not run the on-device suite, which needs a live deployment.

## Making it your own

A fork that you hand to other people should not look like, or update as, the original:

1. **Application id.** Change `appId` in `capacitor.config.ts`, `namespace` and `applicationId` in
   `android/app/build.gradle`, the two strings in `android/app/src/main/res/values/strings.xml`, and move the Java
   package folder. Android treats a different id as a different app.
2. **Name and icon.** `appName`, `strings.xml`, the launcher icons under `android/app/src/main/res/mipmap-*`, and
   `public/icon-*.png`.
3. **Your own signing key** (above).
4. **Your own servers** ([Self-hosting](SELF-HOSTING.md)).
5. **The connector identity** in `src/dapp/provider.js` (name, icon, reverse-DNS id), so sites can tell wallets
   apart.
