import { useEffect, useState } from 'react'
import { DEFAULTS, loadEndpoints, saveEndpoints, type Endpoints, diagnosticsOn, setDiagnostics } from '../core/net'
import { disableBiometrics, enableBiometrics, listWallets, removeWallet, renameWallet, unlockWithPin, vaultInfo } from '../core/vault'
import { biometry, biometryName, type Biometry } from '../core/device'
import { AUTO_LOCK_CHOICES, lockSettings, saveLockSettings } from '../core/lock'
import { PinAsk } from './PinAsk'
import { confirmUser } from './Confirm'
import { Header } from './Header'
import { displayName, listConnections, onConnectionsChange, removeConnection } from '../dapp/connections'
import { setSharing, sharingOn } from '../core/handoff'
import type { Snapshot, WalletSession } from '../core/wallet'
import { checkForUpdate, installedBuild, openDownload, useUpdate } from '../core/update'

type Panel = 'name' | 'main' | 'network' | 'reveal' | 'remove' | 'apps' | 'devices' | 'security' | 'face' | 'scan'

function Item({ label, hint, onClick, danger }: { label: string; hint?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className="token" style={{ width: '100%', textAlign: 'left' }} onClick={onClick}>
      <div className="grow">
        <div style={{ fontWeight: 600, color: danger ? 'var(--bad)' : undefined }}>{label}</div>
        {hint && <div className="tiny">{hint}</div>}
      </div>
      <span className="muted">›</span>
    </button>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'grid', gap: 5 }}>
      <span className="tiny">{label}</span>
      <input className="mono" value={value} onChange={(e) => onChange(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
    </label>
  )
}

