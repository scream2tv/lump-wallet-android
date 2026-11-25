// NFTs: the hook that finds them, the strip on Home, the gallery and the detail screen.
// Every component is module-level: Home re-renders every second, and an inline component type would remount.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WalletSession, Snapshot } from '../core/wallet'
import { loadEndpoints } from '../core/net'
import { watchActivity } from '../core/activity'
import { candidates, isChecked, loadCachedNfts, loadHidden, pictureOf, resolveNfts, setHidden, type Nft } from '../core/nfts'
import { Header } from './Header'
import { copyText } from './copy'

const REFRESH_MS = 127_000
/** a pass that ran out of look-ups is followed this soon, at most this many times in a row */
const FOLLOW_MS = 11_000, MAX_FOLLOWS = 7

/**
 * The wallet's NFTs. Starts from what was known last time, then reads the chain: whenever the set of single-unit
 * tokens changes, and every couple of minutes after (a blind mint's picture arrives with its reveal).
 */
export function useNfts(session: WalletSession, snap: Snapshot): { nfts: Nft[]; hidden: Set<string>; toggleHidden: (type: string) => void } {
  const held = useMemo(() => candidates(snap.balances.unshielded, snap.balances.shielded), [snap.balances])
  const key = held.map((h) => `${h.lane[1]}${h.type}`).sort().join(',')
  const [found, setFound] = useState<Nft[]>(loadCachedNfts)
  const [hidden, setHiddenState] = useState<Set<string>>(loadHidden)
  const heldRef = useRef(held)
  heldRef.current = held
  /** public-lane transactions that brought a token type in, from the indexer's own record of the address */
  const publicHints = useRef<{ address: string; byType: Map<string, string[]> } | null>(null)

  useEffect(() => {
    if (!key) { setFound([]); return }
    let alive = true, follows = 0
    let follow: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      const net = loadEndpoints()
      const now = heldRef.current
      const byType = new Map<string, string[]>()
      const add = (type: string, hash: string) => { const t = type.toLowerCase(); const l = byType.get(t) ?? []; if (!l.includes(hash)) l.unshift(hash); byType.set(t, l) }
      try {
        for (const e of await session.txHistory()) {
          for (const u of e.unshielded?.createdUtxos ?? []) add(u.tokenType, e.hash)
          for (const c of e.shielded?.receivedCoins ?? []) add(c.type, e.hash)
        }
      } catch {}
      for (const [t, hashes] of publicHints.current?.byType ?? []) for (const h of hashes) add(t, h)
      let r = await resolveNfts(net, now, (type) => byType.get(type) ?? [])
      if (alive) setFound(r.nfts)
      // public single-unit tokens that are still unexplained: ask the indexer once per address which of the
      // address's transactions brought them in, then look again
      const address = session.snap.unshieldedAddress
      const open = now.filter((h) => h.lane === 'public' && !byType.has(h.type) && !r.nfts.some((n) => n.type === h.type))
      if (alive && address && open.length > 0 && publicHints.current?.address !== address) {
        publicHints.current = { address, byType: await publicArrivals(address, net.indexerWsUrl) }
        for (const [t, hashes] of publicHints.current.byType) for (const h of hashes) add(t, h)
        if (open.some((h) => byType.has(h.type))) {
          r = await resolveNfts(net, now, (type) => byType.get(type) ?? [])
          if (alive) setFound(r.nfts)
        }
      }
      // the pass ran out of look-ups, or the history has not caught up (a fresh install): the next one comes soon
      if (alive && r.more && follows < MAX_FOLLOWS) { follows++; clearTimeout(follow); follow = setTimeout(() => void run(), FOLLOW_MS) }
    }
    void run()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void run() }, REFRESH_MS)
    return () => { alive = false; clearInterval(t); clearTimeout(follow) }
  }, [key, session])

  // only what is still held, in the lane it is held in now
  const nfts = useMemo(() => found.flatMap((n) => { const h = held.find((x) => x.type === n.type); return h ? [{ ...n, lane: h.lane }] : [] }), [found, held])
  const toggleHidden = (type: string) => { setHidden(type, !hidden.has(type)); setHiddenState(loadHidden()) }
  return { nfts, hidden, toggleHidden }
}

