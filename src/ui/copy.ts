// Clipboard with a fallback for WebViews/browsers where navigator.clipboard is unavailable or denied.
import { Shell, isAndroidApp } from './back'

/** What is on the clipboard, for a Paste button. Android's WebView cannot read it, so there the app asks the system. Throws when nothing can. */
export async function pasteText(): Promise<string> {
  try { return await navigator.clipboard.readText() } catch (e) {
    if (isAndroidApp()) return (await Shell.readClipboard()).text
    throw e
  }
}

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try { await navigator.clipboard.writeText(text); return true } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}
