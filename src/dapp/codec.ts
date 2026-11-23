// Wire format between the injected provider (provider.js) and the wallet: JSON with bigint as {$big} and bytes
// as {$b64}. Mirrors the copy inside provider.js, which must stay import-free.
export function enc(v: unknown): unknown {
  if (typeof v === 'bigint') return { $big: v.toString() }
  if (v instanceof Uint8Array) return { $b64: toB64(v) }
  if (Array.isArray(v)) return v.map(enc)
  if (v instanceof Map) return enc(Object.fromEntries(v))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = enc(x)
    return o
  }
  return v
}

export function dec(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dec)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.$big === 'string') return BigInt(o.$big)
    if (typeof o.$b64 === 'string') return fromB64(o.$b64)
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(o)) out[k] = dec(x)
    return out
  }
  return v
}

export function toB64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

export const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')

export function fromHex(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/i, '')
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('not hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