const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function Settings({ session, snap, walletId, walletName, onRenamed, onBack, onLock, onRemoved, onRescan, onToast }: {
  session: WalletSession; snap: Snapshot
  /** the wallet these settings are opened for, and its name on this device */ walletId: string; walletName: string; onRenamed: () => void
  onBack: () => void; onLock: () => void
  /** the wallet in use after this one was removed; null when it was the last */ onRemoved: (next: string | null) => void
  /** this wallet starts over from the chain's beginning (the caller leaves this screen) */ onRescan: () => Promise<void>
  onToast: (m: string) => void
}) {
  const [scanning, setScanning] = useState(false)
  const findEnergy = async () => {
    setScanning(true)
    try {
      if (await session.findFeeEnergy(null, 'asked')) { onToast('Reading your fee energy again'); onBack() }
      else onToast('Not possible right now. Try again in a moment.')
    } finally { setScanning(false) }
  }
  const [name, setName] = useState(walletName)
  const others = listWallets().length - 1
  const [share, setShare] = useState(sharingOn())
  const [sending, setSending] = useState(false)
  const sendNow = async () => { setSending(true); try { await session.shareNow() } finally { setSending(false) } }
  const [panel, setPanel] = useState<Panel>('main')
  const [ep, setEp] = useState<Endpoints>(loadEndpoints())
  const [diag, setDiag] = useState(diagnosticsOn())
  const [words, setWords] = useState<string[] | null>(null)
  const [err, setErr] = useState('')
  const [conns, setConns] = useState(listConnections)
  const [lock, setLock] = useState(lockSettings)
  const [bio, setBio] = useState<Biometry>('none')
  useEffect(() => { void biometry().then(setBio) }, [])
  // a change that loosens the wallet's guard is the owner's to make: whoever holds the unlocked phone is asked first
  const setLockSetting = async (c: Parameters<typeof saveLockSettings>[0]) => {
    const now = lockSettings()
    const looser = c.confirm === false || (c.autoLockMin !== undefined && now.autoLockMin !== 0 && (c.autoLockMin === 0 || c.autoLockMin > now.autoLockMin))
    if (looser && !(await confirmUser('Change security settings', { always: true }))) return
    saveLockSettings(c); setLock(lockSettings())
  }
  const kept = vaultInfo()
  // Android: opening Settings asks once more whether a newer build is out
  const update = useUpdate()
  const [build, setBuild] = useState(0)
  useEffect(() => { void installedBuild().then((b) => setBuild(b?.code ?? 0)); void checkForUpdate(true) }, [])
  useEffect(() => onConnectionsChange(() => setConns(listConnections())), [])
  const set = (k: keyof Endpoints) => (v: string) => setEp({ ...ep, [k]: v })

  if (panel === 'main') return (
    <div className="screen">
      <Header title="Settings" back={onBack} />
      {update && (
        <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
          <Item label={update.required ? 'Update needed' : 'Update available'} hint={`Build ${update.code} is ready · tap to get it`} onClick={async () => { if (!(await openDownload())) onToast('Could not open the browser') }} />
        </div>
      )}
      <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
        <Item label="Wallet name" hint={walletName} onClick={() => { setName(walletName); setPanel('name') }} />
        <Item label="Network" hint={hostOf(ep.nodeWs)} onClick={() => setPanel('network')} />
        <Item label="Connected apps" hint={conns.length ? `${conns.length} connected` : 'None'} onClick={() => setPanel('apps')} />
        <Item label="My devices" hint={share ? 'Sharing sync from this device' : 'Sync once, use it on every device'} onClick={() => setPanel('devices')} />
        <Item label="Security" hint={`Locks after ${lock.autoLockMin ? `${lock.autoLockMin} min` : 'never'}${lock.bio ? ` · ${biometryName(bio) || 'Face ID'} on` : ''}`} onClick={() => setPanel('security')} />
        <Item label="Recovery phrase" hint="Show the 24 words (PIN required)" onClick={() => { setWords(null); setErr(''); setPanel('reveal') }} />
        <Item label="Lock now" onClick={onLock} />
      </div>
      <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
        <Item label="Scan again" hint="If fee energy or funds are missing on this device" onClick={() => setPanel('scan')} />
      </div>
      <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
        <Item label="Remove wallet from this device" hint="Your funds stay on the chain; restore with the 24 words" onClick={() => setPanel('remove')} danger />
      </div>
      <div className="grow" />
      <div className="tiny" style={{ textAlign: 'center' }}>Lump Wallet {__APP_VERSION__}{build ? ` (${build})` : ''} · Midnight mainnet · your recovery phrase never leaves this device</div>
    </div>
  )

  if (panel === 'scan') return (
    <div className="screen">
      <Header title="Scan again" back={() => setPanel('main')} />
      <div className="card" style={{ display: 'grid', gap: 13 }}>
        <div>Fee energy missing</div>
        <div className="tiny">Reads this wallet's fee energy history again. Up to an hour with the app open. Nothing else changes.</div>
        <button className="btn" data-scan="energy" disabled={scanning || !!snap.dustSearch || snap.phase === 'starting'} onClick={findEnergy}>{snap.dustSearch ? 'Reading it now…' : scanning ? 'Starting…' : 'Find fee energy again'}</button>
      </div>
      <div className="card" style={{ display: 'grid', gap: 13 }}>
        <div>Funds missing</div>
        <div className="tiny">Reads the whole chain again for this wallet. It can take hours with the app open. Your funds are on the chain and are not touched.</div>
        <button className="btn ghost" data-scan="all" disabled={scanning} onClick={async () => { setScanning(true); try { await onRescan() } finally { setScanning(false) } }}>Scan everything again</button>
      </div>
    </div>
  )

  if (panel === 'network') return (
    <div className="screen">
      <Header title="Network" back={() => { setErr(''); setPanel('main') }} />
      <div className="card" style={{ display: 'grid', gap: 13 }}>
        <Field label="Node (wss)" value={ep.nodeWs} onChange={set('nodeWs')} />
        <Field label="Indexer" value={ep.indexerUrl} onChange={set('indexerUrl')} />
        <Field label="Indexer websocket" value={ep.indexerWsUrl} onChange={set('indexerWsUrl')} />
        <Field label="Prover" value={ep.prover} onChange={set('prover')} />
        <label style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
          <input type="checkbox" checked={diag} onChange={(e) => { setDiag(e.target.checked); setDiagnostics(e.target.checked) }} />
          <span>Share dApp diagnostics with LumpTools</span>
        </label>
        <div className="tiny">Off by default. When on, each dApp request this wallet handles sends its name, outcome, timing and the site's address to the LumpTools wallet server. Never keys, addresses or amounts.</div>
      </div>
      <div className="tiny">The prover receives the private inputs of what it proves. For a spend from your private balance that includes key material, so use a prover you run yourself or trust. The indexer learns which private notes are yours (it syncs them for you), so pick one you trust. Changes apply after the next unlock.</div>
      <div className="grow" />
      <button className="btn ghost" onClick={() => setEp(DEFAULTS)}>Use LumpTools defaults</button>
      <button className="btn" onClick={async () => {
        try { for (const k of ['nodeWs', 'indexerUrl', 'indexerWsUrl', 'prover'] as const) new URL(ep[k]) } catch { setErr('One of the addresses is not a valid URL'); return }
        // these servers see what the wallet reads and proves: not for whoever picks up the phone to change
        if (!(await confirmUser('Change network settings', { always: true }))) return
        saveEndpoints(ep); setErr(''); onToast('Saved · applies after the next unlock'); setPanel('main')
      }}>Save</button>
      {err && <div className="err" style={{ textAlign: 'center' }}>{err}</div>}
    </div>
  )

  if (panel === 'security') return (
    <div className="screen">
      <Header title="Security" back={() => setPanel('main')} />
      <div className="card" style={{ display: 'grid', gap: 13 }}>
        <div style={{ fontWeight: 600 }}>Lock again after</div>
        <div className="seg">
          {AUTO_LOCK_CHOICES.map((m) => <button key={m} className={lock.autoLockMin === m ? 'on' : ''} onClick={() => void setLockSetting({ autoLockMin: m })}>{m ? `${m} min` : 'Never'}</button>)}
        </div>
        <div className="tiny">Out of sight or untouched for this long, the wallet asks for the PIN again. It keeps syncing behind the lock.</div>
      </div>
      <div className="card" style={{ display: 'grid', gap: 13 }}>
        <label style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
          <input type="checkbox" checked={lock.confirm} onChange={(e) => void setLockSetting({ confirm: e.target.checked })} />
          <span>Ask before funds move</span>
        </label>
        <div className="tiny">{lock.bio ? biometryName(bio) || 'Face ID' : 'The PIN'} is asked for before a send and before a site's transaction goes out.</div>
        {bio !== 'none' && (
          <label style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
            <input type="checkbox" checked={lock.bio} onChange={async (e) => { if (e.target.checked) setPanel('face'); else { await disableBiometrics(); setLock(lockSettings()) } }} />
            <span>Unlock with {biometryName(bio)}</span>
          </label>
        )}
      </div>
      <div className="tiny">
        {kept?.locks === 2
          ? `Your recovery phrase is locked with your PIN and a key kept in ${kept.where === 'keychain' ? 'the Keychain of this device' : 'this browser'}. ${kept.where === 'keychain' ? 'A copy of the app\'s data cannot be opened anywhere else.' : 'Both are kept in this app\'s own storage, so the PIN is what protects a copy of that storage.'} After moving to a new phone, restore with the 24 words.`
          : 'Your recovery phrase is locked with your PIN.'}
        {' '}Wrong PINs make the wallet wait, longer each time.
      </div>
    </div>
  )

  if (panel === 'face') return (
    <div className="screen" style={{ justifyContent: 'center' }}>
      <Header title={biometryName(bio) || 'Face ID'} back={() => setPanel('security')} />
      <p className="muted" style={{ textAlign: 'center', margin: 0 }}>Enter your PIN to turn it on</p>
      <PinAsk attempt={enableBiometrics} onOk={() => { setLock(lockSettings()); onToast(`${biometryName(bio) || 'Face ID'} is on`); setPanel('security') }} />
    </div>
  )

  if (panel === 'devices') {
    const h = snap.handoff
    const sent = sending ? 'Sending…' : h.shareError ? `Could not send: ${h.shareError}` : h.sharedAt ? `Sent at ${clock(h.sharedAt)}` : share ? 'Not sent yet' : ''
    return (
      <div className="screen">
        <Header title="My devices" back={() => setPanel('main')} />
        <div className="card" style={{ display: 'grid', gap: 13 }}>
          <label style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
            <input type="checkbox" checked={share} onChange={(e) => { const on = e.target.checked; setSharing(on); setShare(on); if (on) void sendNow() }} />
            <span>Share sync from this device</span>
          </label>
          <div className="tiny">Your other devices with the same 24 words continue where this one has got to, instead of syncing from the start. Leave a computer syncing, then open the wallet on your phone.</div>
          {sent && <div className={h.shareError && !sending ? 'err' : 'muted'}>{sent}</div>}
          {h.receivedAt && <div className="muted">Picked up from another device at {clock(h.receivedAt)}</div>}
        </div>
        <div className="tiny">The copy is locked on this device with a key made from your 24 words. The LumpTools wallet server keeps it for 3 days and cannot read it. It holds what this wallet has read from the chain (balances and history), never your keys.</div>
        <div className="grow" />
        {share && <button className="btn ghost" disabled={sending} onClick={() => void sendNow()}>Send now</button>}
      </div>
    )
  }

  if (panel === 'apps') return (
    <div className="screen">
      <Header title="Connected apps" back={() => setPanel('main')} />
      {conns.length === 0
        ? <div className="muted">No site is connected.</div>
        : <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
            {conns.map((c) => (
              <div className="token" key={c.origin}>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{displayName(c.origin)}</div>
                  <div className="tiny">since {new Date(c.since).toLocaleDateString()}</div>
                </div>
                <button className="muted" style={{ fontWeight: 600 }} onClick={() => { removeConnection(c.origin); onToast('Disconnected') }}>Disconnect</button>
              </div>
            ))}
          </div>}
      <div className="tiny">A connected site can read your addresses and balances and ask for approvals. Disconnecting stops both; the site has to ask again.</div>
    </div>
  )

  if (panel === 'name') return (
    <div className="screen">
      <Header title="Wallet name" back={() => setPanel('main')} />
      <label style={{ display: 'grid', gap: 5 }}>
        <span className="tiny">Shown on this device only</span>
        <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} aria-label="Wallet name" />
      </label>
      <div className="grow" />
      <button className="btn" disabled={!name.trim()} onClick={() => { renameWallet(walletId, name); onRenamed(); onToast('Name saved'); setPanel('main') }}>Save</button>
    </div>
  )

  if (panel === 'reveal') return (
    <div className="screen" style={{ justifyContent: words ? 'flex-start' : 'center' }}>
      <Header title="Recovery phrase" back={() => { setWords(null); setPanel('main') }} />
      {!words && <>
        <p className="muted" style={{ textAlign: 'center', margin: 0 }}>Enter your PIN</p>
        <PinAsk attempt={unlockWithPin} onOk={(u) => setWords(u.mnemonic.split(' '))} />
      </>}
      {words && <>
        <div className="err" style={{ textAlign: 'center' }}>Anyone with these words controls your funds. Never type them into a website.</div>
        <div className="words">{words.map((w, i) => <span className="word" key={i}><b>{i + 1}</b>{w}</span>)}</div>
        <div className="grow" />
        <button className="btn ghost" onClick={() => { setWords(null); setPanel('main') }}>Done</button>
      </>}
    </div>
  )

  return (
    <div className="screen" style={{ justifyContent: 'center' }}>
      <Header title="Remove wallet" back={() => setPanel('main')} />
      <div className="card">
        <p style={{ marginTop: 0 }}>This deletes the encrypted seed and the sync cache {others > 0 ? `of ${walletName} ` : ''}from this device. Your funds are untouched and come back when you restore with the 24 words. Make sure you have them.</p>
        {others > 0 && <p>Your other {others === 1 ? 'wallet stays' : `${others} wallets stay`}.</p>}
        <div className="row">
          <button className="btn ghost" onClick={() => setPanel('main')}>Keep</button>
          <button className="btn" style={{ background: 'var(--bad)' }} onClick={async () => { session.forget(); onRemoved(await removeWallet(walletId)) }}>Remove</button>
        </div>
      </div>
    </div>
  )
}
