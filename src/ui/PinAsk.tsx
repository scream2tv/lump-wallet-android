// One PIN prompt for every place that asks for it (unlock, the lock screen, a send, the recovery phrase, Face ID
// set-up): the pad, the wait after wrong PINs, and what to say when the phrase cannot be opened on this device.
import { useEffect, useState } from 'react'
import { pinWaitMs, waitText } from '../core/attempts'
import { VaultMoved, type PinResult, type Unlocked } from '../core/vault'
import { PinPad } from './PinPad'

export function PinAsk({ attempt, onOk, onMoved }: { attempt: (pin: string) => Promise<PinResult>; onOk: (u: Unlocked) => void; onMoved?: () => void }) {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [wait, setWait] = useState(pinWaitMs)
  // the wait counts down by itself, and survives closing the app
  useEffect(() => {
    if (wait <= 0) return
    const t = setInterval(() => setWait(pinWaitMs()), 500)
    return () => clearInterval(t)
  }, [wait > 0])

  const tryPin = async (pin: string) => {
    setBusy(true); setErr('')
    let r: PinResult
    try { r = await attempt(pin) } catch (e) {
      setBusy(false)
      if (e instanceof VaultMoved && onMoved) { onMoved(); return false }
      setErr(e instanceof VaultMoved ? 'This wallet cannot be opened on this device.' : 'Could not read this device\'s secure storage. Try again.')
      return false
    }
    setBusy(false)
    if ('ok' in r) { onOk(r.ok); return true }
    setWait(r.waitMs)
    setErr('wrong' in r ? 'Wrong PIN' : '')
    return false
  }

  return (
    <>
      <PinPad onComplete={tryPin} disabled={busy || wait > 0} />
      {wait > 0
        ? <div className="err" style={{ textAlign: 'center' }}>{err ? `${err} · ` : ''}Try again in {waitText(wait)}</div>
        : err && <div className="err" style={{ textAlign: 'center' }}>{err}</div>}
    </>
  )
}
