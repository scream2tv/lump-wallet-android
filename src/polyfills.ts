// Must be the first import of the app: the wallet SDK reads `Buffer` from the global scope.
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: typeof Buffer }
if (!g.Buffer) g.Buffer = Buffer

// Before anything sets a timer: a wallet left syncing in a browser window that is not in front keeps its pace.
import { installBackgroundTimers } from './core/bgTimers'
installBackgroundTimers()
