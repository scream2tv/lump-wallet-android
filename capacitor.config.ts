import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'xyz.lumptools.wallet',
  appName: 'Lump Wallet',
  // dist/ may be the web build a wallet server is serving (base /wallet/): a local Android build goes to its own
  // folder (CAP_WEB_DIR=dist-android) so it never replaces it. CI builds straight into dist.
  webDir: process.env.CAP_WEB_DIR ?? 'dist',
  ios: { contentInset: 'never', backgroundColor: '#050507' },
  android: { backgroundColor: '#050507' },
}

export default config
