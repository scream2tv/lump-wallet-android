import { useEffect, useRef, useState } from 'react'
import { destroyVault, listWallets, unlockWithBiometrics, unlockWithPin, type Unlocked } from '../core/vault'
import { biometry, biometryName, type Biometry } from '../core/device'
import { lockSettings } from '../core/lock'
import { PinAsk } from './PinAsk'
import { Mark } from './Icons'

/**
 * The PIN screen. `resume`: the wallet is still running behind it (it locked itself after a while out of sight);
 * the same PIN or face brings it back as it was.
 */
export function Unlock({ onUnlock, onReset, resume }: { onUnlock: (u: Unlocked) => void; onReset: () => void; resume?: boolean }) {
  const [confirmReset, setConfirmReset] = useState(false)
  const [moved, setMoved] = useState(false)
  const [bio, setBio] = useState<Biometry>('none')
  const asked = useRef(false)
  // the PIN is the one lock of every wallet on this device: a reset takes them all
  const count = listWallets().length

  const useFace = async () => {
    try { const u = await unlockWithBiometrics('Unlock Lump Wallet'); if (u) onUnlock(u) } catch { /* the PIN pad is right there */ }
  }
  // Face ID is offered straight away when it is on; the PIN pad stays underneath
  useEffect(() => {
    if (!lockSettings().bio) return
    let alive = true
    void biometry().then((kind) => {
      if (!alive || kind === 'none') return
      setBio(kind)
      if (!asked.current) { asked.current = true; void useFace() }
    })
    return () => { alive = false }
  }, [])

  if (moved) return (
    <div className="screen" style={{ justifyContent: 'center' }}>
      <div className="mark small"><Mark size={27} /></div>
      <h1 className="title" style={{ textAlign: 'center' }}>Restore needed</h1>
      <div className="card">
        <p style={{ marginTop: 0 }}>This wallet's data came from a backup or another device. The recovery phrase stored in it can only be opened on the device that made it.</p>
        <p style={{ marginBottom: 0 }}>Your funds are untouched. Remove this copy, then restore the wallet with your 24 words.</p>
      </div>
      <button className="btn" style={{ background: 'var(--bad)' }} onClick={async () => { await destroyVault(); onReset() }}>Remove and restore</button>
    </div>
  )

  return (
    <div className="screen" style={{ justifyContent: 'center' }}>
      <div className="mark small"><Mark size={27} /></div>
      <h1 className="title" style={{ textAlign: 'center' }}>Lump Wallet</h1>
      <p className="muted" style={{ textAlign: 'center', margin: 0 }}>{resume ? 'Locked · enter your PIN' : 'Enter your PIN'}</p>
      <PinAsk attempt={unlockWithPin} onOk={onUnlock} onMoved={() => setMoved(true)} />
      <div style={{ textAlign: 'center', display: 'grid', gap: 13, justifyItems: 'center' }}>
        {bio !== 'none' && <button className="muted" style={{ fontWeight: 600 }} onClick={() => void useFace()}>Use {biometryName(bio)}</button>}
        {!confirmReset
          ? <button className="tiny" onClick={() => setConfirmReset(true)}>Forgot PIN</button>
          : <div className="card" style={{ textAlign: 'left' }}>
              <p style={{ marginTop: 0 }}>{count > 1 ? `Resetting removes all ${count} wallets from the device. Each can be restored with its own 24 words.` : 'Resetting removes this wallet from the device. You can restore it with the 24 words.'}</p>
              <div className="row">
                <button className="btn ghost" onClick={() => setConfirmReset(false)}>Keep</button>
                <button className="btn" style={{ background: 'var(--bad)' }} onClick={async () => { await destroyVault(); onReset() }}>{count > 1 ? 'Remove all wallets' : 'Remove wallet'}</button>
              </div>
            </div>}
      </div>
    </div>
  )
}
