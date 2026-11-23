import { useRef, useState } from 'react'

const LEN = 6

/** Six-digit PIN pad. onComplete returns false to shake/clear (wrong PIN or mismatch). */
export function PinPad({ onComplete, disabled }: { onComplete: (pin: string) => Promise<boolean> | boolean; disabled?: boolean }) {
  const [pin, setPin] = useState('')
  // The digits as of the last tap. The state above is what is drawn, and it can be a tap behind when two taps come
  // before the screen has redrawn (a busy phone, fast fingers): building on it would lose a digit.
  const typed = useRef('')
  const show = (v: string) => { typed.current = v; setPin(v) }
  const press = async (d: string) => {
    if (disabled || typed.current.length >= LEN) return
    const next = typed.current + d
    show(next)
    if (next.length === LEN) {
      const ok = await onComplete(next)
      if (!ok) show('')
    }
  }
  return (
    <div style={{ display: 'grid', gap: 31, width: '100%' }}>
      <div className="dots">{Array.from({ length: LEN }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}</div>
      <div className="pin">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => press(d)}>{d}</button>)}
        <span />
        <button onClick={() => press('0')}>0</button>
        <button onClick={() => show(typed.current.slice(0, -1))} className="pin-del" aria-label="Delete">
          <svg width="27" height="21" viewBox="0 0 27 21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M8.5 1.5h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-16L1.5 10.5z" /><path d="M12.5 6.5l8 8m0-8l-8 8" strokeLinecap="round" /></svg>
        </button>
      </div>
    </div>
  )
}
