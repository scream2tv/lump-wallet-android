// The wallets on this device, as a sheet over Home: tap one to use it, or add another (a new one, or one brought
// along with its 24 words). They share the PIN; each has its own phrase, addresses, connected sites and sync.
import { MAX_WALLETS, type WalletInfo } from '../core/vault'
import { readPicture } from '../core/avatar'
import { Mark } from './Icons'

const short = (a?: string) => (a ? `${a.slice(0, 11)}…${a.slice(-6)}` : '')

export function Wallets({ wallets, activeId, busy, err, onPick, onAdd, onClose }: {
  wallets: WalletInfo[]; activeId: string; busy: string | null; err: string
  onPick: (id: string) => void; onAdd: () => void; onClose: () => void
}) {
  return (
    <div className="sheet-back" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Wallets" data-wallets-sheet>
        <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--fg-hi)' }}>Wallets</div>
        <div className="list" style={{ marginTop: 0 }}>
          {wallets.map((w) => {
            // each wallet's own picture, if it has one and held its NFT when it was last up to date
            const pic = readPicture(w.id)
            const shown = pic?.held ? pic : null
            return (
            <button key={w.id} className="token" style={{ width: '100%', textAlign: 'left' }} disabled={!!busy} data-wallet={w.id} onClick={() => { if (w.id === activeId) onClose(); else onPick(w.id) }}>
              <div className={shown ? 'avatar pic' : 'avatar'}>{shown ? <img src={shown.thumb} alt="" draggable={false} /> : <Mark size={33} />}</div>
              <div className="grow">
                <div className="name">{w.name}</div>
                <div className="tiny mono">{short(w.address) || 'not opened on this device yet'}</div>
              </div>
              <span className="tiny" style={{ color: w.id === activeId ? 'var(--good)' : undefined }}>{busy === w.id ? 'Opening…' : w.id === activeId ? 'In use' : ''}</span>
            </button>
            )
          })}
        </div>
        {err && <div className="err">{err}</div>}
        <button className="btn" disabled={!!busy || wallets.length >= MAX_WALLETS} onClick={onAdd}>Add a wallet</button>
        {wallets.length >= MAX_WALLETS && <div className="tiny">This device holds up to {MAX_WALLETS} wallets.</div>}
        <button className="btn ghost" data-back disabled={!!busy} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
