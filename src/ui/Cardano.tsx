// The wallet's Cardano side on one card: the steps to fee energy and where each one stands, the address, what is on
// it, and the two things that can be done with it (register, move out). Shown on Home's Cardano tab and on the Fee
// energy screen. Both buttons are always there: one that cannot be used yet says why underneath.
import { useCallback, useEffect, useRef, useState } from 'react'
import { energyState, fmtAda, fmtNight, heldOnCardano, MIDNIGHT_SEES_AFTER_MS, noteHeldOnCardano, registeredAt, type EnergyState, type HeldOnCardano } from '../core/energy'

const POLL_MS = 23_000
/** off the Cardano screens the address is still looked at, for the total on Home: this seldom */
const SLOW_POLL_MS = 113_000
/**
 * After a registration went out from this device, Register stays off this long while Cardano still shows none: a
 * second registration for the same address would leave it earning nothing.
 */
const SENT_HOLD_MS = 31 * 60_000

/**
 * What our Cardano service says about the address: `st` null until it answered once, `down` why it did not.
 * `held`: the NIGHT and ADA on the address as last known, also from an earlier session (null: never seen).
 */
export type Energy = { st: EnergyState | null; down: string; held: HeldOnCardano | null; refresh: () => Promise<void> }

/**
 * Asks every 23 s while `on` (the Cardano tab or the Fee energy screen is showing) and every two minutes
 * otherwise, and keeps the last answer. What the address held is remembered per wallet.
 */
export function useEnergy(address: string, dustAddress: string, on: boolean, walletId: string): Energy {
  const [st, setSt] = useState<EnergyState | null>(null)
  const [down, setDown] = useState('')
  const [held, setHeld] = useState<HeldOnCardano | null>(() => heldOnCardano(walletId))
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback(async () => {
    if (!address || !dustAddress) return
    try {
      const s = await energyState(address, dustAddress)
      noteHeldOnCardano(walletId, s)
      if (alive.current) { setSt(s); setHeld({ night: s.night, lovelace: s.lovelace }); setDown('') }
    }
    catch (e) { if (alive.current) setDown(e instanceof Error ? e.message : 'Could not check right now') }
  }, [address, dustAddress, walletId])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, on ? POLL_MS : SLOW_POLL_MS)
    return () => clearInterval(t)
  }, [on, refresh])
  return { st, down, held, refresh }
}

function Step({ n, what, hint, state, done }: { n: number; what: string; hint: string; state: string; done: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '17px 1fr auto', columnGap: 9, rowGap: 3, alignItems: 'baseline' }} data-step={n} data-done={done ? '1' : '0'}>
      <span className="mono" style={{ color: 'var(--sky)' }}>{n}</span>
      <span style={{ color: 'var(--fg-hi)' }}>{what}</span>
      <span className="mono" style={{ color: done ? 'var(--good)' : 'var(--fg-2)' }}>{state}</span>
      <span />
      <span className="tiny" style={{ gridColumn: '2 / 4' }}>{hint}</span>
    </div>
  )
}

