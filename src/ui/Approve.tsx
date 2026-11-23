import { useEffect, useState } from 'react'
import type { Snapshot } from '../core/wallet'
import { fmtUnits, DUST_DECIMALS } from '../core/wallet'
import { lookupToken } from '../core/tokens'
import { siteName } from '../dapp/connections'
import type { Amount, Ask } from '../dapp/host'
import type { Nft } from '../core/nfts'

/** Approval sheet for one dApp request. Module-level component: Home re-renders every second. */
export function Approve({ ask, snap, priceFor, nfts, onAnswer }: { ask: Ask; snap: Snapshot; priceFor: (type: string) => number | null; nfts: Nft[]; onAnswer: (ok: boolean) => void }) {
  // an NFT the wallet holds is shown by its name, not as "0.000001" of a token nobody knows
  const nftOf = (a: Amount) => (a.value === 1n ? nfts.find((n) => n.type === a.type && n.lane === a.lane) : undefined)
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1_000); return () => clearInterval(t) }, [])
  // the sheet appears where the user was just tapping the dApp: arm the buttons only after a beat, so a tap the
  // page timed to land on "Approve" does nothing
  const [armed, setArmed] = useState(false)
  useEffect(() => { setArmed(false); const t = setTimeout(() => setArmed(true), ARM_MS); return () => clearTimeout(t) }, [ask])

  const moves = ask.kind === 'balance' || ask.kind === 'transfer' || ask.kind === 'intent' || ask.kind === 'submit'
  // a fee-less request (the site sponsors the DUST) needs only the token sides synced: no DUST wait, no live wait
  const feeless = (ask.kind === 'balance' || ask.kind === 'transfer' || ask.kind === 'intent') && !ask.payFees
  const readyIn = snap.readyForTxAt ? Math.max(0, Math.ceil((snap.readyForTxAt - Date.now()) / 1000)) : null
  const blocked = moves && (feeless ? !snap.tradeReady : (snap.phase !== 'ready' || readyIn == null || readyIn > 0))
  const title = ask.kind === 'connect' ? 'Connect' : ask.kind === 'submit' ? 'Send transaction' : ask.kind === 'intent' ? 'Approve trade' : ask.kind === 'sign' ? 'Sign message' : 'Approve transaction'

  return (
    <div className="sheet-back" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet">
        <div className="tiny">{siteName(ask.origin)}</div>
        <div style={{ fontSize: 21, fontWeight: 700 }}>{title}</div>

        {ask.kind === 'connect' && (
          <div className="card" style={{ display: 'grid', gap: 9 }}>
            <div>See your balances and addresses</div>
            <div>Ask you to approve transactions</div>
            <div className="tiny">It cannot move funds without your approval. Disconnect any time in Settings.</div>
          </div>
        )}

        {ask.kind === 'balance' && (
          <div className="card" style={{ display: 'grid', gap: 11 }}>
            {/* an NFT handed to a site (a listing) is sent, not paid */}
            <div className="tiny">{ask.pays.length > 0 && ask.pays.every((x) => nftOf(x)) ? 'You send' : 'You pay'}</div>
            {ask.pays.map((a) => <AmountRow key={a.lane + a.type} a={a} priceFor={priceFor} nft={nftOf(a)} />)}
            {ask.pays.length === 0 && ask.complete && <div className="muted">No tokens leave your wallet</div>}
            {!ask.complete && <div className="err">Part of this transaction could not be read. The amount above may be incomplete; only approve if you trust this site.</div>}
            {ask.payFees && (
              <div className="row spread">
                <span className="tiny">Network fee</span>
                <span className="muted">~{fmtUnits(ask.fee, DUST_DECIMALS, 3)} DUST</span>
              </div>
            )}
          </div>
        )}

        {ask.kind === 'transfer' && (
          <div className="card" style={{ display: 'grid', gap: 11 }}>
            {ask.outputs.map((o, i) => (
              <div key={i} style={{ display: 'grid', gap: 3 }}>
                <AmountRow a={o} priceFor={priceFor} nft={nftOf(o)} />
                <div className="tiny mono" style={{ wordBreak: 'break-all' }}>to {o.recipient}</div>
              </div>
            ))}
          </div>
        )}

        {ask.kind === 'intent' && (
          <div className="card" style={{ display: 'grid', gap: 11 }}>
            <div className="tiny">You offer</div>
            {ask.pays.map((a) => <AmountRow key={a.lane + a.type} a={a} priceFor={priceFor} nft={nftOf(a)} />)}
            {ask.receives.length > 0 && <div className="tiny">You receive</div>}
            {ask.receives.map((o, i) => (
              <div key={i} style={{ display: 'grid', gap: 3 }}>
                <AmountRow a={o} priceFor={priceFor} />
                <div className="tiny mono" style={{ wordBreak: 'break-all' }}>to {o.recipient}</div>
              </div>
            ))}
            <div className="tiny">The site completes this trade in a transaction of its own{ask.payFees ? '' : ' and pays the network fee'}. Only the amount above can leave your wallet.</div>
          </div>
        )}

        {ask.kind === 'sign' && (
          <div className="card" style={{ display: 'grid', gap: 9 }}>
            {ask.text != null
              ? <div className="mono" style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 211, overflowY: 'auto' }}>{ask.text}</div>
              : <div>{ask.bytes.toLocaleString('en-US')} bytes of data this wallet cannot show as text</div>}
            <div className="tiny">Signing proves this wallet's public address is yours. It moves nothing and costs nothing.</div>
          </div>
        )}

        {ask.kind === 'submit' && (
          <div className="card err">This site wants to send a transaction this wallet did not prepare. Only continue if you started it.</div>
        )}

        {blocked && <div className="tiny" style={{ textAlign: 'center' }}>{feeless || snap.phase !== 'ready' ? 'Finishing sync…' : `Getting ready · ${fmtClock(readyIn ?? 0)}`}</div>}
        <div className="row">
          <button className="btn ghost" data-back disabled={!armed} onClick={() => onAnswer(false)}>Cancel</button>
          <button className="btn" disabled={blocked || !armed} onClick={() => onAnswer(true)}>{ask.kind === 'connect' ? 'Connect' : ask.kind === 'sign' ? 'Sign' : 'Approve'}</button>
        </div>
      </div>
    </div>
  )
}

function AmountRow({ a, priceFor, nft }: { a: Amount; priceFor: (type: string) => number | null; nft?: Nft }) {
  // the name the wallet's own NFT list shows for it (core/nfts.ts decides which contract may name a token)
  if (nft) return (
    <div className="row spread">
      <span style={{ fontWeight: 600 }}>{nft.name}<span className="tiny"> · {nft.collection} · {a.lane}</span></span>
    </div>
  )
  const meta = lookupToken(a.type)
  const p = priceFor(a.type)
  const usd = p == null ? null : (Number(a.value) / 10 ** meta.decimals) * p
  return (
    <div className="row spread">
      <span style={{ fontWeight: 600 }}>{fmtUnits(a.value, meta.decimals, meta.decimals)} {meta.ticker}<span className="tiny"> · {a.lane}</span></span>
      <span className="muted">{usd == null ? '' : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span>
    </div>
  )
}

const ARM_MS = 937
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
