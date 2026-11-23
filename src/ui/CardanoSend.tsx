// Send from the wallet's Cardano address: ADA or NIGHT, an amount of it, to another Cardano address. Our Cardano
// service builds the transaction; core/cardanoTx.ts checks it is exactly this send before anything is signed, and
// the review shows what the checked transaction does. "Move NIGHT and ADA out" (Fee energy) sends everything at once.
import { useRef, useState, useEffect } from 'react'
import type { WalletSession } from '../core/wallet'
import { fmtAda, fmtNight, prepareSend, signAndSend, type Prepared } from '../core/energy'
import { cardanoAddressHex } from '../core/cardanoTx'
import type { PriceFor } from '../core/prices'
import { confirmUser } from './Confirm'
import { Header } from './Header'
import type { Energy } from './Cardano'

/** "12.5" -> 12500000n (ADA and NIGHT both have 6 decimals). A dot for decimals and nothing else: a comma is never guessed at. */
function parse(text: string): bigint | null {
  const m = text.trim().match(/^(\d{1,12})(?:\.(\d{0,6}))?$/)
  if (!m) return null
  const v = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0')
  return v > 0n ? v : null
}
const plain = (v: bigint) => { const s = (Number(v) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); return s || '0' }
const usd = (v: bigint, p: number | null) => (p == null ? '' : ` · $${(Number(v) / 1e6 * p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

type Step = { name: 'form' } | { name: 'review'; p: Prepared; to: string }

export function CardanoSend({ session, energy, priceFor, onBack, onToast }: { session: WalletSession; energy: Energy; priceFor: PriceFor; onBack: () => void; onToast: (m: string) => void }) {
  const { st, down } = energy
  const [asset, setAsset] = useState<'ada' | 'night'>('ada')
  const [amountText, setAmountText] = useState('')
  /** Max on ADA: everything that is free goes, the fee comes out of it */
  const [all, setAll] = useState(false)
  const [to, setTo] = useState('')
  const [step, setStep] = useState<Step>({ name: 'form' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const have = asset === 'ada' ? st?.adaFree ?? 0n : st?.night ?? 0n
  const unit = asset === 'ada' ? 'ADA' : 'NIGHT'
  const price = priceFor.key(unit)
  const amount = parse(amountText)
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn() } catch (e) { if (alive.current) setErr(e instanceof Error ? e.message : 'Something went wrong') } finally { if (alive.current) setBusy(false) } }
  const pick = (a: 'ada' | 'night') => { setAsset(a); setAmountText(''); setAll(false); setErr('') }
  const max = () => { setAmountText(plain(have)); setAll(asset === 'ada'); setErr('') }
  const review = () => run(async () => {
    cardanoAddressHex(to)
    if (!all && amount == null) throw new Error(/,/.test(amountText) ? 'Use a dot for decimals, like 1.5' : 'Enter an amount')
    if (!all && amount! > have) throw new Error(asset === 'ada' ? 'That is more ADA than is free to send' : 'That is more NIGHT than is on the address')
    const p = await prepareSend(session, to, asset === 'night' ? { lovelace: 0n, night: amount! } : { lovelace: all ? 'all' : amount!, night: 0n })
    setStep({ name: 'review', p, to: to.trim() })
  })
  const send = (p: Prepared) => run(async () => {
    if (!(await confirmUser('Send from your Cardano address'))) return
    await signAndSend(session, p)
    onToast('Sent on Cardano')
    setTimeout(() => void energy.refresh(), 4_000)
    onBack()
  })

  if (step.name === 'review') {
    const c = step.p.checked
    return (
      <div className="screen">
        <Header title="Review" back={() => { setStep({ name: 'form' }); setErr('') }} />
        <div className="card" style={{ display: 'grid', gap: 11 }} data-cardano-review>
          <div style={{ fontWeight: 600, color: 'var(--fg-hi)' }}>You send</div>
          {c.toOther.night > 0n
            ? <>
                <div className="row spread"><span className="muted">NIGHT</span><span className="mono">{fmtNight(c.toOther.night)}{usd(c.toOther.night, priceFor.key('NIGHT'))}</span></div>
                <div className="row spread"><span className="muted">ADA that travels with it</span><span className="mono">{fmtAda(c.toOther.lovelace)}{usd(c.toOther.lovelace, priceFor.key('ADA'))}</span></div>
              </>
            : <div className="row spread"><span className="muted">ADA</span><span className="mono">{fmtAda(c.toOther.lovelace, 6)}{usd(c.toOther.lovelace, priceFor.key('ADA'))}</span></div>}
          <div className="row spread"><span className="muted">Network fee</span><span className="mono">{fmtAda(c.fee, 6)} ADA</span></div>
          <div className="tiny">To</div>
          <div className="mono tiny" style={{ wordBreak: 'break-all', color: 'var(--fg-2)' }}>{step.to}</div>
          {c.toOther.night > 0n && <div className="tiny">NIGHT that leaves stops earning fee energy for this wallet.</div>}
        </div>
        {err && <div className="err">{err}</div>}
        <div className="grow" />
        <button className="btn" disabled={busy} onClick={() => send(step.p)}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    )
  }

  return (
    <div className="screen">
      <Header title="Send on Cardano" back={onBack} />
      <div className="seg">
        <button className={asset === 'ada' ? 'on' : ''} onClick={() => pick('ada')}>ADA</button>
        <button className={asset === 'night' ? 'on' : ''} onClick={() => pick('night')}>NIGHT</button>
      </div>

      <div className="card" style={{ display: 'grid', gap: 11 }}>
        <div className="row spread">
          <input inputMode="decimal" value={amountText} onChange={(e) => { setAmountText(e.target.value); setAll(false) }} placeholder="0" aria-label="Amount" style={{ fontSize: 29, fontWeight: 700, background: 'none', border: 0, padding: 0, minWidth: 0 }} />
          <button className="muted" style={{ fontWeight: 600 }} disabled={have === 0n} onClick={max}>Max</button>
        </div>
        <div className="tiny" data-have>
          {!st ? (down ? 'The Cardano service is not answering right now. Trying again by itself.' : 'Checking your Cardano address…')
            : asset === 'ada' ? `Free to send: ${fmtAda(st.adaFree)} ADA${usd(st.adaFree, priceFor.key('ADA'))}${st.lovelace > st.adaFree ? ` · ${fmtAda(st.lovelace - st.adaFree)} more travels with your NIGHT` : ''}`
            : `On the address: ${fmtNight(st.night)} NIGHT${usd(st.night, priceFor.key('NIGHT'))}`}
        </div>
        {amount != null && price != null && <div className="tiny">{`About $${(Number(amount) / 1e6 * price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}{all ? ' · everything free, the fee comes out of it' : ''}</div>}
      </div>

      <label style={{ display: 'grid', gap: 5 }}>
        <span className="tiny">To · a Cardano address (addr1…)</span>
        <textarea className="mono" rows={3} value={to} onChange={(e) => setTo(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </label>
      <div className="tiny">{asset === 'night' ? 'About 1.2 ADA travels with NIGHT: Cardano does not move a token without some.' : 'ADA goes out of the coins that hold only ADA, so your NIGHT keeps earning.'}</div>

      {err && <div className="err">{err}</div>}
      <div className="grow" />
      <button className="btn" disabled={busy || !to.trim() || !amountText.trim()} onClick={review}>{busy ? 'Preparing…' : 'Review'}</button>
    </div>
  )
}
