// Transport between the wallet UI and the dApp page.
//  native: the DappBrowser Capacitor plugin (ios/App/App/DappBrowser.swift, and its Android twin
//          android/app/src/main/java/xyz/lumptools/wallet/DappBrowserPlugin.java) shows the dApp in a second WebView
//          below our header, injects provider.js at document start and relays its messages with the origin the
//          WebView itself reports for the sending frame.
//  dev:    test/dapp-harness.mjs drives a dApp page in Playwright with the same provider.js and calls
//          window.__lumpDapp.handleRaw(origin, raw) on the wallet page.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import providerSource from './provider.js?raw'
import type { DappHost } from './host'

export type NavState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }

interface DappBrowserPlugin {
  open(o: { url: string; top: number; script: string }): Promise<void>
  close(): Promise<void>
  setVisible(o: { visible: boolean }): Promise<void>
  setTop(o: { top: number }): Promise<void>
  navigate(o: { url: string }): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  respond(o: { origin: string; payload: string }): Promise<void>
  addListener(ev: 'request', fn: (e: { origin: string; payload: string }) => void): Promise<PluginListenerHandle>
  addListener(ev: 'nav', fn: (e: NavState) => void): Promise<PluginListenerHandle>
  addListener(ev: 'closed', fn: () => void): Promise<PluginListenerHandle>
}

const Native = registerPlugin<DappBrowserPlugin>('DappBrowser')

// the plugin ships inside our own iOS app (registered in WalletViewController), so native == available
export const hasInAppBrowser = () => Capacitor.isNativePlatform()

/** Route dApp requests to `host` for as long as the returned function is not called. */
export function attachHost(host: DappHost): () => void {
  const off: Array<() => void> = []
  if (hasInAppBrowser()) {
    const h = Native.addListener('request', (e) => {
      void host.handleRaw(e.origin, e.payload).then((payload) => Native.respond({ origin: e.origin, payload }))
    })
    off.push(() => { void h.then((x) => x.remove()) })
  }
  if (import.meta.env.DEV || import.meta.env.VITE_LOCAL === '1') {
    const w = window as unknown as { __lumpDapp?: unknown }
    w.__lumpDapp = { handleRaw: (origin: string, raw: string) => host.handleRaw(origin, raw), release: (hex: string) => host.release(hex), provider: providerSource }
    off.push(() => { delete w.__lumpDapp })
  }
  return () => off.forEach((f) => f())
}

/**
 * The site's page is a native view ABOVE the wallet's own screen. Whatever the wallet has to show in front of it (an
 * approval sheet, the PIN, the lock screen) says so here; the page is back when nothing covers it any more.
 */
const covers = new Set<string>()
export function coverBrowser(what: string, on: boolean) {
  const before = covers.size
  if (on) covers.add(what); else covers.delete(what)
  if (hasInAppBrowser() && (before === 0) !== (covers.size === 0)) void Native.setVisible({ visible: covers.size === 0 }).catch(() => {})
}

export const browser = {
  open: (url: string, top: number) => Native.open({ url, top, script: providerSource }),
  close: () => Native.close(),
  setVisible: (visible: boolean) => Native.setVisible({ visible }),
  setTop: (top: number) => Native.setTop({ top }),
  navigate: (url: string) => Native.navigate({ url }),
  back: () => Native.back(),
  forward: () => Native.forward(),
  reload: () => Native.reload(),
  onNav: (fn: (s: NavState) => void) => { const h = Native.addListener('nav', (s) => fn({ ...s, canGoForward: !!s.canGoForward })); return () => { void h.then((x) => x.remove()) } },
  onClosed: (fn: () => void) => { const h = Native.addListener('closed', fn); return () => { void h.then((x) => x.remove()) } },
}
