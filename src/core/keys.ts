// Seed phrase -> the three Midnight role seeds (shielded, DUST, unshielded). Same derivation as the wallet SDK's own tooling and as
// this wallet before ledger 9: BIP39 seed -> HD account 0 -> key 0 of the Zswap, Dust and NightExternal roles.
// The wallet SDK turns the seeds into keys for whichever ledger version the chain is on. Secrets stay in memory only.
import { WalletSeeds } from '@midnightntwrk/wallet-sdk/hd'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

export type { WalletSeeds }

export const newMnemonic = () => generateMnemonic(wordlist, 256)
export const isValidMnemonic = (m: string) => validateMnemonic(normalize(m), wordlist)
export const normalize = (m: string) => m.trim().toLowerCase().split(/\s+/).join(' ')
export const wordHints = (prefix: string) => (prefix ? wordlist.filter((w) => w.startsWith(prefix)).slice(0, 5) : [])

export function seedsFromMnemonic(mnemonic: string): WalletSeeds {
  const seed = mnemonicToSeedSync(normalize(mnemonic))
  try { return WalletSeeds.fromMasterSeed(seed) } finally { seed.fill(0) }
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
