import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { browser, hasInAppBrowser, type NavState } from '../dapp/bridge'
import { HIDDEN, displayName, hasOwnName, listConnections, onConnectionsChange } from '../dapp/connections'
import { addFavorite, isFavorite, listFavorites, pageKey, removeFavorite } from '../core/favorites'
import { Header } from './Header'

const SEARCH = 'https://duckduckgo.com/?q='

/** The star: lit for a favorite. */
function Star({ on }: { on: boolean }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" /></svg>
}

// The sites' own marks (public/apps/, copies of the icons the sites serve), also shown when one of their pages turns
// up under Recent or as a connected site.
const LOGOS: Array<[RegExp, string]> = [
  [/(^|\.)lumptools\.xyz$/, 'lumptools.png'],
  [/(^|\.)lumpfun\.com$|^lumpfun-midnight\.vercel\.app$/, 'lumpfun.png'],
  [/(^|\.)midnightstation\.io$/, 'midnight-station.png'],
]
function logoOf(url: string): string | undefined {
  try { const host = new URL(url).hostname; const hit = LOGOS.find(([re]) => re.test(host)); return hit ? `${import.meta.env.BASE_URL}apps/${hit[1]}` : undefined } catch { return undefined }
}

/**
 * What was typed -> where to go: an address ("lumptools.xyz", "https://x.y/z") opens as https, anything else is
 * looked up with the search engine. Only https pages are ever opened.
 */
export function toUrl(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  if (!/\s/.test(t) && (/^https:\/\//i.test(t) || (/^[^/:]+\.[^/:.\s]{2,}(\/|:\d|$)/.test(t) && !/^[a-z][a-z0-9+.-]*:/i.test(t)))) {
    try {
      const u = new URL(/^https:\/\//i.test(t) ? t : `https://${t}`)
      if (u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password) return u.href
    } catch {}
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null   // http://, ftp://, custom schemes: not opened
  return SEARCH + encodeURIComponent(t)
}

const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }

// ---- recently opened sites (this device only; cleared with the wallet) ----
type Recent = { url: string; title: string; at: number }
const RECENT_KEY = 'lump.browser.recent.v1', RECENT_MAX = 7
const loadRecent = (): Recent[] => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((r) => r && typeof r.url === 'string') : [] } catch { return [] } }
function remember(url: string, title: string) {
  let origin: string
  try { const u = new URL(url); if (u.protocol !== 'https:' || url.startsWith(SEARCH)) return; origin = u.origin } catch { return }
  const rest = loadRecent().filter((r) => { try { return new URL(r.url).origin !== origin } catch { return false } })
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([{ url, title: title.slice(0, 80), at: Date.now() }, ...rest].slice(0, RECENT_MAX))) } catch {}
}
export function forgetBrowsing() { try { localStorage.removeItem(RECENT_KEY) } catch {} }

/**
 * One row of a site list. Module-level: a stable component type across renders.
 * `side`: a button of its own at the right end (a star to add the site, a cross to remove it) instead of the arrow.
 */
