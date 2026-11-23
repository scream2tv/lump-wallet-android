// Public-lane activity feed straight from the indexer: the `unshieldedTransactions(address)` subscription replays
// every transaction that created or spent one of the address's UTXOs, then keeps streaming new ones.
// Minimal graphql-transport-ws client over the browser WebSocket; no GraphQL library needed.
// (Private-lane history is not exposed by this SDK version yet; the UI says so.)

export type ActivityItem = {
  id: number
  hash: string
  time: number // ms epoch
  height: number
  status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'UNKNOWN'
  fee: bigint // SPECK (DUST atomic units)
  /** net change per token type for this address: + received, - sent */
  deltas: Map<string, bigint>
  /** other addresses involved (recipients when sending, senders when receiving) */
  counterparties: string[]
}

const QUERY = `subscription ($address: UnshieldedAddress!, $from: Int) {
  unshieldedTransactions(address: $address, transactionId: $from) {
    ... on UnshieldedTransaction {
      transaction {
        id hash
        block { height timestamp }
        ... on RegularTransaction { fee transactionResult { status } }
      }
      createdUtxos { owner tokenType value }
      spentUtxos { owner tokenType value }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`

type Utxo = { owner: string; tokenType: string; value: string }
type Event =
  | { transaction: { id: number; hash: string; block: { height: number; timestamp: number }; fee?: string; transactionResult?: { status: string } }; createdUtxos: Utxo[]; spentUtxos: Utxo[] }
  | { highestTransactionId: number }

export function toItem(ev: Extract<Event, { transaction: unknown }>, me: string): ActivityItem {
  const deltas = new Map<string, bigint>()
  const others = new Set<string>()
  const add = (t: string, v: bigint) => deltas.set(t, (deltas.get(t) ?? 0n) + v)
  for (const u of ev.createdUtxos) { if (u.owner === me) add(u.tokenType.toLowerCase(), BigInt(u.value)); else others.add(u.owner) }
  for (const u of ev.spentUtxos) { if (u.owner === me) add(u.tokenType.toLowerCase(), -BigInt(u.value)); else others.add(u.owner) }
  const tx = ev.transaction
  const status = (tx.transactionResult?.status ?? 'UNKNOWN') as ActivityItem['status']
  return { id: tx.id, hash: tx.hash, time: Number(tx.block.timestamp), height: tx.block.height, status, fee: BigInt(tx.fee ?? 0), deltas, counterparties: [...others] }
}

// ---- newest first, and kept on the device ----
// The indexer replays an address from a transaction id upwards, oldest first. Read from the start, a wallet with a
// long history showed its newest entry last (the test wallet: 16,520 entries, over five minutes). So:
//   - the newest part is read first: from a little below the address's highest id, which the indexer says up front;
//   - older parts are read in steps going back, each larger than the last, when the screen asks for them;
//   - the newest entries are kept on the device, so the next opening shows them at once and reads only what is new.
const KEEP = 400
/** how far below the newest the first read starts (transaction ids of the whole chain, about a day of it) */
const FIRST_SPAN = 30_000
/** each step back is this many times the last */
const SPAN_GROWTH = 4
/** the first opening keeps stepping back by itself until it has this many entries (or the address's start) */
const ENOUGH = 23
const cacheKey = (address: string) => `lump.activity.v2.${address}`
type Saved = { highest: number; floor: number; items: Array<Omit<ActivityItem, 'fee' | 'deltas'> & { fee: string; deltas: Array<[string, string]> }> }
function loadSaved(address: string): { highest: number; floor: number; items: ActivityItem[] } | null {
  try {
    const v = JSON.parse(localStorage.getItem(cacheKey(address)) ?? 'null') as Saved | null
    if (!v || !Array.isArray(v.items) || !Number.isInteger(v.highest) || !Number.isInteger(v.floor)) return null
    return { highest: v.highest, floor: v.floor, items: v.items.map((x) => ({ ...x, fee: BigInt(x.fee), deltas: new Map(x.deltas.map(([t, n]) => [t, BigInt(n)])) })) }
  } catch { return null }
}
function save(address: string, highest: number, floor: number, sorted: ActivityItem[]) {
  try {
    const kept = sorted.slice(0, KEEP)
    // what is cut off is no longer "read": the floor moves up to the oldest entry kept
    const keptFloor = kept.length < sorted.length ? Math.max(floor, Math.min(...kept.map((x) => x.id))) : floor
    const items = kept.map((x) => ({ ...x, fee: String(x.fee), deltas: [...x.deltas.entries()].map(([t, n]) => [t, String(n)] as [string, string]) }))
    localStorage.setItem(cacheKey(address), JSON.stringify({ highest, floor: keptFloor, items } satisfies Saved))
  } catch { /* no room: the next opening reads again */ }
}
/** The remembered activity of one address (its wallet is leaving the device), or of every address when none is given. */
export function forgetActivity(address?: string) { try { for (const k of Object.keys(localStorage)) if (k.startsWith('lump.activity.') && (!address || k.includes(address))) localStorage.removeItem(k) } catch {} }

