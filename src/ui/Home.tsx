import { useEffect, useMemo, useRef, useState } from 'react'
import { WalletSession, type Snapshot, type StartOptions, fmtUnits, NIGHT_TYPE, DUST_DECIMALS, NIGHT_DECIMALS } from '../core/wallet'
import { listWallets, noteWalletAddress, type SessionKeys, type Unlocked } from '../core/vault'
import { Wallets } from './Wallets'
import { Onboarding } from './Onboarding'
import { KNOWN, lookupToken } from '../core/tokens'
import { usePrices } from '../core/prices'
import { Receive } from './Receive'
import { Send } from './Send'
import { Settings } from './Settings'
import { Activity } from './Activity'
import { copyText } from './copy'
import { Apps } from './Apps'
import { Approve } from './Approve'
import { DappHost, type Ask } from '../dapp/host'
import { attachHost, browser, coverBrowser, hasInAppBrowser } from '../dapp/bridge'
import { confirmUser } from './Confirm'
import { FeeEnergy } from './FeeEnergy'
import { CardanoPanel, useEnergy } from './Cardano'
import { CardanoSend } from './CardanoSend'
import { fmtAda, fmtNight } from '../core/energy'
import { NftDetail, NftStrip, Nfts, useNfts } from './Nfts'
import type { Nft } from '../core/nfts'
import { IconActivity, IconApps, IconReceive, IconSend, Mark } from './Icons'
import { keepAwake } from '../core/awake'
import { noteReplayDust } from '../core/dustNotes'
import { makeThumb, notePictureHeld, onPictureChange, readPicture, writePicture } from '../core/avatar'

/**
 * One wallet's screens. `walletId` + `keys`: which of the device's wallets this is and the keys of the unlock, for
 * the list under the wallet's name (switch, add). App gives every wallet a Home of its own.
 */