/** Every public transaction that paid a token into `address`, by token type (newest first). Gives up after 19 s. */
function publicArrivals(address: string, wsUrl: string): Promise<Map<string, string[]>> {
  return new Promise((resolve) => {
    const out = new Map<string, string[]>()
    let done = false
    let latest: Parameters<Parameters<typeof watchActivity>[2]>[0] = []
    // whatever was read by then counts: the newest part comes first, older parts step by step
    const finish = () => {
      if (done) return
      done = true; clearTimeout(timer); w?.stop()
      for (const it of latest) for (const [type, delta] of it.deltas) if (delta > 0n) out.set(type, [...(out.get(type) ?? []), it.hash])
      resolve(out)
    }
    const w: ReturnType<typeof watchActivity> | undefined = watchActivity(address, wsUrl, (items, st) => {
      latest = items
      if (!st.live || st.loadingOlder) return
      if (st.more) w?.older(); else finish()
    }, finish)
    const timer = setTimeout(finish, 19_000)
  })
}

/** index of the gateway that last delivered a picture: tried first for the next one */
let goodGateway = 0

/** A picture with its fallbacks: the next gateway when one fails, the name's first letter until (or unless) one loads. */
export function NftPicture({ nft, allowWeb = false }: { nft: Nft; allowWeb?: boolean }) {
  const pic = useMemo(() => pictureOf(nft.image), [nft.image])
  const urls = useMemo(() => {
    if (!pic) return []
    if (pic.kind === 'ipfs') return [...pic.urls.slice(goodGateway), ...pic.urls.slice(0, goodGateway)]
    return pic.kind === 'inline' || allowWeb ? [pic.url] : []
  }, [pic, allowWeb])
  const [i, setI] = useState(0)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { setI(0); setLoaded(false) }, [urls])
  const src = urls[i]
  return (
    <div className="nft-pic">
      {!loaded && <span className="nft-letter">{(nft.name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()}</span>}
      {src && (
        <img
          key={src} src={src} alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" draggable={false}
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => { setLoaded(true); if (pic?.kind === 'ipfs') goodGateway = pic.urls.indexOf(src) >= 0 ? pic.urls.indexOf(src) : goodGateway }}
          onError={() => { setLoaded(false); setI((n) => n + 1) }}
        />
      )}
    </div>
  )
}

function Tile({ nft, onOpen, caption }: { nft: Nft; onOpen: (n: Nft) => void; caption: boolean }) {
  return (
    <button className="nft" onClick={() => onOpen(nft)} aria-label={nft.name}>
      <NftPicture nft={nft} />
      {caption && <span className="nft-name">{nft.name}</span>}
    </button>
  )
}

/** Home: the first few NFTs of the lane on show, and the way into the gallery. Renders nothing without NFTs. */
export function NftStrip({ nfts, onOpen, onAll }: { nfts: Nft[]; onOpen: (n: Nft) => void; onAll: () => void }) {
  if (nfts.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 11 }}>
      <button className="section-head" onClick={onAll}>
        <span>NFTs</span>
        <span className="muted">{nfts.length} ›</span>
      </button>
      <div className="nft-grid three">
        {nfts.slice(0, 3).map((n) => <Tile key={n.lane + n.type} nft={n} onOpen={onOpen} caption={false} />)}
      </div>
    </div>
  )
}

