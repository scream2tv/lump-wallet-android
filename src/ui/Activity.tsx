import { useEffect, useRef, useState } from 'react'
import { watchActivity, type ActivityItem, type ActivityState } from '../core/activity'
import { cardanoActivity, fmtAda, fmtNight, type CardanoActivityItem } from '../core/energy'
import { loadEndpoints } from '../core/net'
import { lookupToken } from '../core/tokens'
import { fmtUnits, DUST_DECIMALS } from '../core/wallet'
import type { PriceFor } from '../core/prices'
import { Header } from './Header'
import { copyText } from './copy'
import { displayName } from '../dapp/connections'
import { listDappEntries, onDappEntries, type DappEntry } from '../dapp/log'

/** `cardano`: the wallet's Cardano address ('' when it has none). `start`: the tab it opens on (the one Home was showing). */
export function Activity({ address, cardano, start = 'public', priceFor, onBack, onToast }: { address: string; cardano: string; start?: 'public' | 'private' | 'cardano'; priceFor: PriceFor; onBack: () => void; onToast: (m: string) => void }) {
  const [lane, setLane] = useState<'public' | 'private' | 'cardano'>(start)
  // the Cardano address's transactions: read when its tab shows, and again every 37 s while it does
  const [cItems, setCItems] = useState<CardanoActivityItem[] | null>(null)
  const [cMore, setCMore] = useState(false)
  const [cErr, setCErr] = useState('')
  useEffect(() => {
    if (lane !== 'cardano' || !cardano) return
    let alive = true
    const load = async () => {
      try { const a = await cardanoActivity(cardano); if (alive) { setCItems(a.items); setCMore(a.more); setCErr('') } }
      catch (e) { if (alive) setCErr(e instanceof Error ? e.message : 'Could not load right now') }
    }
    void load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 37_000)
    return () => { alive = false; clearInterval(t) }
  }, [lane, cardano])
  const adaUsd = priceFor.key('ADA'), nightUsd = priceFor.key('NIGHT')
  const [items, setItems] = useState<ActivityItem[]>([])
  const [state, setState] = useState<ActivityState>({ live: false, more: true, loadingOlder: false })
  const [shown, setShown] = useState(PAGE)
  const older = useRef<() => void>(() => {})
  const caughtUp = state.live
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [dapp, setDapp] = useState<DappEntry[]>(listDappEntries)
  useEffect(() => onDappEntries(() => setDapp(listDappEntries())), [])

  useEffect(() => {
    if (!address) return
    const w = watchActivity(address, loadEndpoints().indexerWsUrl, (list, st) => { setItems(list); setState(st) }, setErr)
    older.current = w.older
    return w.stop
  }, [address])

  // only the newest are drawn; "Show older" draws more, then reads further back
  const groups = groupByDay(items.slice(0, shown))
  const showOlder = () => { if (shown < items.length) setShown(shown + PAGE); else { setShown(shown + PAGE); older.current() } }
  // a public entry the wallet itself sent for a site: within a few minutes of the approval, and the same token left
  const siteOf = (it: ActivityItem): string | null => {
    const e = dapp.find((d) => Math.abs(d.at - it.time) < SITE_WINDOW_MS && d.pays.some((p) => { const v = it.deltas.get(p.type); return p.lane === 'public' && v !== undefined && v < 0n && -v <= BigInt(p.value) }))
    return e ? displayName(e.origin) : null
  }
  // what the public record cannot show: something private left (an NFT put up for sale), or an offer a site completed
  const privateRows = dapp.filter((d) => d.kind === 'trade' || d.pays.some((p) => p.lane === 'private') || d.pays.length === 0).map((d) => ({ ...d, time: d.at }))
  const usd = (type: string, v: bigint) => { const m = lookupToken(type); const p = priceFor(type); return p == null ? null : Number(v) / 10 ** m.decimals * p }
  const fmtUsd = (n: number | null) => (n == null ? '' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
  const short = (a: string) => `${a.slice(0, 11)}…${a.slice(-5)}`

  return (
    <div className="screen">
      <Header title="Activity" back={onBack} />
      <div className="seg">
        <button className={lane === 'public' ? 'on' : ''} onClick={() => setLane('public')}>Public</button>
        <button className={lane === 'private' ? 'on' : ''} onClick={() => setLane('private')}>Private</button>
        <button className={lane === 'cardano' ? 'on' : ''} onClick={() => setLane('cardano')}>Cardano</button>
      </div>

      {lane === 'cardano' && <>
        {cErr && !cItems && <div className="err">{cErr}</div>}
        {!cItems && !cErr && <div className="card muted">Loading…</div>}
        {cItems && cItems.length === 0 && <div className="card muted" data-cardano-activity="0">Nothing on your Cardano address yet.</div>}
        {cItems && groupByDay(cItems).map(([day, list]) => (
          <div key={day} style={{ display: 'grid', gap: 7 }}>
            <div className="tiny" style={{ paddingLeft: 3 }}>{day}</div>
            <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }} data-cardano-activity={list.length}>
              {list.map((it) => {
                const got = it.night > 0n || (it.night === 0n && it.lovelace > 0n)
                const what = it.night !== 0n ? 'NIGHT' : it.lovelace !== 0n ? 'ADA' : 'tokens'
                const title = it.registration ? 'Registered for fee energy' : `${got ? 'Received' : 'Sent'} ${what}`
                const worth = (nightUsd == null && it.night !== 0n) || (adaUsd == null && it.lovelace !== 0n) ? null : Number(it.night) / 1e6 * (nightUsd ?? 0) + Number(it.lovelace) / 1e6 * (adaUsd ?? 0)
                const isOpen = open === it.tx
                return (
                  <div key={it.tx}>
                    <button className="token" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpen(isOpen ? null : it.tx)}>
                      <div className="logo">{it.registration ? '✓' : got ? '↓' : '↑'}</div>
                      <div className="grow">
                        <div style={{ fontWeight: 600 }}>{title}</div>
                        <div className="tiny">{new Date(it.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {it.night !== 0n && <div style={{ fontWeight: 600, color: it.night > 0n ? 'var(--good)' : undefined }}>{it.night > 0n ? '+' : '-'}{fmtNight(it.night < 0n ? -it.night : it.night)} NIGHT</div>}
                        {it.lovelace !== 0n && <div style={{ fontWeight: 600, color: it.lovelace > 0n ? 'var(--good)' : undefined }}>{it.lovelace > 0n ? '+' : '-'}{fmtAda(it.lovelace < 0n ? -it.lovelace : it.lovelace)} ADA</div>}
                        <div className="tiny">{fmtUsd(worth)}</div>
                      </div>
                    </button>
                    {isOpen && (
                      <div style={{ padding: '0 0 13px 50px', display: 'grid', gap: 5 }} className="tiny">
                        <div>{new Date(it.time).toLocaleString('en-US')} · on Cardano{it.others > 0 ? ` · ${it.others} other token${it.others === 1 ? '' : 's'}` : ''}</div>
                        {!got && <div>What left includes the network fee.</div>}
                        <button className="mono tiny" style={{ textAlign: 'left', wordBreak: 'break-all', color: 'var(--fg-2)' }} onClick={async () => onToast((await copyText(it.tx)) ? 'Transaction id copied' : 'Could not copy')}>{it.tx}</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {cItems && cMore && <div className="tiny" style={{ textAlign: 'center' }}>Older transactions are not listed.</div>}
      </>}

      {lane === 'private' && <>
        {groupByDay(privateRows).map(([day, list]) => (
          <div key={day} style={{ display: 'grid', gap: 7 }}>
            <div className="tiny" style={{ paddingLeft: 3 }}>{day}</div>
            <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
              {list.map((d) => {
                const id = `site-${d.at}`
                const isOpen = open === id
                return (
                  <div key={id}>
                    <button className="token" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpen(isOpen ? null : id)}>
                      <div className="logo">{d.kind === 'trade' ? '⇄' : '↑'}</div>
                      <div className="grow">
                        <div style={{ fontWeight: 600 }}>{displayName(d.origin)}</div>
                        <div className="tiny">{new Date(d.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {d.pays.slice(0, 2).map((p) => (
                          <div key={p.lane + p.type} style={{ fontWeight: 600 }}>{p.nft ?? `-${fmtUnits(BigInt(p.value), lookupToken(p.type).decimals)} ${lookupToken(p.type).ticker}`}</div>
                        ))}
                        {d.pays.length === 0 && <div className="muted">no tokens</div>}
                      </div>
                    </button>
                    {isOpen && (
                      <div style={{ padding: '0 0 13px 50px', display: 'grid', gap: 5 }} className="tiny">
                        <div>{new Date(d.at).toLocaleString('en-US')} · {d.kind === 'trade' ? 'offered to the site' : 'sent by this wallet'}</div>
                        {d.pays.filter((p) => p.nft).map((p) => <div key={p.type}>{p.nft} · {p.collection} · left this wallet</div>)}
                        {BigInt(d.fee) > 0n && <div>fee about {fmtUnits(BigInt(d.fee), DUST_DECIMALS, 3)} DUST</div>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        <div className="tiny">{privateRows.length === 0 ? 'Nothing sent for a site from the private side yet. ' : ''}Private transfers and receipts are not listed yet; your private balance is up to date on the home screen.</div>
      </>}

      {lane === 'public' && <>
        {err && <div className="err">{err}</div>}
        {!err && items.length === 0 && <div className="card muted">{caughtUp ? 'No public transactions yet.' : 'Loading…'}</div>}
        {items.length > 0 && !caughtUp && <div className="tiny" style={{ textAlign: 'center' }}>Checking for newer…</div>}
        {groups.map(([day, list]) => (
          <div key={day} style={{ display: 'grid', gap: 7 }}>
            <div className="tiny" style={{ paddingLeft: 3 }}>{day}</div>
            <div className="card" style={{ paddingTop: 5, paddingBottom: 5 }}>
              {list.map((it) => {
                const entries = [...it.deltas.entries()].filter(([, v]) => v !== 0n)
                const sent = entries.length > 0 && entries.every(([, v]) => v < 0n)
                const received = entries.length > 0 && entries.every(([, v]) => v > 0n)
                const main = entries.sort((a, b) => (abs(b[1]) > abs(a[1]) ? 1 : -1))[0]
                const site = it.status === 'FAILURE' ? null : siteOf(it)
                const title = site ?? (it.status === 'FAILURE' ? 'Failed' : sent ? `Sent ${lookupToken(main[0]).ticker}` : received ? `Received ${lookupToken(main[0]).ticker}` : entries.length ? 'Swapped' : 'Transaction')
                // no counterparty = minted/burned by a contract or a self-transfer; the time is more useful than a guess
                const who = it.counterparties[0] ? (sent ? `to ${short(it.counterparties[0])}` : received ? `from ${short(it.counterparties[0])}` : short(it.counterparties[0])) : ''
                const isOpen = open === it.hash
                return (
                  <div key={it.hash}>
                    <button className="token" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpen(isOpen ? null : it.hash)}>
                      <div className="logo" style={{ color: it.status === 'FAILURE' ? 'var(--bad)' : undefined }}>{it.status === 'FAILURE' ? '!' : sent ? '↑' : received ? '↓' : '⇄'}</div>
                      <div className="grow">
                        <div style={{ fontWeight: 600 }}>{title}</div>
                        <div className="tiny">{who || new Date(it.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {entries.slice(0, 2).map(([t, v]) => (
                          <div key={t} style={{ fontWeight: 600, color: v > 0n ? 'var(--good)' : undefined }}>{v > 0n ? '+' : ''}{fmtUnits(v, lookupToken(t).decimals)} {lookupToken(t).ticker}</div>
                        ))}
                        {main && <div className="tiny">{fmtUsd(usd(main[0], main[1]))}</div>}
                      </div>
                    </button>
                    {isOpen && (
                      <div style={{ padding: '0 0 13px 50px', display: 'grid', gap: 5 }} className="tiny">
                        <div>{new Date(it.time).toLocaleString('en-US')} · block {it.height.toLocaleString('en-US')} · {it.status.toLowerCase().replace('_', ' ')}</div>
                        <div>fee {it.fee > 0n && it.fee < 10n ** BigInt(DUST_DECIMALS - 4) ? '<0.0001' : fmtUnits(it.fee, DUST_DECIMALS, 4)} DUST</div>
                        <button className="mono tiny" style={{ textAlign: 'left', wordBreak: 'break-all', color: 'var(--fg-2)' }} onClick={async () => onToast((await copyText(it.hash)) ? 'Transaction hash copied' : 'Could not copy')}>{it.hash}</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {state.loadingOlder && <div className="tiny" style={{ textAlign: 'center' }}>Loading older…</div>}
        {items.length > 0 && (shown < items.length || (state.more && !state.loadingOlder)) && <button className="btn ghost" onClick={showOlder}>Show older</button>}
      </>}
    </div>
  )
}

const abs = (v: bigint) => (v < 0n ? -v : v)
/** entries drawn at first, and per "Show older" */
const PAGE = 61

/** an entry is put with the site that asked for it when it landed this soon after the approval */
const SITE_WINDOW_MS = 7 * 60_000

function groupByDay<T extends { time: number }>(items: T[]): [string, T[]][] {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const label = (t: number) => {
    const d = new Date(t); d.setHours(0, 0, 0, 0)
    const days = Math.round((today.getTime() - d.getTime()) / 86_400_000)
    return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
  }
  const out: [string, T[]][] = []
  for (const it of items) {
    const l = label(it.time)
    const last = out[out.length - 1]
    if (last && last[0] === l) last[1].push(it); else out.push([l, [it]])
  }
  return out
}