export function Home({ session, walletId, keys, onSwitch, onAdded, onLock, onRemoved, onRescan }: {
  session: WalletSession; walletId: string; keys: SessionKeys
  onSwitch: (walletId: string) => Promise<void>; onAdded: (u: Unlocked, opts?: StartOptions) => Promise<void>
  onLock: () => void; onRemoved: (next: string | null) => void
  /** Settings, "Scan everything again": this wallet starts over from the chain's beginning */ onRescan: () => Promise<void>
}) {
  const [snap, setSnap] = useState<Snapshot>(session.snap)
  const [lane, setLane] = useState<'public' | 'private' | 'cardano'>('public')
  const [screen, setScreen] = useState<'home' | 'receive' | 'send' | 'activity' | 'settings' | 'apps' | 'nfts' | 'nft' | 'nft-send' | 'fee' | 'cardano-send' | 'add-wallet'>('home')
  const [toast, setToast] = useState('')
  // the Fee energy screen opened from a button on the Cardano tab comes up on that button's step
  const [feeStart, setFeeStart] = useState<'register' | 'moveout' | undefined>(undefined)
  const openFee = (start?: 'register' | 'moveout') => { setFeeStart(start); setScreen('fee') }
  const priceFor = usePrices()
  useEffect(() => session.subscribe(setSnap), [session])
  // the wallets on this device: the sheet under the wallet's name switches between them and adds one
  const [wallets, setWallets] = useState(listWallets)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchErr, setSwitchErr] = useState('')
  const walletName = wallets.find((w) => w.id === walletId)?.name ?? 'Wallet'
  const openWallets = () => { setWallets(listWallets()); setSwitchErr(''); setSheetOpen(true) }
  const pickWallet = async (id: string) => {
    setSwitching(id); setSwitchErr('')
    try { await onSwitch(id) } catch (e) { setSwitchErr(e instanceof Error ? e.message : 'That wallet could not be opened'); setSwitching(null) }
  }
  // its public address, for that list
  useEffect(() => { if (snap.unshieldedAddress) noteWalletAddress(walletId, snap.unshieldedAddress) }, [walletId, snap.unshieldedAddress])
  const { nfts, hidden, toggleHidden } = useNfts(session, snap)
  // The wallet's picture: an NFT it holds, in place of the mark. It shows while the wallet holds that NFT, which is
  // known for sure only when the wallet is up to date; until then, what it knew last time counts.
  const [picture, setPicture] = useState(() => readPicture(walletId))
  useEffect(() => { setPicture(readPicture(walletId)); return onPictureChange(() => setPicture(readPicture(walletId))) }, [walletId])
  const pictureHeld = !!picture && ((snap.balances.shielded.get(picture.type) ?? 0n) > 0n || (snap.balances.unshielded.get(picture.type) ?? 0n) > 0n)
  useEffect(() => { if (picture && snap.phase === 'ready' && picture.held !== pictureHeld) notePictureHeld(pictureHeld, walletId) }, [picture, pictureHeld, snap.phase, walletId])
  const shownPicture = picture && (snap.phase === 'ready' ? pictureHeld : picture.held) ? picture : null
  const setNftPicture = async (nft: Nft, urls: string[] | null) => {
    if (!urls) { writePicture(null, walletId); setToast('Wallet picture removed'); return }
    const thumb = await makeThumb(urls)
    if (!thumb) { setToast('This picture could not be read'); return }
    writePicture({ type: nft.type, name: nft.name, thumb, held: true }, walletId)
    setToast('Wallet picture set')
  }
  // the wallet's own Cardano address (same phrase): asked about often while its tab or the Fee energy screen shows, seldom otherwise
  const cardanoAddress = session.cardano?.address ?? ''
  const energy = useEnergy(cardanoAddress, snap.dustAddress, lane === 'cardano' || screen === 'fee' || screen === 'cardano-send', walletId)
  const nftTypes = useMemo(() => new Set(nfts.map((n) => n.type)), [nfts])
  // the NFT on show in the detail screen, and the screen it was opened from
  const [openNft, setOpenNft] = useState<{ type: string; from: 'home' | 'nfts' } | null>(null)
  const shownNft = openNft ? nfts.find((n) => n.type === openNft.type) ?? null : null
  const showNft = (n: Nft, from: 'home' | 'nfts') => { setOpenNft({ type: n.type, from }); setScreen('nft') }

  // dApp connector: one host per unlocked session; its approval requests queue here and show as a sheet
  const [asks, setAsks] = useState<Array<{ ask: Ask; answer: (ok: boolean) => void }>>([])
  const host = useMemo(() => new DappHost(session, (ask) => new Promise<boolean>((answer) => setAsks((q) => [...q, { ask, answer }]))), [session])
  useEffect(() => attachHost(host), [host])
  const current = asks[0] ?? null
  // the native dApp view covers the wallet UI: hide it while a sheet is up
  useEffect(() => { coverBrowser('sheet', !!current); return () => coverBrowser('sheet', false) }, [!!current])
  // the page that asked is gone: decline whatever it left behind
  useEffect(() => hasInAppBrowser() ? browser.onClosed(() => setAsks((q) => { q.forEach((x) => x.answer(false)); return [] })) : undefined, [])
  // funds only move after the person showed it is them (Face ID or the PIN); connecting and signing a message move nothing
  const answer = async (ok: boolean) => {
    if (!current) return
    const c = current
    if (ok && c.ask.kind !== 'connect' && c.ask.kind !== 'sign' && !(await confirmUser('Approve this transaction'))) return
    c.answer(ok); setAsks((q) => q.filter((x) => x !== c))
  }
  const sheet = current ? <Approve ask={current.ask} snap={snap} priceFor={priceFor} nfts={nfts} onAnswer={answer} /> : null
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 1700); return () => clearTimeout(t) }, [toast])
  // a long sync should not need a finger on the glass: the screen stays on until it is done
  useEffect(() => { keepAwake(snap.phase === 'syncing') }, [snap.phase])
  useEffect(() => () => keepAwake(false), [])
  // another device's sync was taken over while this screen was open
  const received = useRef(snap.handoff.receivedAt)
  useEffect(() => {
    if (snap.handoff.receivedAt && snap.handoff.receivedAt !== received.current) setToast('Sync picked up from your other device')
    received.current = snap.handoff.receivedAt
  }, [snap.handoff.receivedAt])
  // a registered Cardano address: this wallet's fee energy sync replays from now on, it never jumps ahead (core/dustNotes.ts)
  useEffect(() => { if (energy.st && energy.st.mapped !== 'none') noteReplayDust(walletId) }, [energy.st?.mapped, walletId])
  // a search for the wallet's fee energy ended while this screen was open
  const searched = useRef(!!snap.dustSearch)
  useEffect(() => {
    if (searched.current && !snap.dustSearch && snap.phase === 'ready') setToast(snap.balances.dustCap > 0n ? 'Fee energy found' : 'No fee energy found')
    searched.current = !!snap.dustSearch
  }, [snap.dustSearch, snap.phase, snap.balances.dustCap])

  const bal = lane === 'private' ? snap.balances.shielded : snap.balances.unshielded
  const rows = [...bal.entries()].filter(([type, v]) => v > 0n && !nftTypes.has(type)).map(([type, v]) => ({ type, v, meta: lookupToken(type) }))
  if (!rows.some((r) => r.type === NIGHT_TYPE)) rows.unshift({ type: NIGHT_TYPE, v: 0n, meta: KNOWN[NIGHT_TYPE] })
  const usd = (type: string, v: bigint, dec: number) => { const p = priceFor(type); return p == null ? null : Number(v) / 10 ** dec * p }
  // the Cardano tab: NIGHT and ADA on the wallet's Cardano address, priced like the rest
  const cst = energy.st
  const adaUsd = priceFor.key('ADA'), nightUsd = priceFor.key('NIGHT')
  // the number at the top is everything the recovery phrase holds: public, private, and what is on the Cardano address
  const onCardano = energy.held ? Number(energy.held.night) / 1e6 * (nightUsd ?? 0) + Number(energy.held.lovelace) / 1e6 * (adaUsd ?? 0) : 0
  const total = [...snap.balances.unshielded.entries(), ...snap.balances.shielded.entries()]
    .reduce((acc, [type, v]) => acc + (usd(type, v, lookupToken(type).decimals) ?? 0), 0) + onCardano
  const waiting = energy.down ? 'not answering' : 'checking…'
  const cardanoRows = [
    { logo: 'NI', name: 'Night', amount: cst ? `${fmtNight(cst.night)} NIGHT · on Cardano` : waiting, usd: cst && nightUsd != null ? Number(cst.night) / 1e6 * nightUsd : null },
    { logo: 'AD', name: 'ADA', amount: cst ? `${fmtAda(cst.lovelace)} ADA` : waiting, usd: cst && adaUsd != null ? Number(cst.lovelace) / 1e6 * adaUsd : null },
  ]

  const [whole, cents] = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split('.')

  const address = lane === 'cardano' ? cardanoAddress : lane === 'public' ? snap.unshieldedAddress : snap.shieldedAddress
  const short = (a: string) => (a ? `${a.slice(0, 11)}…${a.slice(-6)}` : '')
  const copy = async () => { if (!address) return; setToast((await copyText(address)) ? (lane === 'cardano' ? 'Cardano address copied' : 'Address copied') : 'Could not copy') }

  const dustPct = snap.balances.dustCap > 0n ? Number(snap.balances.dust * 1000n / snap.balances.dustCap) / 10 : 0
  const readyIn = snap.readyForTxAt ? Math.max(0, Math.ceil((snap.readyForTxAt - Date.now()) / 1000)) : null

  // the toast is position:fixed, so it is rendered alongside whichever screen is showing
  const toastEl = <>{toast ? <div className="toast">{toast}</div> : null}{sheet}</>
  const back = () => setScreen('home')
  if (screen === 'add-wallet') return <Onboarding add={{ keys, onCancel: back }} onDone={(u, opts) => { void onAdded(u, opts) }} />
  // on the Cardano tab, Receive and Send are about the Cardano address
  if (screen === 'receive') return <>{<Receive snap={snap} cardano={cardanoAddress} start={lane} onBack={back} onToast={setToast} />}{toastEl}</>
  if (screen === 'cardano-send') return <>{<CardanoSend session={session} energy={energy} priceFor={priceFor} onBack={back} onToast={setToast} />}{toastEl}</>
  if (screen === 'send') return <>{<Send session={session} snap={snap} priceFor={priceFor} onBack={back} onToast={setToast} skip={nftTypes} onFeeHelp={() => openFee()} />}{toastEl}</>
  if (screen === 'fee') return <>{<FeeEnergy key={feeStart ?? 'main'} session={session} snap={snap} energy={energy} start={feeStart} onSend={() => setScreen('cardano-send')} onBack={back} onToast={setToast} />}{toastEl}</>
  if (screen === 'nfts') return <>{<Nfts nfts={nfts} hidden={hidden} onOpen={(n) => showNft(n, 'nfts')} onBack={back} />}{toastEl}</>
  if (screen === 'nft' && shownNft) return <>{<NftDetail nft={shownNft} isHidden={hidden.has(shownNft.type)} isPicture={picture?.type === shownNft.type} onPicture={(urls) => setNftPicture(shownNft, urls)} onSend={() => setScreen('nft-send')} onToggleHidden={() => toggleHidden(shownNft.type)} onBack={() => setScreen(openNft?.from === 'nfts' ? 'nfts' : 'home')} onToast={setToast} />}{toastEl}</>
  // a sent NFT leaves the list: the Send flow keeps its own copy of what it is sending and ends on Home
  if (screen === 'nft-send' && openNft) return <>{<NftSend key={openNft.type} session={session} snap={snap} priceFor={priceFor} nft={shownNft} onBack={() => setScreen(shownNft ? 'nft' : 'home')} onToast={setToast} />}{toastEl}</>
  if (screen === 'activity') return <>{<Activity address={snap.unshieldedAddress} cardano={cardanoAddress} start={lane} priceFor={priceFor} onBack={back} onToast={setToast} />}{toastEl}</>
  if (screen === 'apps') return <>{<Apps onBack={back} onToast={setToast} />}{toastEl}</>
  if (screen === 'settings') return <>{<Settings session={session} snap={snap} walletId={walletId} walletName={walletName} onRenamed={() => setWallets(listWallets())} onBack={back} onLock={onLock} onRemoved={onRemoved} onRescan={async () => { setScreen('home'); await onRescan() }} onToast={setToast} />}{toastEl}</>

  return (
    <div className="screen">
      <div className="row spread">
        <div className="row" style={{ textAlign: 'left' }}>
          <button className={shownPicture ? 'avatar pic' : 'avatar'} onClick={openWallets} aria-label="Wallets" data-wallet-picture={shownPicture?.type ?? ''}>
            {shownPicture ? <img src={shownPicture.thumb} alt="" draggable={false} /> : <Mark size={21} />}
          </button>
          <div>
            {/* the name opens the device's wallets; the address under it is copied by a tap */}
            <button data-wallets onClick={openWallets} style={{ display: 'block', fontWeight: 600, color: 'var(--fg-hi)' }}>{walletName} <span className="muted" aria-hidden="true">▾</span></button>
            <button className="tiny mono" onClick={copy} style={{ display: 'block' }}>{short(address) || 'deriving…'}</button>
          </div>
        </div>
        <div className="row" style={{ gap: 7 }}>
          <button className="icon-btn" onClick={() => setScreen('settings')} title="Settings" aria-label="Settings">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          </button>
          <button className="icon-btn" onClick={onLock} title="Lock" aria-label="Lock">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V7.5a4 4 0 0 1 8 0V11" /></svg>
          </button>
        </div>
      </div>

      <div>
        <div className="balance" data-total={total.toFixed(2)}><span className="cur">$</span>{whole}<span className="cents">.{cents}</span></div>
        <div className="muted status">
          <i className={'dot ' + (snap.phase === 'error' ? 'bad' : snap.phase !== 'ready' ? 'busy' : readyIn ? 'wait' : 'ok')} />
          {snap.phase === 'error' ? <span className="err">{snap.error}</span>
            : snap.phase !== 'ready' ? <SyncLine snap={snap} />
            : readyIn ? `Getting ready · ${fmtClock(readyIn)}` : 'Up to date'}
        </div>
        {snap.phase === 'syncing' && <div className="sync"><i style={{ width: `${syncPct(snap)}%` }} /></div>}
      </div>

      <div className="actions">
        <Action ic={<IconReceive />} label="Receive" onClick={() => setScreen('receive')} />
        <Action ic={<IconSend />} label="Send" onClick={() => setScreen(lane === 'cardano' ? 'cardano-send' : 'send')} />
        <Action ic={<IconActivity />} label="Activity" onClick={() => setScreen('activity')} />
        <Action ic={<IconApps />} label="Apps" onClick={() => setScreen('apps')} />
      </div>

      <div className="seg">
        <button className={lane === 'public' ? 'on' : ''} onClick={() => setLane('public')}>Public</button>
        <button className={lane === 'private' ? 'on' : ''} onClick={() => setLane('private')}>Private</button>
        <button className={lane === 'cardano' ? 'on' : ''} onClick={() => setLane('cardano')}>Cardano</button>
      </div>

      {lane !== 'cardano' && <NftStrip nfts={nfts.filter((n) => n.lane === lane && !hidden.has(n.type))} onOpen={(n) => showNft(n, 'home')} onAll={() => setScreen('nfts')} />}

      {/* what sits on the wallet's Cardano address, then the steps and its buttons */}
      {lane === 'cardano' && (
        <>
          <div className="list" data-cardano-rows>
            {cardanoRows.map((r) => (
              <div className="token" key={r.name}>
                <div className="logo">{r.logo}</div>
                <div className="grow">
                  <div className="name">{r.name}</div>
                  <div className="tiny mono">{r.amount}</div>
                </div>
                <div className={r.usd == null ? 'tiny' : 'num'} style={{ fontWeight: 600 }}>{r.usd == null ? '—' : `$${r.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</div>
              </div>
            ))}
          </div>
          <CardanoPanel address={cardanoAddress} energy={energy} onCopy={copy} onRegister={() => openFee('register')} onSend={() => setScreen('cardano-send')} onMoveOut={() => openFee('moveout')} />
        </>
      )}

      {lane !== 'cardano' && <div className="list">
        {rows.map((r) => {
          const u = usd(r.type, r.v, r.meta.decimals)
          return (
            <div className="token" key={r.type}>
              <div className="logo">{r.meta.ticker.slice(0, 2)}</div>
              <div className="grow">
                <div className={/^[0-9a-f]{6}/.test(r.meta.name) ? 'name mono' : 'name'}>{r.meta.name}</div>
                {/* one unit of a token nobody knows is an item the wallet could not identify, not "0" of a coin */}
                <div className="tiny mono">{r.v === 1n && !KNOWN[r.type] ? '1 item · not identified' : `${fmtUnits(r.v, r.meta.decimals)} ${r.meta.ticker}`}</div>
              </div>
              <div className={u == null ? 'tiny' : 'num'} style={{ fontWeight: 600 }}>{u == null ? '—' : `$${u.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</div>
            </div>
          )
        })}
      </div>}

      {/* the whole card opens what fee energy is and how to get it: a new wallet has none and cannot send */}
      <button className="card" style={{ display: 'grid', gap: 9, textAlign: 'left', width: '100%' }} onClick={() => openFee()}>
        <div className="row spread">
          <span style={{ fontWeight: 600, color: 'var(--fg-hi)' }}>Fee energy</span>
          <span className="mono">{fmtUnits(snap.balances.dust, DUST_DECIMALS, 2)} <span className="muted">DUST</span></span>
        </div>
        <div className="bar"><i style={{ width: `${Math.min(100, dustPct)}%` }} /></div>
        <div className="tiny">
          {snap.dustSearch && !snap.dustSearch.all ? 'Your NIGHT on Cardano has been earning. Reading it in now: keep the app open.'
            : snap.dustMissing ? 'Your NIGHT on Cardano is earning, but this device has not found it. Settings, Scan again.'
            : snap.balances.dustCap === 0n
            ? (snap.phase === 'ready' ? 'None yet, and every transaction needs some. Tap to set it up with NIGHT on Cardano.' : 'Earned by NIGHT on Cardano. Tap to set it up.')
            : `${dustPct.toFixed(1)}% of ${fmtUnits(snap.balances.dustCap, DUST_DECIMALS, 1)}${fullIn(snap.balances.dustFullAt)} · ${nightHeld(snap)}`}
        </div>
      </button>

      {sheetOpen && <Wallets wallets={wallets} activeId={walletId} busy={switching} err={switchErr} onPick={pickWallet} onAdd={() => { setSheetOpen(false); setScreen('add-wallet') }} onClose={() => setSheetOpen(false)} />}
      {toastEl}
    </div>
  )
}

/** Send for one NFT. It remembers the NFT it was opened with: once sent, the NFT is gone from the wallet's list. */
function NftSend({ session, snap, priceFor, nft, onBack, onToast }: { session: WalletSession; snap: Snapshot; priceFor: ReturnType<typeof usePrices>; nft: Nft | null; onBack: () => void; onToast: (m: string) => void }) {
  const [kept] = useState(nft)
  if (!kept) return null
  return <Send session={session} snap={snap} priceFor={priceFor} onBack={onBack} onToast={onToast} nft={{ type: kept.type, lane: kept.lane, name: kept.name }} />
}

function Action({ ic, label, onClick }: { ic: React.ReactNode; label: string; onClick: () => void }) {
  return <button className="action" onClick={onClick}><span className="ic">{ic}</span>{label}</button>
}

function SyncLine({ snap }: { snap: Snapshot }) {
  // two independent syncs: private balance (shielded) and fee energy (DUST); show whichever is behind
  const pctOf = (p: typeof snap.shielded) => (p && p.highest > 0n ? Math.min(100, Number((p.applied * 1000n) / p.highest) / 10) : 0)
  const sh = pctOf(snap.shielded), du = pctOf(snap.dust)
  const verb = snap.startMode === 'bootstrap' ? 'Catching up' : snap.startMode === 'cache' || snap.startMode === 'handoff' ? 'Resuming' : 'Syncing'
  if (snap.phase === 'starting') return <span>{snap.startMode ? `${verb}…` : 'Connecting…'}</span>
  // the fee energy history is being read again: how far, counted from where that began
  if (snap.dustSearch && !snap.dustSearch.all && sh >= 99.95) return <span data-dust-search>Finding your fee energy {searchPct(snap).toFixed(1)}%</span>
  if (sh >= 99.95 && du < 99.95) return <span>Syncing fee energy {du.toFixed(1)}%</span>
  if (sh >= 99.95 && du >= 99.95) return <span>Finishing up…</span>
  const pct = Math.min(sh, du)
  return <span>{snap.startMode !== 'genesis' && pct < 1 ? `${verb}…` : `${verb} ${pct.toFixed(1)}%`}</span>
}

/** how far the slower of the two syncs is, for the line under the balance */
function syncPct(snap: Snapshot) {
  const pctOf = (p: typeof snap.shielded) => (p && p.highest > 0n ? Math.min(100, Number((p.applied * 1000n) / p.highest) / 10) : 0)
  if (snap.dustSearch && !snap.dustSearch.all && pctOf(snap.shielded) >= 99.95) return searchPct(snap)
  return Math.min(pctOf(snap.shielded), pctOf(snap.dust))
}

/** how far a fee energy search is: the DUST events read, of those between where it began and the newest */
function searchPct(snap: Snapshot) {
  const p = snap.dust, from = snap.dustSearch?.from ?? 0n
  if (!p || p.highest <= from) return 0
  const done = p.applied > from ? p.applied - from : 0n
  return Math.min(100, Number((done * 1000n) / (p.highest - from)) / 10)
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// DUST can be backed by NIGHT held here or by registered NIGHT still on Cardano, so only quote a number when it is here
function nightHeld(snap: Snapshot) {
  const n = snap.balances.unshielded.get(NIGHT_TYPE) ?? 0n
  return n > 0n ? `earned by holding ${fmtUnits(n, NIGHT_DECIMALS, 0)} NIGHT` : 'earned by your registered NIGHT'
}

function fullIn(at: number | null) {
  if (!at) return ''
  const m = Math.round((at - Date.now()) / 60_000)
  if (m <= 0) return ' · full'
  return m < 60 ? ` · full in ${m}m` : m < 60 * 48 ? ` · full in ${Math.floor(m / 60)}h ${m % 60}m` : ` · full in ${(m / 1440).toFixed(1)}d`
}
