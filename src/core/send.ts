// Address parsing + amount helpers for the Send flow. A Midnight address is bech32m with the lane in its
// prefix: mn_addr… (public / unshielded) or mn_shield-addr… (private / shielded). Same-lane transfers only in v1.
import { MidnightBech32m, ShieldedAddress, UnshieldedAddress, mainnet } from '@midnightntwrk/wallet-sdk/address-format'
import { bech32m } from '@scure/base'
import { Buffer } from 'buffer'

export type Lane = 'public' | 'private'
export type ParsedAddress = { lane: Lane; bech32: string; address: ShieldedAddress | UnshieldedAddress }
export type SendPhase = 'building' | 'proving' | 'submitting' | 'done'

/**
 * Same as MidnightBech32m.parse, minus the classic 90-character bech32 limit: shielded addresses are 124
 * characters and the library's own parse rejects them (its encode already disables the limit).
 */
function parseBech32(s: string): MidnightBech32m {
  const d = bech32m.decodeToBytes(s, false)
  const [prefix, type, network = mainnet] = d.prefix.split('_') as [string, string, string | typeof mainnet]
  if (prefix !== 'mn') throw new Error('not a Midnight address')
  return new MidnightBech32m(type, network, Buffer.from(d.bytes))
}

export function parseAddress(input: string): ParsedAddress | { error: string } {
  const s = input.trim()
  if (!s) return { error: '' }
  let repr: MidnightBech32m
  try { repr = parseBech32(s) } catch { return { error: 'Not a Midnight address' } }
  const net = repr.network
  if (net !== mainnet && net !== 'mainnet') return { error: 'This address is for a test network' }
  try {
    if (repr.type === 'addr') return { lane: 'public', bech32: s, address: UnshieldedAddress.codec.decode(net, repr) }
    if (repr.type === 'shield-addr') return { lane: 'private', bech32: s, address: ShieldedAddress.codec.decode(net, repr) }
  } catch { return { error: 'Not a Midnight address' } }
  if (repr.type === 'dust') return { error: 'That is a fee energy address, nothing can be sent to it' }
  return { error: 'Unsupported address type' }
}

/** "12.5" with 6 decimals -> 12500000n; null when not a valid positive amount. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const m = text.trim().replace(/,/g, '').match(/^(\d*)(?:\.(\d*))?$/)
  if (!m || (!m[1] && !m[2])) return null
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0')
  const v = BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0')
  return v > 0n ? v : null
}

/** Human-readable reason for a failed send. */
export function sendErrorMessage(e: unknown): string {
  const msg = String((e as any)?.message ?? e)
  if (/\b170\b|InvalidDustSpendProof/i.test(msg)) return 'Fee energy is not ready yet. Wait a minute and try again.'
  if (/insufficient|not enough|NotEnough/i.test(msg)) return 'Not enough balance or fee energy for this transfer.'
  if (/prov(e|ing)|proof server|6300|prove-station/i.test(msg)) return 'The prover did not answer. Check Settings → Prover, then try again.'
  if (/ttl|expired/i.test(msg)) return 'The transaction expired before it was sent. Try again.'
  return msg.length > 160 ? msg.slice(0, 157) + '…' : msg
}