export type ActivityState = {
  /** everything up to the newest transaction is in the list */
  live: boolean
  /** there may be older entries than the list holds */
  more: boolean
  /** an older part is being read now */
  loadingOlder: boolean
}

/**
 * The address's public transactions, newest first. `onUpdate` fires with the whole sorted list and where the reading
 * stands. Returns `stop` and `older` (read the next part back; does nothing while one is being read or none is left).
 * Reconnects with backoff while active.
 */
export function watchActivity(address: string, indexerWsUrl: string, onUpdate: (items: ActivityItem[], state: ActivityState) => void, onError?: (m: string) => void): { stop: () => void; older: () => void } {
  const items = new Map<string, ActivityItem>()
  const saved = loadSaved(address)
  for (const it of saved?.items ?? []) items.set(it.hash, it)
  let highestSeen = saved?.highest ?? 0
  /** every transaction of the address with an id from here up is in `items`; -1: not known yet (nothing read) */
  let floor = saved ? saved.floor : -1
  let span = FIRST_SPAN
  let live = false, loadingOlder = false, dirty = false, stopped = false
  let ws: WebSocket | null = null, oldWs: WebSocket | null = null
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | null = null

  const sorted = () => [...items.values()].sort((a, b) => b.time - a.time || b.id - a.id)
  const publish = () => {
    const list = sorted()
    // kept once the newest is in, and for every entry after: never a half-read list as if it were whole
    if (live && dirty && floor >= 0) { save(address, highestSeen, floor, list); dirty = false }
    onUpdate(list, { live, more: floor !== 0, loadingOlder })
  }
  const put = (it: ActivityItem) => { if (!items.has(it.hash)) dirty = true; items.set(it.hash, it) }
  if (items.size > 0) queueMicrotask(publish)

  /** one subscription on a socket of its own; `onEvent` returns true to end it */
  const open = (from: number | null, onEvent: (ev: Event) => boolean, onClosed: (finished: boolean) => void): WebSocket | null => {
    let sock: WebSocket
    try { sock = new WebSocket(indexerWsUrl, 'graphql-transport-ws') } catch (e: any) { onError?.(String(e?.message ?? e)); onClosed(false); return null }
    let finished = false
    sock.onopen = () => sock.send(JSON.stringify({ type: 'connection_init' }))
    sock.onmessage = (m) => {
      let msg: any
      try { msg = JSON.parse(String(m.data)) } catch { return }
      if (msg.type === 'connection_ack') sock.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: QUERY, variables: { address, from } } }))
      else if (msg.type === 'ping') sock.send(JSON.stringify({ type: 'pong' }))
      else if (msg.type === 'next') {
        const ev = msg.payload?.data?.unshieldedTransactions as Event | undefined
        if (ev && !finished && onEvent(ev)) { finished = true; try { sock.close() } catch {} }
      } else if (msg.type === 'error') onError?.(JSON.stringify(msg.payload).slice(0, 200))
    }
    sock.onclose = () => onClosed(finished)
    sock.onerror = () => { /* onclose follows */ }
    return sock
  }

  // ---- the newest part, then whatever comes in ----
  const connect = () => {
    if (stopped) return
    let known = 0
    // nothing read yet: ask without a start only to learn the highest id (the first thing the indexer says), then start near it
    const probing = floor < 0
    ws = open(probing ? null : (highestSeen > 0 ? highestSeen : floor), (ev) => {
      attempt = 0
      if ('highestTransactionId' in ev) {
        known = ev.highestTransactionId
        if (probing) { floor = Math.max(0, known - span); return true }
        if (known === 0 || highestSeen >= known) live = true
        publish()
        return false
      }
      if (probing) return false   // the replay from the address's start: not wanted, the socket is closing
      const it = toItem(ev, address)
      highestSeen = Math.max(highestSeen, it.id)
      put(it)
      if (known && highestSeen >= known) live = true
      publish()
      if (live && items.size < ENOUGH) older()
      return false
    }, (finished) => {
      if (stopped) return
      if (finished) connect()   // the probe is done: now the real read
      else retry = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempt++))
    })
  }

  // ---- one step further back ----
  function older() {
    if (stopped || loadingOlder || floor <= 0) return
    const upTo = floor
    const from = Math.max(0, floor - span)
    loadingOlder = true
    publish()
    let reached = false
    oldWs = open(from, (ev) => {
      if ('highestTransactionId' in ev) { if (ev.highestTransactionId < upTo) reached = true; return reached }
      const it = toItem(ev, address)
      if (it.id >= upTo) { reached = true; return true }   // back where the list already begins
      put(it)
      publish()
      return false
    }, () => {
      oldWs = null
      loadingOlder = false
      if (stopped) return
      if (reached) { floor = from; span *= SPAN_GROWTH; dirty = true }
      publish()
      if (reached && live && items.size < ENOUGH) older()
    })
  }

  connect()
  return {
    stop: () => { stopped = true; if (retry) clearTimeout(retry); try { ws?.close() } catch {} try { oldWs?.close() } catch {} },
    older,
  }
}
