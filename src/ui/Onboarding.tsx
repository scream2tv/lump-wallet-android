import { useMemo, useState } from 'react'
import { newMnemonic, isValidMnemonic, normalize } from '../core/keys'
import { addWallet, createVault, WalletExists, type SessionKeys, type Unlocked } from '../core/vault'
import { saveBirthday, clearBirthday, todayUtc } from '../core/bootstrap'
import type { StartOptions } from '../core/wallet'
import { PinPad } from './PinPad'
import { Mark } from './Icons'

type Step = 'welcome' | 'import' | 'birthday' | 'reveal' | 'quiz' | 'pin' | 'pin2'

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

/**
 * A wallet's first steps: a new phrase (shown, then checked) or one brought along (with roughly when it was made).
 * The first wallet of a device then sets the PIN. `add`: a further wallet for an unlocked device; it goes under the
 * same PIN, so there is no PIN step, and Back on the first screen leaves without adding anything.
 */
export function Onboarding({ onDone, add }: { onDone: (u: Unlocked, opts?: StartOptions) => void; add?: { keys: SessionKeys; onCancel: () => void } }) {
  const [step, setStep] = useState<Step>('welcome')
  const [mnemonic, setMnemonic] = useState('')
  const [pasted, setPasted] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [pin1, setPin1] = useState('')
  const [err, setErr] = useState('')
  const [isNew, setIsNew] = useState(false)
  const [busy, setBusy] = useState(false)

  const words = useMemo(() => mnemonic.split(' '), [mnemonic])
  const quiz = useMemo(() => [2, 10, 19].map((i) => ({ i, want: words[i] })), [words])
  const [answers, setAnswers] = useState(['', '', ''])

  // the creation date lets the wallet start from a server snapshot taken before it instead of from genesis; it is
  // kept under the wallet once that wallet exists
  const keepBirthday = (walletId: string, day: string | null) => { if (day) saveBirthday(day, walletId); else clearBirthday(walletId) }
  /** a further wallet: stored under the PIN the device has; `back` is the step an error is shown on */
  const finishAdd = async (day: string | null, fresh: boolean, back: Step) => {
    if (!add || busy) return
    setBusy(true); setErr('')
    try {
      const u = await addWallet(add.keys, mnemonic)
      keepBirthday(u.walletId, day)
      onDone(u, { fresh })
    } catch (e) {
      setErr(e instanceof WalletExists ? 'That wallet is on this device already' : e instanceof Error ? e.message : 'The wallet could not be added')
      setStep(back)
    } finally { setBusy(false) }
  }
  const [day, setDay] = useState<string | null>(null)

  const create = () => { setMnemonic(newMnemonic()); setIsNew(true); setDay(todayUtc()); setAnswers(['', '', '']); setRevealed(false); setErr(''); setStep('reveal') }
  const importIt = () => {
    const m = normalize(pasted)
    if (!isValidMnemonic(m)) { setErr('That is not a valid 24-word phrase'); return }
    setErr(''); setMnemonic(m); setIsNew(false); setStep('birthday')
  }
  const birthday = (d: string | null) => { setDay(d); if (add) void finishAdd(d, false, 'import'); else setStep('pin') }
  const quizDone = () => { if (add) void finishAdd(day, true, 'quiz'); else setStep('pin') }
  const finish = async (pin: string) => {
    const u = await createVault(mnemonic, pin)
    keepBirthday(u.walletId, day)
    onDone(u, { fresh: isNew })
  }

  if (step === 'welcome') return (
    <div className="screen" style={{ justifyContent: 'flex-end' }}>
      {add && <button className="muted" data-back style={{ textAlign: 'left' }} onClick={add.onCancel}>‹ Back</button>}
      <div className="grow" style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="mark"><Mark size={61} /></div>
          <h1 className="title" style={{ marginTop: 23 }}>{add ? 'Add a wallet' : 'Lump Wallet'}</h1>
          <p className="muted">{add ? 'Its own 24 words, the same PIN.' : 'Your keys. Your night.'}</p>
        </div>
      </div>
      <button className="btn" onClick={create}>Create new wallet</button>
      <button className="btn ghost" onClick={() => { setErr(''); setStep('import') }}>I already have a wallet</button>
    </div>
  )

  if (step === 'import') return (
    <div className="screen">
      <button className="muted" data-back style={{ textAlign: 'left' }} onClick={() => setStep('welcome')}>‹ Back</button>
      <h1 className="title">Enter your 24 words</h1>
      <textarea rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="word word word …" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} />
      {err && <div className="err">{err}</div>}
      <div className="grow" />
      <button className="btn" disabled={pasted.trim().split(/\s+/).length < 24} onClick={importIt}>Continue</button>
    </div>
  )

  if (step === 'birthday') return (
    <div className="screen">
      <button className="muted" data-back style={{ textAlign: 'left' }} onClick={() => setStep('import')}>‹ Back</button>
      <h1 className="title">When were these 24 words first made?</h1>
      <p className="muted" style={{ margin: 0 }}>In any app, not today's import. Roughly is fine: the wallet only scans the chain from that point, which makes the first sync much faster. Pick an earlier date if unsure.</p>
      <div className="card" style={{ display: 'grid', gap: 9 }}>
        <button className="btn ghost" disabled={busy} onClick={() => birthday(daysAgo(1))}>Today or yesterday</button>
        <button className="btn ghost" disabled={busy} onClick={() => birthday(daysAgo(7))}>Within the last week</button>
        <button className="btn ghost" disabled={busy} onClick={() => birthday(daysAgo(31))}>Within the last month</button>
        <button className="btn ghost" disabled={busy} onClick={() => birthday(null)}>Earlier, or not sure</button>
      </div>
      <div className="tiny">Choosing a date after the wallet's first transaction would hide funds received before it. "Not sure" scans everything.</div>
    </div>
  )

  if (step === 'reveal') return (
    <div className="screen">
      {add && <button className="muted" data-back style={{ textAlign: 'left' }} onClick={() => setStep('welcome')}>‹ Back</button>}
      <h1 className="title">Your recovery phrase</h1>
      <p className="muted" style={{ margin: 0 }}>These 24 words are the only way to restore {add ? 'this' : 'your'} wallet. Write them down, keep them offline.</p>
      <button onClick={() => setRevealed(true)} className={'words' + (revealed ? '' : ' blur')} style={{ textAlign: 'left' }}>
        {words.map((w, i) => <span className="word" key={i}><b>{i + 1}</b>{w}</span>)}
      </button>
      {!revealed && <div className="tiny" style={{ textAlign: 'center', marginTop: -11 }}>Tap to reveal</div>}
      <div className="grow" />
      <button className="btn" disabled={!revealed} onClick={() => setStep('quiz')}>I wrote them down</button>
    </div>
  )

  if (step === 'quiz') return (
    <div className="screen">
      <h1 className="title">Quick check</h1>
      {quiz.map((q, k) => (
        <label key={q.i} style={{ display: 'grid', gap: 7 }}>
          <span className="muted">Word #{q.i + 1}</span>
          <input value={answers[k]} onChange={(e) => setAnswers(answers.map((a, j) => (j === k ? e.target.value.trim().toLowerCase() : a)))} autoCapitalize="none" autoCorrect="off" autoComplete="off" />
        </label>
      ))}
      {err && <div className="err">{err}</div>}
      <div className="grow" />
      <button className="btn" disabled={busy || !quiz.every((q, k) => answers[k] === q.want)} onClick={quizDone}>{busy ? 'Adding…' : 'Continue'}</button>
      <button className="tiny" onClick={() => setStep('reveal')}>Show the words again</button>
    </div>
  )

  if (step === 'pin') return (
    <div className="screen" style={{ justifyContent: 'center' }}>
      <h1 className="title" style={{ textAlign: 'center' }}>Set a PIN</h1>
      <p className="muted" style={{ textAlign: 'center', margin: 0 }}>Unlocks the wallet on this device</p>
      <PinPad onComplete={(p) => { setPin1(p); setStep('pin2'); return true }} />
    </div>
  )

  return (
    <div className="screen" style={{ justifyContent: 'center' }}>
      <h1 className="title" style={{ textAlign: 'center' }}>Repeat the PIN</h1>
      <PinPad onComplete={async (p) => { if (p !== pin1) { setErr('PINs do not match'); return false } setErr(''); await finish(p); return true }} />
      {err && <div className="err" style={{ textAlign: 'center' }}>{err}</div>}
      <button className="tiny" onClick={() => { setErr(''); setStep('pin') }}>Start over</button>
    </div>
  )
}
