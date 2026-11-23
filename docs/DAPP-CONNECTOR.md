# dApp connector

For site developers: how Lump Wallet appears to a page in its in-app browser, and what it implements of the
Midnight DApp Connector API (`@midnightntwrk/dapp-connector-api` 4.1.0).

## Finding the wallet

The wallet injects one entry at document start, in the top frame only:

```js
const wallet = window.midnight?.lumpwallet
// wallet.name === 'Lump Wallet', wallet.rdns === 'xyz.lumptools.wallet', wallet.apiVersion, wallet.icon
const api = await wallet.connect('mainnet')
```

The entry on `window.midnight` cannot be replaced by the page. The object `connect()` returns is a plain object:
you may wrap it (for example in a `Proxy`).

The wallet is mainnet only. `connect()` with another network id is refused with `InvalidRequest`.

## Methods

| Method | Behaviour |
| --- | --- |
| `connect(networkId)` | Shows a connect sheet the first time an origin asks; remembered per origin and per wallet until removed in Settings |
| `getConfiguration()` | The indexer, node and prover addresses the wallet uses |
| `getUnshieldedAddress()`, `getShieldedAddresses()`, `getDustAddress()` | The wallet's addresses |
| `getUnshieldedBalances()`, `getShieldedBalances()`, `getDustBalance()` | Balances by token type |
| `getTxHistory(pageNumber, pageSize)` | The wallet's transaction history as the SDK has it |
| `makeTransfer(desiredOutputs, options)` | Builds, shows and sends a transfer |
| `makeIntent(desiredInputs, desiredOutputs, options)` | Builds a swap offer |
| `balanceUnsealedTransaction(tx)`, `balanceSealedTransaction(tx)` | Adds the wallet's inputs and fee to your transaction after the user approves |
| `submitTransaction(tx)` | Submits; resolves with the transaction identifier |
| `signData(data, options)` | Signs with the unshielded key (BIP-340 over SHA-256 of a prefixed message) after the user approves |
| `getProvingProvider(keyMaterialProvider)` | A proving provider backed by the wallet's proof server; your circuit keys travel to the wallet in pieces and are cached per session |
| `hintUsage(methods)` | Accepted |

## What the user sees

Every request that moves funds or signs opens a sheet in the wallet's own interface, one at a time. The sheet names
your origin (as the WebView reports it), what the wallet pays, the fee, and for known NFTs their names. Approve
arms after about a second, and by default the wallet asks for the PIN.

## Errors

Errors carry the API's codes: `Rejected` (the user said no), `PermissionRejected`, `Disconnected` (call `connect`
first), `InvalidRequest`, `InternalError`.

One message is worth knowing. When a transaction was sent but neither the node nor the wallet's own sync has
confirmed it within 90 seconds, `submitTransaction` rejects with `InternalError` and a message containing
"not confirmed it yet". The transaction may still land: treat it as pending, not failed.

## Limits

- **Do not put the wallet's coins into a transaction yourself.** A transaction handed to
  `balanceUnsealedTransaction` or `balanceSealedTransaction` that already spends a public coin of the wallet, or
  carries a fee energy registration for its key, is rejected with `InvalidRequest`. Leave the shortfall open: the
  wallet adds its coins when it balances. To have the wallet offer specific amounts, use `makeIntent`.
- One approval at a time. A second request waits its turn.
- One send per transaction: asking again for the same transaction returns the first request's result.
- A transaction the node would refuse for its validation cost is refused by the wallet with a readable message
  before it is sent.
- Messages across the bridge are capped at 7 MB each; large circuit keys are split automatically.
- A page that navigates to another origin stops receiving answers to requests made by the previous one.

## Testing your site

Any debug build of the app opens its WebViews to `chrome://inspect`. `test/android/emu.mjs` shows how to drive both
the wallet page and a site in the browser view from a script.
