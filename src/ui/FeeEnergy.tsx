// Fee energy: what it is, where this wallet stands, and how it gets it. Fee energy (DUST) is earned by NIGHT held on
// Cardano at an address registered to this wallet. The wallet has such an address of its own (same recovery phrase,
// core/cardano.ts): send NIGHT and a little ADA to it, register once, and it fills by itself. Everything on that
// address can be moved out again from here.
import { useEffect, useRef, useState } from 'react'
import type { Snapshot, WalletSession } from '../core/wallet'
import { fmtUnits, DUST_DECIMALS } from '../core/wallet'
import { fmtAda, fmtNight, prepareMoveOut, prepareRegistration, signAndSend, type Prepared } from '../core/energy'
import { cardanoAddressHex } from '../core/cardanoTx'
import { confirmUser } from './Confirm'
import { Header } from './Header'
import { copyText } from './copy'
import { CardanoPanel, type Energy } from './Cardano'

type Step = { name: 'main' } | { name: 'register'; p: Prepared } | { name: 'moveout' } | { name: 'moveout-review'; p: Prepared; to: string }

/** `start`: opened from a button on Home's Cardano tab, so that button's step comes up at once. */
export function FeeEnergy({ session, snap, energy, start, onSend, onBack, onToast }: { session: WalletSession; snap: Snapshot; energy: Energy; start?: 'register' | 'moveout'; onSend: () => void; onBack: () => void; onToast: (m: string) => void }) {
  const { dust, dustCap } = snap.balances
  const pct = dustCap > 0n ? Number(dust * 1000n / dustCap) / 10 : 0
  const synced = snap.phase === 'ready'
  const address = session.cardano?.address ?? ''
  const { st } = energy
  const [step, setStep] = useState<Step>(start === 'moveout' ? { name: 'moveout' } : { name: 'main' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [to, setTo] = useState('')
  const dustAddress = snap.dustAddress
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const copy = async () => onToast((await copyText(address)) ? 'Cardano address copied' : 'Could not copy')
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn() } catch (e) { if (alive.current) setErr(e instanceof Error ? e.message : 'Something went wrong') } finally { if (alive.current) setBusy(false) } }
  const startRegister = () => run(async () => { const p = await prepareRegistration(session, dustAddress); setStep({ name: 'register', p }) })
  useEffect(() => { if (start === 'register') void startRegister() }, [])
  const send = (p: Prepared, why: string, done: string) => run(async () => {
    if (!(await confirmUser(why))) return
    await signAndSend(session, p)
    onToast(done); setStep({ name: 'main' }); setTo('')
    setTimeout(() => void energy.refresh(), 4_000)
  })
  const reviewMoveOut = () => run(async () => { cardanoAddressHex(to); const p = await prepareMoveOut(session, to); setStep({ name: 'moveout-review', p, to: to.trim() }) })

  if (step.name === 'register') return (
    <div className="screen">
      <Header title="Register" back={() => { setStep({ name: 'main' }); setErr('') }} />
      <div className="card" style={{ display: 'grid', gap: 11 }}>
        <div style={{ fontWeight: 600, color: 'var(--fg-hi)' }}>One Cardano transaction</div>
        <div>It ties your Cardano address to this wallet's fee energy. Your NIGHT stays on your address.</div>
        <div className="row spread"><span className="muted">Deposit, returned if you ever unregister</span><span className="mono">{fmtAda(step.p.checked.locked)} ADA</span></div>
        <div className="row spread"><span className="muted">Network fee</span><span className="mono">{fmtAda(step.p.checked.fee)} ADA</span></div>
        <div className="row spread"><span className="muted">Stays on your address</span><span className="mono">{fmtAda(step.p.checked.toSelf.lovelace)} ADA{step.p.checked.toSelf.night > 0n ? ` · ${fmtNight(step.p.checked.toSelf.night)} NIGHT` : ''}</span></div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="grow" />
      <button className="btn" disabled={busy} onClick={() => send(step.p, 'Register for fee energy', 'Registered on Cardano')}>{busy ? 'Sending…' : 'Register'}</button>
    </div>
  )
  if (step.name === 'moveout' || step.name === 'moveout-review') return (
    <div className="screen">
      <Header title="Move out" back={() => { setStep(step.name === 'moveout-review' ? { name: 'moveout' } : { name: 'main' }); setErr('') }} />
      {step.name === 'moveout' ? (
        <>
          <div className="card" style={{ display: 'grid', gap: 11 }}>
            <div>Everything on your Cardano address goes to the address you enter: {st ? `${fmtNight(st.night)} NIGHT and ${fmtAda(st.lovelace)} ADA` : 'NIGHT and ADA'}{st && st.otherTokens > 0 ? ', and the other tokens on it' : ''}.</div>
            <div className="tiny">NIGHT that leaves stops earning fee energy for this wallet.</div>
            <label style={{ display: 'grid', gap: 5 }}>
              <span className="tiny">Cardano address (addr1…)</span>
              <textarea className="mono" rows={3} value={to} onChange={(e) => setTo(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </label>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="grow" />
          <button className="btn" disabled={busy || !to.trim()} onClick={reviewMoveOut}>{busy ? 'Preparing…' : 'Review'}</button>
        </>
      ) : (
        <>
          <div className="card" style={{ display: 'grid', gap: 11 }}>
            <div style={{ fontWeight: 600, color: 'var(--fg-hi)' }}>You send</div>
            <div className="row spread"><span className="muted">NIGHT</span><span className="mono">{fmtNight(step.p.checked.toOther.night)}</span></div>
            <div className="row spread"><span className="muted">ADA</span><span className="mono">{fmtAda(step.p.checked.toOther.lovelace, 6)}</span></div>
            <div className="row spread"><span className="muted">Network fee</span><span className="mono">{fmtAda(step.p.checked.fee, 6)} ADA</span></div>
            <div className="tiny">To</div>
            <div className="mono tiny" style={{ wordBreak: 'break-all', color: 'var(--fg-2)' }}>{step.to}</div>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="grow" />
          <button className="btn" disabled={busy} onClick={() => send(step.p, 'Move NIGHT and ADA out', 'Sent on Cardano')}>{busy ? 'Sending…' : 'Send'}</button>
        </>
      )}
    </div>
  )

  return (
    <div className="screen">
      <Header title="Fee energy" back={onBack} />

      <div className="card" style={{ display: 'grid', gap: 9 }}>
        <div style={{ fontSize: 29, fontWeight: 700, color: 'var(--fg-hi)' }}>{fmtUnits(dust, DUST_DECIMALS, 2)} <span className="muted" style={{ fontSize: 15, fontWeight: 600 }}>DUST</span></div>
        <div className="bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
        <div className="tiny">
          {snap.dustSearch && !snap.dustSearch.all ? 'Your NIGHT on Cardano has been earning. This device is reading it in: keep the app open.'
            : !synced ? 'Still syncing: the number may not be final yet.'
            : snap.dustMissing ? 'Your NIGHT on Cardano is earning, but this device has not found it. Settings, Scan again.'
            : dustCap === 0n ? 'This wallet is not earning fee energy yet.'
            : `${pct.toFixed(1)}% of ${fmtUnits(dustCap, DUST_DECIMALS, 1)} · refills by itself`}
        </div>
      </div>

      <div className="card" style={{ display: 'grid', gap: 9 }}>
        <div style={{ fontWeight: 600, color: 'var(--fg-hi)' }}>What it is</div>
        <div>Every transaction costs a little fee energy (DUST), about half a DUST each. It cannot be bought or sent. NIGHT you hold on Cardano earns it: 5 DUST for every NIGHT, full after about a week.</div>
      </div>

      <CardanoPanel address={address} energy={energy} busy={busy} err={err} onCopy={copy} onRegister={startRegister} onSend={onSend} onMoveOut={() => { setErr(''); setStep({ name: 'moveout' }) }} />

      <div className="tiny">Until it fills this wallet can receive, and can use sites that pay the fee for you.</div>
    </div>
  )
}
