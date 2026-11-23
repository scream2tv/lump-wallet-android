// Known Midnight token types (full 64-hex type id -> display). Exact matches only: a look-alike id must never
// borrow a known ticker or a USD price. Unknown types show a shortened id and no price.
export type TokenMeta = { ticker: string; name: string; decimals: number; priceKey?: string }

export const KNOWN: Record<string, TokenMeta> = {
  // native NIGHT
  ['0'.repeat(64)]: { ticker: 'NIGHT', name: 'Night', decimals: 6, priceKey: 'NIGHT' },
  // registry NIGHT
  '53f68afa714ed2d2257672ad72a888fa31ee997509335140bbdf39465603d7fa': { ticker: 'NIGHT', name: 'Night', decimals: 6, priceKey: 'NIGHT' },
  // bridged NIGHT (Pulse)
  c86898510a100893539dae902e84853ba9408f0a9bd12b6364f30de185355a51: { ticker: 'wNIGHT', name: 'Night (bridged)', decimals: 6, priceKey: 'NIGHT' },
  // bridged ADA / USDC / USDM
  '1bd4af4a6dd268f92cbcd7fb4ed73eedccbe49d3ad191649f9bcd92999e2648c': { ticker: 'wADA', name: 'ADA (bridged)', decimals: 6, priceKey: 'ADA' },
  f3a9d93eb74a87c75f507e0560da8c2885f6a3130331fbb46e10622886829b96: { ticker: 'wUSDCx', name: 'USDC (bridged)', decimals: 6, priceKey: 'USD' },
  '8c2c22bc0c37fa999d0611cb5c570f587938ac5ffc8b0925143dad4c0764e94b': { ticker: 'USDM', name: 'USDM', decimals: 6, priceKey: 'USD' },
}

export function lookupToken(type: string): TokenMeta {
  const t = type.toLowerCase()
  if (KNOWN[t]) return KNOWN[t]
  return { ticker: t.slice(0, 4).toUpperCase(), name: `${t.slice(0, 8)}…${t.slice(-4)}`, decimals: 6 }
}
