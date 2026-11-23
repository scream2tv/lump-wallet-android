// What the page needs from Android itself (android/.../AppShellPlugin.java). Nothing here runs on iOS or in a web build.
//
// The system Back button: the app sends `lumpback`, and Back does what the screen's own way back does: the control
// marked `data-back` that is on top (a sheet's Cancel, a header's Back). A screen with no way back is a first-level
// screen, and there Back puts the app in the background. The in-app browser handles Back itself while a page shows.
import { Capacitor, registerPlugin } from '@capacitor/core'

export const Shell = registerPlugin<{
  ready(): Promise<void>
  minimize(): Promise<void>
  readClipboard(): Promise<{ text: string }>
  share(o: { text: string }): Promise<void>
  /** the installed build: its version name and its build number (grows with every build handed out) */
  info(): Promise<{ version: string; code: number }>
  /** an https address in the phone's own browser */
  openUrl(o: { url: string }): Promise<void>
}>('AppShell')
export const isAndroidApp = () => Capacitor.getPlatform() === 'android'

export function installSystemBack() {
  if (!isAndroidApp()) return
  window.addEventListener('lumpback', () => {
    const marked = document.querySelectorAll<HTMLButtonElement>('button[data-back]')
    const top = marked[marked.length - 1]
    if (!top) { void Shell.minimize(); return }
    // a sheet that is not ready to be answered yet keeps Back waiting with it
    if (!top.disabled) top.click()
  })
  void Shell.ready()
}
