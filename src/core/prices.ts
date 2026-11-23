// USD prices from the LumpTools Midnight market feed (NIGHT, ADA); stable tokens pinned at 1.
// Returns a lookup by token type that resolves through the token's priceKey.
import { useEffect, useState } from 'react'
import { lookupToken } from './tokens'
import { API_BASE } from './net'

// Same-origin relay (dev: Vite proxy; web and native builds: server/static.mjs) — the upstream feed has no CORS header
const FEED = `${API_BASE}api/market`

/** By token type; `key` by price name ("ADA", "NIGHT") for what is not a Midnight token: the ADA on the wallet's Cardano address. */
export type PriceFor = ((type: string) => number | null) & { key: (k: string) => number | null }

export function usePrices(): PriceFor {
  const [byKey, setByKey] = useState<Record<string, number>>({ USD: 1 })
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch(FEED, { cache: 'no-store' })
        const j = await r.json()
        if (!alive) return
        setByKey((p) => ({
          ...p,
          ...(typeof j.nightUsd === 'number' ? { NIGHT: j.nightUsd } : {}),
          ...(typeof j.adaUsd === 'number' ? { ADA: j.adaUsd } : {}),
        }))
      } catch {}
    }
    tick()
    const t = setInterval(tick, 47_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const priceFor = ((type: string) => {
    const key = lookupToken(type).priceKey
    return key && byKey[key] != null ? byKey[key] : null
  }) as PriceFor
  priceFor.key = (k) => (byKey[k] != null ? byKey[k] : null)
  return priceFor
}