function SiteRow({ name, hint, accent, logo, onOpen, side }: { name: string; hint: string; accent?: boolean; logo?: string; onOpen: () => void; side?: { label: string; icon: React.ReactNode; onTap: () => void } }) {
  const body = (
    <>
      {logo
        ? <img className="logo site" src={logo} alt="" />
        : <div className={accent ? 'logo brand' : 'logo'}>{(name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()}</div>}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
        {hint && <div className="tiny" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</div>}
      </div>
    </>
  )
  if (!side) return <button className="token" style={{ width: '100%', textAlign: 'left' }} onClick={onOpen}>{body}<span className="muted">›</span></button>
  return (
    <div className="token" style={{ width: '100%' }}>
      <button style={{ display: 'flex', alignItems: 'center', gap: 13, flex: 1, minWidth: 0, textAlign: 'left' }} onClick={onOpen}>{body}</button>
      <button className="icon-btn" aria-label={side.label} title={side.label} onClick={side.onTap}>{side.icon}</button>
    </div>
  )
}

/**
 * Apps: an address bar, our own sites, recent and connected sites. A site opens in the in-app browser below our own
 * top bar (the app), where it can ask this wallet to connect; in a plain web build it opens in the device's browser.
 */
export function Apps({ onBack, onToast }: { onBack: () => void; onToast: (m: string) => void }) {
  const [text, setText] = useState('')
  const [nav, setNav] = useState<NavState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [conns, setConns] = useState(listConnections)
  const [recent, setRecent] = useState(loadRecent)
  // the person's favorite sites (our own to begin with), and whether the list is being edited
  const [favs, setFavs] = useState(listFavorites)
  const [editFavs, setEditFavs] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  useEffect(() => onConnectionsChange(() => setConns(listConnections())), [])

  // nav events + the native view closing itself; leaving this screen closes the browser
  useEffect(() => {
    if (!hasInAppBrowser()) return
    const offNav = browser.onNav((s) => {
      setNav(s)
      if (!s.loading && s.url) { remember(s.url, s.title); setRecent(loadRecent()) }
    })
    const offClosed = browser.onClosed(() => { setNav(null); setEditing(null) })
    return () => { offNav(); offClosed(); void browser.close() }
  }, [])

  const open = (url: string) => {
    if (hasInAppBrowser()) { setNav({ url, title: '', loading: true, canGoBack: false, canGoForward: false }); return }
    // a web build has no browser of its own: hand the page to the device's browser (no wallet connection there)
    remember(url, ''); setRecent(loadRecent())
    window.open(url, '_blank', 'noopener,noreferrer')
    onToast('Opened in your browser · connecting needs the app')
  }

  // the dApp view sits right under the bar; the bar's height depends on the safe area, so measure it
  const browsing = nav != null
  useLayoutEffect(() => {
    if (!browsing || !barRef.current || !nav) return
    void browser.open(nav.url, Math.ceil(barRef.current.getBoundingClientRect().bottom))
    // opened once per browsing session; later navigation comes from the page itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsing])

  if (nav) {
    const goTo = () => {
      const u = toUrl(editing ?? '')
      if (!u) { onToast('Only https sites open here'); return }
      setEditing(null)
      void browser.navigate(u)
    }
    return (
      <div className="browser-bar" ref={barRef}>
        <button className="icon-btn" aria-label="Close" onClick={() => { void browser.close(); setNav(null); setEditing(null) }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        {editing == null ? (
          <>
            <button className="icon-btn" aria-label="Back" disabled={!nav.canGoBack} style={{ opacity: nav.canGoBack ? 1 : 0.3 }} onClick={() => void browser.back()}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
            </button>
            <button className="icon-btn" aria-label="Forward" disabled={!nav.canGoForward} style={{ opacity: nav.canGoForward ? 1 : 0.3 }} onClick={() => void browser.forward()}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
            </button>
            <button className="grow browser-title" aria-label="Edit address" onClick={() => setEditing(nav.url)}>
              <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nav.title || hostOf(nav.url)}</div>
              <div className="tiny" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {nav.url.startsWith('https:') ? '🔒 ' : ''}{hostOf(nav.url)}{nav.loading ? ' · loading' : ''}
              </div>
            </button>
            {/* the star: this page is a favorite, or becomes one */}
            {(() => {
              const can = !!pageKey(nav.url) && !nav.url.startsWith(SEARCH), on = can && isFavorite(nav.url)
              return (
                <button className="icon-btn" data-fav={on ? '1' : '0'} aria-label={on ? 'Remove from favorites' : 'Add to favorites'} disabled={!can} style={{ opacity: can ? 1 : 0.3, color: on ? 'var(--sky)' : undefined }}
                  onClick={() => setFavs(on ? removeFavorite(nav.url) : addFavorite(nav.url, hasOwnName(new URL(nav.url).origin) ? displayName(new URL(nav.url).origin) : nav.title))}>
                  <Star on={on} />
                </button>
              )
            })()}
            <button className="icon-btn" aria-label="Reload" onClick={() => void browser.reload()}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
            </button>
          </>
        ) : (
          <form className="grow" style={{ display: 'flex', gap: 7, minWidth: 0 }} onSubmit={(e) => { e.preventDefault(); goTo() }}>
            <input className="browser-address" autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onFocus={(e) => e.currentTarget.select()} placeholder="Search or enter address" inputMode="url" enterKeyHint="go" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            <button type="button" className="muted" style={{ fontWeight: 600, padding: '0 7px' }} onClick={() => setEditing(null)}>Cancel</button>
          </form>
        )}
      </div>
    )
  }

  const go = () => { const u = toUrl(text); if (!u) { onToast('Only https sites open here'); return } open(u) }
  // a site that is a favorite is listed there, and not again under Recent or as a connected site
  const featuredOrigins = new Set(favs.map((a) => new URL(a.url).origin))
  const isConnected = (origin: string) => conns.some((c) => c.origin === origin)
  const recents = recent.filter((r) => { try { const o = new URL(r.url).origin; return !featuredOrigins.has(o) && !HIDDEN.has(o) } catch { return false } })
  const cross = <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
  const recentOrigins = new Set(recents.map((r) => new URL(r.url).origin))
  const otherConns = conns.filter((c) => !featuredOrigins.has(c.origin) && !recentOrigins.has(c.origin) && !HIDDEN.has(c.origin))
  // a site with a name of its own shows that name and never its address
  const recentRow = (r: Recent) => {
    const o = new URL(r.url).origin, on = isConnected(o)
    return hasOwnName(o)
      ? { name: displayName(o), hint: on ? 'Connected' : '' }
      : { name: r.title || hostOf(r.url), hint: `${on ? 'Connected · ' : ''}${hostOf(r.url)}` }
  }
  return (
    <div className="screen">
      <Header title="Apps" back={onBack} />
      <form onSubmit={(e) => { e.preventDefault(); go() }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search or enter address" inputMode="url" enterKeyHint="go" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </form>
      <div style={{ display: 'grid', gap: 7 }} data-favorites={favs.length}>
        <div className="row spread">
          <span className="tiny">Favorites</span>
          {(favs.length > 0 || editFavs) && <button className="tiny" onClick={() => setEditFavs(!editFavs)}>{editFavs ? 'Done' : 'Edit'}</button>}
        </div>
        {favs.length > 0
          ? <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
              {favs.map((a) => {
                const on = isConnected(new URL(a.url).origin)
                return <SiteRow key={a.url} name={a.name} accent logo={logoOf(a.url)} hint={`${on ? 'Connected · ' : ''}${a.hint ?? hostOf(a.url)}`} onOpen={() => { if (!editFavs) open(a.url) }}
                  side={editFavs ? { label: `Remove ${a.name}`, icon: cross, onTap: () => setFavs(removeFavorite(a.url)) } : undefined} />
              })}
            </div>
          : <div className="tiny">None. Open a site and tap the star at the top to keep it here.</div>}
      </div>
      {recents.length > 0 && (
        <div style={{ display: 'grid', gap: 7 }}>
          <div className="row spread">
            <span className="tiny">Recent</span>
            <button className="tiny" onClick={() => { forgetBrowsing(); setRecent([]) }}>Clear</button>
          </div>
          <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
            {recents.map((r) => <SiteRow key={r.url} {...recentRow(r)} logo={logoOf(r.url)} onOpen={() => open(r.url)}
              side={{ label: 'Add to favorites', icon: <Star on={false} />, onTap: () => setFavs(addFavorite(r.url, recentRow(r).name)) }} />)}
          </div>
        </div>
      )}
      {otherConns.length > 0 && (
        <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
          {otherConns.map((c) => <SiteRow key={c.origin} name={displayName(c.origin)} logo={logoOf(c.origin)} hint="Connected" onOpen={() => open(c.origin)} />)}
        </div>
      )}
      <div className="tiny">Sites can see your addresses and balances once you connect. Every transaction asks you first.</div>
    </div>
  )
}
