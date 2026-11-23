// "Is it you?" before funds move: a send, or a transaction a site asked for. Face ID / Touch ID when it is on, else
// the PIN. An unlocked phone left on a table, or handed to someone to look at a picture, cannot send by itself.
// Off in Settings → Security for those who do not want it.
import { useEffect, useState } from 'react'
import { lockSettings } from '../core/lock'
import { unlockWithBiometrics, unlockWithPin } from '../core/vault'
import { coverBrowser } from '../dapp/bridge'
import { PinAsk } from './PinAsk'

type Pending = { reason: string; done: (ok: boolean) => void }
let show: ((p: Pending) => void) | null = null

/** Resolves true when the person confirmed (or the check is switched off and not `always`), false when they cancelled. */
export async function confirmUser(reason: string, opts: { always?: boolean } = {}): Promise<boolean> {
  const s = lockSettings()
  // `always`: not a matter of the switch (a change that would weaken the wallet's own guard, for one)
  if (!s.confirm && !opts.always) return true
  if (s.bio) {
    try { if (await unlockWithBiometrics(reason)) return true } catch { /* the PIN it is */ }
  }
  // no screen to ask on: nothing goes out
  if (!show) return false
  return new Promise<boolean>((done) => show!({ reason, done }))
}

/** Mounted once (App): the PIN prompt confirmUser() falls back to. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null)
  useEffect(() => { show = setPending; return () => { show = null } }, [])
  // the site's page is a native view above this one: out of the way while the pad is up
  useEffect(() => { coverBrowser('confirm', !!pending); return () => coverBrowser('confirm', false) }, [pending])
  if (!pending) return null
  const end = (ok: boolean) => { pending.done(ok); setPending(null) }
  return (
    <div className="cover" role="dialog" aria-modal="true" aria-label="Confirm with your PIN">
      <div className="screen" style={{ justifyContent: 'center' }}>
        <h1 className="title" style={{ textAlign: 'center' }}>Confirm</h1>
        <p className="muted" style={{ textAlign: 'center', margin: 0 }}>{pending.reason} · enter your PIN</p>
        <PinAsk attempt={unlockWithPin} onOk={() => end(true)} />
        <button className="btn ghost" onClick={() => end(false)}>Cancel</button>
      </div>
    </div>
  )
}
