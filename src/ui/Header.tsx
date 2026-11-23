/** Sub-screen header: back · title · spacer. Module-level so it is a stable component type across renders. */
export function Header({ title, back }: { title: string; back: () => void }) {
  return (
    <div className="row spread">
      <button className="muted" data-back onClick={back}>‹ Back</button>
      <span style={{ fontWeight: 600, color: 'var(--fg-hi)' }}>{title}</span>
      <span style={{ width: 47 }} />
    </div>
  )
}
