// Android: the app says so when a newer build is out (core/update.ts). One that can wait is a sheet with "Later";
// one that cannot is a screen the wallet waits behind. Mounted once (App), above every route.
import { useEffect, useState } from 'react'
import { openDownload, putOff, startUpdateWatch, useUpdate, wasPutOff, type Update } from '../core/update'
import { coverBrowser } from '../dapp/bridge'
import { Shell } from './back'

const detail = (u: Update) => [u.version && `Version ${u.version}`, `build ${u.code}`, u.size > 0 && `${(u.size / 1048576).toFixed(1)} MB`].filter(Boolean).join(' · ')

export function UpdateGate() {
  const u = useUpdate()
  const [failed, setFailed] = useState(false)
  useEffect(() => startUpdateWatch(), [])
  const show = !!u && !wasPutOff(u)
  // a site's page is a native view above this one: out of the way while the prompt is up
  useEffect(() => { coverBrowser('update', show); return () => coverBrowser('update', false) }, [show])
  if (!u || !show) return null
  const get = async () => setFailed(!(await openDownload()))

  if (u.required) return (
    <div className="cover" style={{ zIndex: 31 }} role="dialog" aria-modal="true" aria-label="Update needed">
      <div className="screen" style={{ justifyContent: 'center' }}>
        <h1 className="title" style={{ textAlign: 'center' }}>Update needed</h1>
        <p className="muted" style={{ textAlign: 'center', margin: 0 }}>This build of Lump Wallet is too old to keep using. Get the new one to continue: installing it over this app keeps your wallet.</p>
        <button className="btn" onClick={get}>Get the update</button>
        <div className="tiny" style={{ textAlign: 'center' }}>{failed ? 'Could not open the browser. Open the page you downloaded Lump Wallet from.' : detail(u)}</div>
        {/* system Back on a screen with no way back: the app goes to the background, nothing underneath is touched */}
        <button data-back style={{ display: 'none' }} onClick={() => { void Shell.minimize().catch(() => {}) }} />
      </div>
    </div>
  )
  return (
    <div className="sheet-back">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Update available">
        <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--fg-hi)' }}>Update available</div>
        <div>A newer Lump Wallet is ready. Installing it over this app keeps your wallet.</div>
        <div className="tiny">{failed ? 'Could not open the browser. Open the page you downloaded Lump Wallet from.' : detail(u)}</div>
        <button className="btn" onClick={get}>Update</button>
        <button className="btn ghost" data-back onClick={() => putOff(u)}>Later</button>
      </div>
    </div>
  )
}
