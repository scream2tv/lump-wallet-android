// The wallet's mark and the Home action icons: line icons on a 24 grid, drawn in the current text colour.
const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** The mark: a crescent, for the night the wallet keeps. */
export function Mark({ size = 23 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.6 14.1A8.6 8.6 0 1 1 9.9 3.4a.6.6 0 0 1 .75.76 6.9 6.9 0 0 0 9.19 9.19.6.6 0 0 1 .76.75z" /></svg>
}

export const IconReceive = () => <svg width="23" height="23" viewBox="0 0 24 24" {...line} aria-hidden="true"><path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></svg>
export const IconSend = () => <svg width="23" height="23" viewBox="0 0 24 24" {...line} aria-hidden="true"><path d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15" /></svg>
export const IconActivity = () => <svg width="23" height="23" viewBox="0 0 24 24" {...line} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
export const IconApps = () => <svg width="23" height="23" viewBox="0 0 24 24" {...line} aria-hidden="true"><rect x="4.5" y="4.5" width="6" height="6" rx="1.5" /><rect x="13.5" y="4.5" width="6" height="6" rx="1.5" /><rect x="4.5" y="13.5" width="6" height="6" rx="1.5" /><rect x="13.5" y="13.5" width="6" height="6" rx="1.5" /></svg>
