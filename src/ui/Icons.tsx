// The wallet's mark, and the Home action icons: line icons on a 24 grid, drawn in the current text colour.
const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/**
 * The mark: a deep-sea angler with its light, for the dark the wallet works in. In its own colours, on a 96 grid
 * (the drawing takes x 16..80, y 12..82); the same drawing is the app icon and the icon a site sees.
 */
export function Mark({ size = 31 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      <path d="M45 37V24.5a10.5 10.5 0 0 1 21 0V26" fill="none" stroke="#5D79FF" strokeWidth="4.2" strokeLinecap="round" />
      <circle cx="66.5" cy="28.5" r="6.2" fill="#FFFFFF" />
      <ellipse cx="48" cy="56" rx="25" ry="24" fill="#2B49FF" />
      <circle cx="27" cy="65" r="11" fill="#2B49FF" />
      <circle cx="69" cy="65" r="11" fill="#2B49FF" />
      <ellipse cx="48" cy="68" rx="22" ry="14" fill="#2B49FF" />
      <circle cx="37" cy="52" r="7" fill="#FFFFFF" />
      <circle cx="59" cy="52" r="7" fill="#FFFFFF" />
      <circle cx="37" cy="52" r="3.4" fill="#0C0E13" />
      <circle cx="59" cy="52" r="3.4" fill="#0C0E13" />
      <path d="M34 66.9 37 61.2 40 69.1ZM41.4 69.8 44.4 63.1 47.2 70.3ZM48.8 70.3 51.6 63.1 54.6 69.8ZM56 69.1 59 61.2 62 66.9Z" fill="#FFFFFF" />
      <path d="M27.5 62.5Q48 78 68.5 62.5" fill="none" stroke="#0C0E13" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

export const IconReceive = () => <svg width="23" height="23" viewBox="0 0 24 24" {...line} aria-hidden="true"><path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></svg>
export const IconSend = () => <svg width="23" height="23" viewBox="0 0 24 24" {...line} aria-hidden="true"><path d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15" /></svg>
export const IconActivity = () => <svg width="23" height="23" viewBox="0 0 24 24" {...line} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
export const IconApps = () => <svg width="23" height="23" viewBox="0 0 24 24" {...line} aria-hidden="true"><rect x="4.5" y="4.5" width="6" height="6" rx="1.5" /><rect x="13.5" y="4.5" width="6" height="6" rx="1.5" /><rect x="4.5" y="13.5" width="6" height="6" rx="1.5" /><rect x="13.5" y="13.5" width="6" height="6" rx="1.5" /></svg>
