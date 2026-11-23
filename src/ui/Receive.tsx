import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { Snapshot } from '../core/wallet'
import { copyText } from './copy'
import { Shell, isAndroidApp } from './back'
import { Header } from './Header'

/**
 * One Receive screen; the switch swaps the QR + address between the public, the shielded and the wallet's Cardano
 * address (`cardano`, same recovery phrase: ADA and NIGHT on Cardano arrive there). `start`: the tab it opens on.
 */
export function Receive({ snap, cardano = '', start = 'public', onBack, onToast }: { snap: Snapshot; cardano?: string; start?: 'public' | 'private' | 'cardano'; onBack: () => void; onToast: (m: string) => void }) {
  const [lane, setLane] = useState<'public' | 'private' | 'cardano'>(start)
  const [advanced, setAdvanced] = useState(false)
  const [qr, setQr] = useState('')
  const address = lane === 'cardano' ? cardano : lane === 'public' ? snap.unshieldedAddress : snap.shieldedAddress

  useEffect(() => {
    if (!address) { setQr(''); return }
    let alive = true
    QRCode.toDataURL(address, { margin: 1, width: 560, errorCorrectionLevel: 'M', color: { dark: '#050507', light: '#ffffff' } })
      .then((u) => { if (alive) setQr(u) })
      .catch(() => setQr(''))
    return () => { alive = false }
  }, [address])

  const copy = async (text: string, what: string) => { if (!text) return; onToast((await copyText(text)) ? `${what} copied` : 'Could not copy') }
  const share = async () => {
    if (!address) return
    const nav = navigator as Navigator & { share?: (d: { text: string }) => Promise<void> }
    if (nav.share) { try { await nav.share({ text: address }) } catch {} }
    // Android's WebView has no share of its own: the app opens the system share sheet
    else if (isAndroidApp()) { try { await Shell.share({ text: address }) } catch { copy(address, 'Address') } }
    else copy(address, 'Address')
  }

  return (
    <div className="screen">
      <Header title="Receive" back={onBack} />

      <div className="seg">
        <button className={lane === 'public' ? 'on' : ''} onClick={() => setLane('public')}>Public</button>
        <button className={lane === 'private' ? 'on' : ''} onClick={() => setLane('private')}>Private</button>
        {cardano && <button className={lane === 'cardano' ? 'on' : ''} onClick={() => setLane('cardano')}>Cardano</button>}
      </div>

      <div className="card" style={{ display: 'grid', gap: 15, justifyItems: 'center' }}>
        {qr
          ? <img src={qr} alt="" className="qr" />
          : <div style={{ width: 281, height: 281, display: 'grid', placeItems: 'center' }} className="muted">deriving…</div>}
        <button className="mono" onClick={() => copy(address, 'Address')} style={{ wordBreak: 'break-all', textAlign: 'center', lineHeight: 1.5, color: 'var(--fg-2)', userSelect: 'text' }}>
          {address || ' '}
        </button>
      </div>

      <div className="tiny" style={{ textAlign: 'center' }}>
        {lane === 'cardano'
          ? 'Your address on Cardano, for ADA and NIGHT sent from a Cardano wallet or an exchange. Midnight assets cannot arrive here.'
          : lane === 'public'
          ? 'Anyone can see what this address holds. Works for every Midnight asset and bridged tokens.'
          : 'Only you can see what arrives here. Senders need a wallet that supports private transfers.'}
      </div>

      <div className="row">
        <button className="btn" onClick={() => copy(address, 'Address')}>Copy</button>
        <button className="btn ghost" onClick={share}>Share</button>
      </div>

      <div className="grow" />
      <button className="tiny" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide' : 'Advanced'}</button>
      {advanced && (
        <div className="card" style={{ display: 'grid', gap: 7 }}>
          <div className="row spread"><span style={{ fontWeight: 600 }}>Fee energy address</span><button className="tiny" onClick={() => copy(snap.dustAddress, 'Fee energy address')}>Copy</button></div>
          <div className="mono tiny" style={{ wordBreak: 'break-all', userSelect: 'text' }}>{snap.dustAddress || '—'}</div>
          <div className="tiny">Where DUST is credited when you turn on fee energy. You never need to send anything here.</div>
        </div>
      )}
    </div>
  )
}
