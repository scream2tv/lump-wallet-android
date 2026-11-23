import { useEffect, useMemo, useState } from 'react'
import { WalletSession, type Snapshot, fmtUnits, DUST_DECIMALS } from '../core/wallet'
import { lookupToken } from '../core/tokens'
import { parseAddress, parseAmount, sendErrorMessage, type ParsedAddress, type SendPhase } from '../core/send'
import type { PriceFor } from '../core/prices'
import { Header } from './Header'
import { copyText, pasteText } from './copy'
import { Scan } from './Scan'
import { confirmUser } from './Confirm'
import { MAX_PARTS, PartialSend } from '../core/split'

type Step = 'token' | 'to' | 'scan' | 'amount' | 'review' | 'sending' | 'sent'

// a QR may carry a bare address or a payment link like midnight:<address>?amount=…; take the address part
const addressFromQr = (text: string) => text.trim().replace(/^(midnight|lump):/i, '').split(/[?&#]/)[0]
type Row = { lane: 'public' | 'private'; type: string; v: bigint }

const PHASE_TEXT: Record<SendPhase, string> = {
  building: 'Building the transaction…',
  proving: 'Building the privacy proof… this can take a minute',
  submitting: 'Sending…',
  done: 'Sent',
}

/** `nft`: send that one NFT (a single unit of its token type). `skip`: token types the token list leaves out (the NFTs). */
export function Send({ session, snap, priceFor, onBack, onToast, nft, skip, onFeeHelp }: { session: WalletSession; snap: Snapshot; priceFor: PriceFor; onBack: () => void; onToast: (m: string) => void; nft?: { type: string; lane: 'public' | 'private'; name: string }; skip?: Set<string>; onFeeHelp?: () => void }) {
  const [step, setStep] = useState<Step>(nft ? 'to' : 'token')
  const [row, setRow] = useState<Row | null>(nft ? { lane: nft.lane, type: nft.type, v: 1n } : null)
  const [toText, setToText] = useState('')
  const [amountText, setAmountText] = useState('')
  const [fee, setFee] = useState<bigint | null>(null)
  const [feeErr, setFeeErr] = useState('')
  const [phase, setPhase] = useState<SendPhase>('building')
  const [txIds, setTxIds] = useState<string[]>([])
  /** how many transfers the amount takes (1 nearly always; more for a token held as many small coins; 0: cannot be sent) */
  const [parts, setParts] = useState(1)
  const [progress, setProgress] = useState<{ sent: number; left: bigint } | null>(null)
  const [err, setErr] = useState('')
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t) }, [])

  const rows: Row[] = useMemo(() => [
    ...[...snap.balances.unshielded.entries()].map(([type, v]) => ({ lane: 'public' as const, type, v })),
    ...[...snap.balances.shielded.entries()].map(([type, v]) => ({ lane: 'private' as const, type, v })),
  ].filter((r) => r.v > 0n && !skip?.has(r.type)), [snap.balances, skip])

  const meta = nft ? { ticker: nft.name, name: nft.name, decimals: 0 } : row ? lookupToken(row.type) : null
  const to = useMemo(() => parseAddress(toText), [toText])
  const toOk: ParsedAddress | null = 'lane' in to ? to : null
  const laneMismatch = !!(toOk && row && toOk.lane !== row.lane)
  const amount = nft ? 1n : meta ? parseAmount(amountText, meta.decimals) : null
  const tooMuch = !!(row && amount && amount > row.v)
  const usd = (type: string, v: bigint, dec: number) => { const p = priceFor(type); return p == null ? null : Number(v) / 10 ** dec * p }
  const fmtUsd = (n: number | null) => (n == null ? '' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
  const readyIn = snap.readyForTxAt ? Math.max(0, Math.ceil((snap.readyForTxAt - Date.now()) / 1000)) : null
  const canSend = snap.phase === 'ready' && readyIn === 0
  // a wallet with no fee energy cannot send anything: said up front, with the way out, not as a failed estimate
  const noFee = snap.phase === 'ready' && snap.balances.dust === 0n
  const feeCard = (
    <div className="card" style={{ display: 'grid', gap: 11 }}>
      <div style={{ fontWeight: 600, color: 'var(--fg-hi)' }}>You can't send yet</div>
      <div>This wallet has no fee energy, and every transaction needs some.</div>
      {onFeeHelp && <button className="btn ghost" onClick={onFeeHelp}>How to get fee energy</button>}
    </div>
  )

  // fee estimate needs the synced DUST state; before that it would only report "not enough fee energy"
  const synced = snap.phase === 'ready'
  useEffect(() => {
    if (step !== 'review' || !row || !amount || !toOk || !synced) return
    let alive = true
    setFee(null); setFeeErr(''); setParts(1)
    session.planSend(row.type, amount, toOk)
      .then((p) => { if (alive) { setFee(p.fee); setParts(p.parts) } })
      .catch((e) => { if (alive) setFeeErr(sendErrorMessage(e)) })
    return () => { alive = false }
  }, [step, row, amount, toOk, session, synced])

  const go = async () => {
    if (!row || !amount || !toOk) return
    if (!(await confirmUser(nft ? `Send ${nft.name}` : `Send ${fmtUnits(amount, meta?.decimals ?? 6, meta?.decimals ?? 6)} ${meta?.ticker ?? ''}`))) return
    setStep('sending'); setErr(''); setProgress(null)
    try {
      setTxIds(await session.send(row.type, amount, toOk, setPhase, (sent, left) => setProgress({ sent, left })))
      setStep('sent')
    } catch (e) {
      if (e instanceof PartialSend && meta) {
        // part of it is on its way: say how much, and leave the rest ready to send again
        const rest = amount - e.sent
        setErr(`${fmtUnits(e.sent, meta.decimals, meta.decimals)} ${meta.ticker} was sent in ${e.ids.length} ${e.ids.length === 1 ? 'transaction' : 'transactions'}. The other ${fmtUnits(rest, meta.decimals, meta.decimals)} was not: ${sendErrorMessage(e)}`)
        setAmountText(fmtUnits(rest, meta.decimals, meta.decimals).replace(/,/g, ''))
      } else setErr(sendErrorMessage(e))
      setStep('review')
    }
  }

  if (step === 'token') return (
    <div className="screen">
      <Header title="Send" back={onBack} />
      {noFee && feeCard}
      {rows.length === 0 && <div className="card muted">Nothing to send yet. Receive some NIGHT first.</div>}
      {rows.length > 0 && (
        <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
          {rows.map((r) => {
            const m = lookupToken(r.type)
            return (
              <button className="token" key={r.lane + r.type} style={{ width: '100%', textAlign: 'left' }} onClick={() => { setRow(r); setStep('to') }}>
                <div className="logo">{m.ticker.slice(0, 2)}</div>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{m.name} <span className="tiny">· {r.lane}</span></div>
                  <div className="tiny">{fmtUnits(r.v, m.decimals)} {m.ticker}</div>
                </div>
                <div style={{ fontWeight: 600 }}>{fmtUsd(usd(r.type, r.v, m.decimals)) || '—'}</div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )

  if (step === 'scan' && row) return (
    <Scan
      accept={(text) => { const p = parseAddress(addressFromQr(text)); if (!('lane' in p)) return p.error || 'Not a Midnight address'; if (p.lane !== row.lane) return row.lane === 'public' ? 'That is a private address; this token needs a public one' : 'That is a public address; this token needs a private one'; return null }}
      onResult={(text) => { setToText(addressFromQr(text)); setStep('to') }}
      onCancel={() => setStep('to')}
    />
  )

  if (step === 'to' && row && meta) return (
    <div className="screen">
      <Header title={`Send ${meta.ticker}`} back={() => (nft ? onBack() : setStep('token'))} />
      <label style={{ display: 'grid', gap: 7 }}>
        <span className="muted">To</span>
        <textarea rows={3} value={toText} onChange={(e) => setToText(e.target.value)} placeholder={row.lane === 'public' ? 'mn_addr1…' : 'mn_shield-addr1…'} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </label>
      <div className="row">
        <button className="btn ghost" onClick={async () => { try { setToText(await pasteText()) } catch { onToast('Clipboard not available') } }}>Paste</button>
        <button className="btn ghost" onClick={() => setStep('scan')}>Scan</button>
      </div>
      {'error' in to && to.error && <div className="err">{to.error}</div>}
      {toOk && !laneMismatch && <div className="tiny" style={{ color: 'var(--good)' }}>{toOk.lane === 'public' ? 'Public address' : 'Private address'}</div>}
      {laneMismatch && <div className="err">{row.lane === 'public' ? `This ${nft ? 'NFT' : 'token'} is in your public balance; it needs a public address (mn_addr1…).` : `This ${nft ? 'NFT' : 'token'} is in your private balance; it needs a private address (mn_shield-addr1…).`}</div>}
      <div className="grow" />
      <button className="btn" disabled={!toOk || laneMismatch} onClick={() => setStep(nft ? 'review' : 'amount')}>Continue</button>
    </div>
  )

  if (step === 'amount' && row && meta) return (
    <div className="screen">
      <Header title={`Send ${meta.ticker}`} back={() => setStep('to')} />
      <div className="card" style={{ display: 'grid', gap: 9 }}>
        <div className="row">
          <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0" style={{ fontSize: 29, fontWeight: 700, background: 'none', border: 0, padding: 0 }} />
          <button className="muted" style={{ fontWeight: 600 }} onClick={() => setAmountText(fmtUnits(row.v, meta.decimals, meta.decimals).replace(/,/g, ''))}>Max</button>
        </div>
        <div className="tiny">{amount ? fmtUsd(usd(row.type, amount, meta.decimals)) || ' ' : ' '}</div>
        <div className="tiny">Available {fmtUnits(row.v, meta.decimals)} {meta.ticker} · fee is paid in fee energy, not in {meta.ticker}</div>
      </div>
      {tooMuch && <div className="err">That is more than you have.</div>}
      <div className="grow" />
      <button className="btn" disabled={!amount || tooMuch} onClick={() => setStep('review')}>Review</button>
    </div>
  )

  if ((step === 'review' || step === 'sending') && row && meta && amount && toOk) return (
    <div className="screen">
      <Header title="Review" back={() => { if (step === 'review') setStep(nft ? 'to' : 'amount') }} />
      <div className="card" style={{ display: 'grid', gap: 13 }}>
        <div>
          <div className="tiny">{nft ? 'NFT' : 'Amount'}</div>
          <div style={{ fontSize: 23, fontWeight: 700 }}>{nft ? nft.name : `${fmtUnits(amount, meta.decimals, meta.decimals)} ${meta.ticker}`}</div>
          <div className="muted">{fmtUsd(usd(row.type, amount, meta.decimals))}</div>
        </div>
        <div>
          <div className="tiny">To · {toOk.lane}</div>
          <div className="mono" style={{ wordBreak: 'break-all' }}>{toOk.bech32}</div>
        </div>
        <div className="row spread">
          <span className="tiny">Network fee</span>
          <span className="muted">{!synced ? 'after sync' : feeErr ? '—' : fee == null ? 'estimating…' : `${fmtUnits(fee, DUST_DECIMALS, 3)} DUST`}</span>
        </div>
        {feeErr && !noFee && <div className="err">{feeErr}</div>}
        {fee != null && parts > MAX_PARTS && <div className="err">Your {meta.ticker} is held as too many small pieces to send this much at once (about {parts} transactions). Send a smaller amount at a time.</div>}
        {fee != null && parts > 1 && parts <= MAX_PARTS && <div className="tiny">Your {meta.ticker} is held as many small pieces, more than one transaction can carry. It goes out as about {parts} transactions, one after the other, each with its own fee. Keep the app open until it says Sent.</div>}
        {fee != null && parts === 0 && <div className="err">This {meta.ticker} is held in pieces too small to send from here.</div>}
      </div>
      {noFee && feeCard}
      {err && <div className="err">{err}</div>}
      <div className="grow" />
      {step === 'sending'
        ? <div className="card" style={{ textAlign: 'center' }}><div style={{ fontWeight: 600 }}>{PHASE_TEXT[phase]}</div><div className="tiny" style={{ marginTop: 5 }}>{parts > 1 ? `Transaction ${(progress?.sent ?? 0) + 1} of about ${Math.max(parts, (progress?.sent ?? 0) + 1)} · keep the app open` : 'Keep the app open'}</div></div>
        : <>
            {!canSend && <div className="tiny" style={{ textAlign: 'center' }}>{snap.phase !== 'ready' ? 'Finishing sync…' : `Getting ready · ${fmtClock(readyIn ?? 0)}`}</div>}
            <button className="btn" disabled={!canSend || fee == null || parts === 0 || parts > MAX_PARTS} onClick={go}>Send</button>
          </>}
    </div>
  )

  if (step === 'sent' && row && meta && amount) return (
    <div className="screen" style={{ justifyContent: 'center', textAlign: 'center' }}>
      <div style={{ fontSize: 53, color: 'var(--good)' }}>✓</div>
      <h1 className="title">Sent</h1>
      <div className="muted">{nft ? nft.name : `${fmtUnits(amount, meta.decimals, meta.decimals)} ${meta.ticker}`}</div>
      {txIds.length > 1 && <div className="tiny">in {txIds.length} transactions</div>}
      {txIds.map((id, i) => <button key={i} className="tiny mono" onClick={async () => onToast((await copyText(id)) ? 'Transaction id copied' : 'Could not copy')} style={{ wordBreak: 'break-all' }}>{id}</button>)}
      <div className="grow" style={{ maxHeight: 61 }} />
      <button className="btn" onClick={onBack}>Done</button>
    </div>
  )

  return null
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