/** Gallery: both lanes, grouped by collection. Hidden NFTs sit behind a line at the bottom. */
export function Nfts({ nfts, hidden, onOpen, onBack }: { nfts: Nft[]; hidden: Set<string>; onOpen: (n: Nft) => void; onBack: () => void }) {
  const [showHidden, setShowHidden] = useState(false)
  const shown = nfts.filter((n) => showHidden || !hidden.has(n.type))
  const groups = useMemo(() => {
    const m = new Map<string, Nft[]>()
    for (const n of shown) m.set(n.contract, [...(m.get(n.contract) ?? []), n])
    return [...m.entries()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((n) => n.type).join(',')])
  const hiddenCount = nfts.filter((n) => hidden.has(n.type)).length
  return (
    <div className="screen">
      <Header title="NFTs" back={onBack} />
      {shown.length === 0 && <div className="card muted">No NFTs in this wallet yet.</div>}
      {groups.map(([contract, list]) => (
        <div key={contract} style={{ display: 'grid', gap: 9 }}>
          <div className="row spread">
            <span style={{ fontWeight: 600 }}>{list[0].collection || 'Unnamed collection'}{isChecked(contract) ? <span className="nft-check" title="Listed collection"> ✓</span> : null}</span>
            <span className="tiny">{list.length}</span>
          </div>
          <div className="nft-grid two">
            {list.map((n) => <Tile key={n.lane + n.type} nft={n} onOpen={onOpen} caption />)}
          </div>
        </div>
      ))}
      {hiddenCount > 0 && <button className="tiny" style={{ textAlign: 'center' }} onClick={() => setShowHidden((v) => !v)}>{showHidden ? 'Stop showing hidden' : `Show ${hiddenCount} hidden`}</button>}
    </div>
  )
}

const shortHex = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`

/** One NFT: picture, what the collection says about it, where it lives, and the two things to do with it. */
/**
 * `isPicture`: this NFT is the wallet's picture. `onPicture`: make it the wallet's picture, from the addresses its
 * picture can be read at (best first), or stop using it (null).
 */
export function NftDetail({ nft, isHidden, isPicture, onPicture, onSend, onToggleHidden, onBack, onToast }: { nft: Nft; isHidden: boolean; isPicture: boolean; onPicture: (urls: string[] | null) => Promise<void>; onSend: () => void; onToggleHidden: () => void; onBack: () => void; onToast: (m: string) => void }) {
  const pic = useMemo(() => pictureOf(nft.image), [nft.image])
  const [allowWeb, setAllowWeb] = useState(false)
  // where a copy of the picture can be made from: never an ordinary web address the person has not chosen to load
  const pictureUrls = !pic ? [] : pic.kind === 'ipfs' ? [...pic.urls.slice(goodGateway), ...pic.urls.slice(0, goodGateway)] : pic.kind === 'inline' || allowWeb ? [pic.url] : []
  const [setting, setSetting] = useState(false)
  const picture = async () => {
    setSetting(true)
    try { await onPicture(isPicture ? null : pictureUrls) } finally { setSetting(false) }
  }
  const copy = async (what: string, value: string) => onToast((await copyText(value)) ? `${what} copied` : 'Could not copy')
  return (
    <div className="screen">
      <Header title={nft.collection || 'NFT'} back={onBack} />
      <div className="nft-hero"><NftPicture nft={nft} allowWeb={allowWeb} /></div>
      {pic?.kind === 'web' && !allowWeb && (
        <button className="tiny" style={{ textAlign: 'center' }} onClick={() => setAllowWeb(true)}>Picture is on {new URL(pic.url).host} · tap to load</button>
      )}
      <div>
        <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: '-0.02em' }}>{nft.name}</div>
        <div className="muted">{nft.collection || 'Unnamed collection'}{isChecked(nft.contract) ? <span className="nft-check"> ✓</span> : null} · {nft.lane === 'public' ? 'Public' : 'Private'}</div>
      </div>
      {nft.description && <div className="muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{nft.description}</div>}
      <div className="card" style={{ display: 'grid', gap: 13 }}>
        <button className="row spread" onClick={() => void copy('Token id', nft.type)}>
          <span className="tiny">Token</span><span className="mono">{shortHex(nft.type)}</span>
        </button>
        <button className="row spread" onClick={() => void copy('Collection address', nft.contract)}>
          <span className="tiny">Collection</span><span className="mono">{shortHex(nft.contract)}</span>
        </button>
        {nft.origin && (
          <button className="row spread" data-origin="asset" onClick={() => void copy('Cardano asset name', nft.origin!.asset)}>
            <span className="tiny">Cardano NFT</span><span className="mono" style={{ overflowWrap: 'anywhere', textAlign: 'right' }}>{nft.origin.asset}</span>
          </button>
        )}
        {nft.origin?.policy && (
          <button className="row spread" data-origin="policy" onClick={() => void copy('Cardano policy id', nft.origin!.policy!)}>
            <span className="tiny">Cardano policy</span><span className="mono">{shortHex(nft.origin.policy)}</span>
          </button>
        )}
      </div>
      {nft.origin && <div className="tiny">This token stands for an NFT on Cardano, which is held in a vault there while the token exists.{isChecked(nft.contract) ? '' : ' That is what its contract says; this wallet has not checked the vault.'}</div>}
      {!isChecked(nft.contract) && <div className="tiny">Name and picture come from the collection's own contract. Anyone can send an NFT to an address.</div>}
      <div className="grow" />
      {(isPicture || pictureUrls.length > 0) && (
        <button className="btn ghost" data-wallet-picture={isPicture ? '1' : '0'} disabled={setting} onClick={() => void picture()}>
          {setting ? 'One moment' : isPicture ? 'Stop using as wallet picture' : 'Use as wallet picture'}
        </button>
      )}
      <div className="row">
        <button className="btn ghost" onClick={onToggleHidden}>{isHidden ? 'Unhide' : 'Hide'}</button>
        <button className="btn" onClick={onSend}>Send</button>
      </div>
    </div>
  )
}
