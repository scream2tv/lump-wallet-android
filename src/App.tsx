import { useEffect, useRef, useState } from 'react'
import { hasVault, openWallet, type SessionKeys, type Unlocked } from './core/vault'
import { WalletSession, type StartOptions } from './core/wallet'
import { parseAddress } from './core/send'
import { lockSettings } from './core/lock'
import { setScope } from './core/scope'
import { browser, coverBrowser, hasInAppBrowser } from './dapp/bridge'
import { Onboarding } from './ui/Onboarding'
import { Unlock } from './ui/Unlock'
import { Home } from './ui/Home'
import { ConfirmHost } from './ui/Confirm'
import { UpdateGate } from './ui/Update'

type Route = { name: 'onboarding' } | { name: 'unlock' } | { name: 'home'; session: WalletSession; walletId: string; keys: SessionKeys }

export function App() {
  const [route, setRoute] = useState<Route>(() => (hasVault() ? { name: 'unlock' } : { name: 'onboarding' }))
  const sessionRef = useRef<WalletSession | null>(null)
  // The wallet locks itself after a while out of sight or untouched. It keeps running behind the PIN screen (the sync
  // goes on, a site's request waits), so coming back costs a PIN or a glance, not a restart.
  const [locked, setLocked] = useState(false)

  /** One of the device's wallets becomes the wallet in use: its stored data is the data read from here on, and its session starts. */
  const open = async (u: Unlocked, opts: StartOptions = {}) => {
    setScope(u.walletId)
    const session = new WalletSession()
    sessionRef.current = session
    // dev server only: lets the headless tests reach the session (stripped from production builds)
    if (import.meta.env.DEV || import.meta.env.VITE_LOCAL === '1') (window as unknown as { __lump?: unknown }).__lump = { session, parseAddress }
    setLocked(false)
    setRoute({ name: 'home', session, walletId: u.walletId, keys: u.keys })
    session.start(u.mnemonic, u.stateKey, { ...opts, walletId: u.walletId }).catch(() => {})
  }

  const leave = async (to: Route) => {
    const s = sessionRef.current
    sessionRef.current = null
    setLocked(false)
    setRoute(to)
    await s?.stop()
  }

  /**
   * Another wallet takes over. First a site's page that was open for the one in use is closed and that wallet is
   * stopped (its last save goes under its own name); only then does the other become the wallet in use. A site's
   * host asks about its own wallet by id (dapp/host.ts), so nothing still on its way reaches the next wallet.
   * `u`: that wallet, opened (a switch) or just added.
   */
  const use = async (u: Unlocked, opts: StartOptions = {}) => {
    const old = sessionRef.current
    sessionRef.current = null
    if (hasInAppBrowser()) await browser.close().catch(() => {})
    await old?.stop()
    await open(u, opts)
  }
  const switchTo = async (keys: SessionKeys, walletId: string) => use(await openWallet(keys, walletId))
  /** Settings, "Scan everything again": the wallet in use is stopped and started over from the chain's beginning. */
  const rescan = async (keys: SessionKeys, walletId: string) => use(await openWallet(keys, walletId), { rescan: true })

  // a closing tab/app gets one last save
  useEffect(() => {
    const onHide = () => { void sessionRef.current?.save() }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  // ---- auto-lock ----
  const home = route.name === 'home'
  useEffect(() => {
    if (!home) return
    let hiddenAt = 0
    let touched = Date.now()
    const limit = () => lockSettings().autoLockMin * 60_000   // read each time: Settings may change it
    const touch = () => { touched = Date.now() }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
      const ms = limit()
      if (ms > 0 && hiddenAt && Date.now() - hiddenAt >= ms) setLocked(true)
      hiddenAt = 0
      touch()
    }
    // a phone left on while it syncs (the wallet holds the screen on then) must not stay open for whoever walks by
    const idle = setInterval(() => {
      const ms = limit()
      if (ms > 0 && document.visibilityState === 'visible' && Date.now() - touched >= ms) setLocked(true)
    }, 1_000)
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    for (const e of events) window.addEventListener(e, touch, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    return () => { clearInterval(idle); for (const e of events) window.removeEventListener(e, touch); document.removeEventListener('visibilitychange', onVisibility) }
  }, [home])
  // the site's page is a native view above ours: behind the lock screen too
  useEffect(() => { coverBrowser('lock', home && locked); return () => coverBrowser('lock', false) }, [home, locked])

  // last in the page: a newer build of the app is announced above whatever is showing (Android only)
  if (route.name === 'onboarding') return <><Onboarding onDone={open} /><UpdateGate /></>
  if (route.name === 'unlock') return <><Unlock onUnlock={(u) => open(u)} onReset={() => setRoute({ name: 'onboarding' })} /><UpdateGate /></>
  const { keys } = route
  return (
    <>
      {/* kept mounted while locked: what it was doing goes on, nothing of it can be seen or touched */}
      <div style={{ display: locked ? 'none' : 'contents' }} aria-hidden={locked}>
        {/* a wallet of its own each time: nothing one wallet's screens held is shown for the next */}
        <Home key={route.walletId} session={route.session} walletId={route.walletId} keys={keys}
          onSwitch={(id) => switchTo(keys, id)}
          onAdded={(u, opts) => use(u, opts)}
          onLock={() => leave({ name: 'unlock' })}
          onRescan={() => rescan(keys, route.walletId)}
          onRemoved={(next) => (next ? switchTo(keys, next) : leave({ name: 'onboarding' }))} />
      </div>
      {locked
        ? <div className="cover"><Unlock resume onUnlock={() => setLocked(false)} onReset={() => leave({ name: 'onboarding' })} /></div>
        : <ConfirmHost />}
      <UpdateGate />
    </>
  )
}