export function CardanoPanel({ address, energy, busy = false, err = '', onCopy, onRegister, onSend, onMoveOut }: {
  address: string; energy: Energy; busy?: boolean; err?: string
  onCopy: () => void; onRegister: () => void; onSend: () => void; onMoveOut: () => void
}) {
  const { st, down } = energy
  const now = Date.now()
  const sentAt = address ? registeredAt(address) : null
  const seesIn = sentAt ? Math.max(0, sentAt + MIDNIGHT_SEES_AFTER_MS - now) : 0
  const hours = Math.ceil(seesIn / 3_600_000)
  const enoughAda = !!st && st.lovelace >= st.needsLovelace
  // sent from here a little while ago and Cardano does not show it yet
  const sent = !!st && st.mapped === 'none' && !!sentAt && now - sentAt >= 0 && now - sentAt < SENT_HOLD_MS
  const canRegister = !!st && st.mapped === 'none' && enoughAda && !sent
  const why = !st ? (down ? `${down}. Trying again by itself.` : 'Checking your Cardano address…')
    : st.mapped !== 'none' ? ''
    : sent ? 'Sent. Cardano confirms it in a few minutes.'
    : !enoughAda ? `Waiting for ADA: ${fmtAda(st.lovelace)} of about ${fmtAda(st.needsLovelace, 1)} needed.`
    : st.night === 0n ? 'No NIGHT yet. You can register now; NIGHT you send later earns by itself.'
    : ''
  const title = st?.mapped === 'here' ? 'Registered' : st?.mapped === 'elsewhere' ? 'Registered to another wallet' : st?.mapped === 'double' ? 'Registered twice' : 'Get fee energy'

  return (
    <div className="card" style={{ display: 'grid', gap: 13 }} data-energy={st?.mapped ?? (down ? 'down' : 'loading')}>
      <div style={{ fontWeight: 600, color: 'var(--fg-hi)' }}>{title}</div>
      {st?.mapped === 'here' && (
        <div>
          {st.midnight?.registered
            ? (st.midnight.night > 0n ? `${fmtNight(st.midnight.night)} NIGHT is earning fee energy for this wallet.` : 'Send NIGHT to your Cardano address and it starts earning, about half a day after it arrives.')
            : sentAt && seesIn > 0 ? `Done on Cardano. Midnight picks it up in about ${hours} h.` : 'Done on Cardano. Midnight picks it up about half a day after registering.'}
          {st.midnight?.registered && st.midnight.night > 0n && st.night > st.midnight.night && (
            <div className="tiny" style={{ marginTop: 5 }} data-not-yet>{fmtNight(st.night - st.midnight.night)} NIGHT more is on the address. NIGHT starts earning about half a day after it arrives.</div>
          )}
        </div>
      )}
      {st?.mapped === 'elsewhere' && <div>This Cardano address already earns fee energy for a different Midnight wallet. An address can only be registered once.</div>}
      {st?.mapped === 'double' && <div>This Cardano address is registered more than once, so it earns nothing. One registration has to be removed with the wallet that made it.</div>}
      {(!st || st.mapped === 'none') && (
        <div style={{ display: 'grid', gap: 11 }}>
          <Step n={1} what="Send 5 ADA to your Cardano address" hint="From an exchange or any Cardano wallet. On its own, not together with NIGHT."
            state={st ? (enoughAda ? 'Done' : `${fmtAda(st.lovelace)} of ${fmtAda(st.needsLovelace, 1)}`) : '…'} done={enoughAda} />
          <Step n={2} what="Send NIGHT to the same address" hint="It stays yours and can be moved out again. Each NIGHT earns 5 DUST."
            state={st ? `${fmtNight(st.night)} NIGHT` : '…'} done={!!st && st.night > 0n} />
          <Step n={3} what="Register" hint="One tap, once. It starts to fill about half a day later."
            state={sent ? 'Sent' : 'Not yet'} done={false} />
        </div>
      )}

      <div style={{ display: 'grid', gap: 7 }}>
        <div className="tiny">Your Cardano address · same recovery phrase</div>
        <button className="mono tiny" onClick={onCopy} style={{ wordBreak: 'break-all', textAlign: 'left', color: 'var(--fg-2)', userSelect: 'text' }}>{address || 'deriving…'}</button>
      </div>
      <button className="btn ghost" disabled={!address} onClick={onCopy}>Copy address</button>
      <div className="row spread" {...(st ? { 'data-onaddress': '' } : {})}>
        <span className="muted">On it now</span>
        <span className="mono">{st ? `${fmtNight(st.night)} NIGHT · ${fmtAda(st.lovelace)} ADA` : down ? 'not answering' : 'checking…'}</span>
      </div>

      <button className="btn" disabled={busy || !canRegister} onClick={onRegister}>{st?.mapped === 'here' ? 'Registered' : busy ? 'Preparing…' : 'Register'}</button>
      {why && <div className="tiny" data-why>{why}</div>}
      {err && <div className="err">{err}</div>}
      <button className="btn ghost" disabled={busy || !st || st.coins === 0} onClick={onSend}>Send ADA or NIGHT</button>
      <button className="btn ghost" disabled={busy || !st || st.coins === 0} onClick={onMoveOut}>Move NIGHT and ADA out</button>
      {st && st.coins === 0 && <div className="tiny">Nothing on your Cardano address to send or move.</div>}
    </div>
  )
}
