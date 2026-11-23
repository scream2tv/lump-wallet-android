// How the unlocked wallet guards itself: when it locks again, and whether moving funds asks for the person first.
// Choices of the person, kept on the device (Settings → Security).
const KEY = 'lump.lock.v1'

export type LockSettings = {
  /** minutes out of sight, or untouched, before the wallet asks for the PIN again; 0 = never */
  autoLockMin: number
  /** ask for Face ID / the PIN before a send or a site's transaction goes out */
  confirm: boolean
  /** the unlock key is kept behind Face ID / Touch ID on this device */
  bio: boolean
}
export const AUTO_LOCK_CHOICES = [1, 3, 15, 0] as const
const DEFAULTS: LockSettings = { autoLockMin: 3, confirm: true, bio: false }

export function lockSettings(): LockSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LockSettings> | null
    if (v && typeof v === 'object') return {
      autoLockMin: typeof v.autoLockMin === 'number' && v.autoLockMin >= 0 ? v.autoLockMin : DEFAULTS.autoLockMin,
      confirm: typeof v.confirm === 'boolean' ? v.confirm : DEFAULTS.confirm,
      bio: v.bio === true,
    }
  } catch { /* unreadable: the defaults */ }
  return { ...DEFAULTS }
}

const listeners = new Set<() => void>()
export const onLockSettings = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export function saveLockSettings(change: Partial<LockSettings>) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...lockSettings(), ...change })) } catch {}
  listeners.forEach((fn) => { try { fn() } catch {} })
}

export function forgetLockSettings() { try { localStorage.removeItem(KEY) } catch {} }
