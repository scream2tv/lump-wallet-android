// Test helper, loaded into a dev-server page by test/dapp-hostile.mjs: draws the approval sheet for one request and
// returns what it says. Not part of the app.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Approve } from '../../src/ui/Approve'
import type { Ask } from '../../src/dapp/host'
import type { Snapshot } from '../../src/core/wallet'

export async function drawSheet(ask: Ask, snap: Partial<Snapshot>): Promise<{ text: string; flagged: boolean }> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  root.render(createElement(Approve, { ask, snap: snap as Snapshot, priceFor: () => null, nfts: [], onAnswer: () => {} }))
  await new Promise((r) => setTimeout(r, 250))
  const out = { text: el.innerText, flagged: !!el.querySelector('[data-not-mine]') }
  root.unmount()
  el.remove()
  return out
}
