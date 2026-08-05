/**
 * The counts in a section heading, doubling as filters.
 *
 * Both queues grow without bound — every question ever decided, every changeset ever
 * applied — so by default a section shows only what still needs something from you, and
 * the rest is one click away. The count stays visible either way, so nothing is hidden;
 * it is just not taking up the screen.
 *
 * Defaults are per-state rather than per-category, which matters: an applied changeset
 * with no code written for it is outstanding work, not history, and stays on.
 */

export interface FilterOption {
  key: string
  label: string
  count: number
  /** Drives the colour, and reads as "how much does this want your attention". */
  tone?: 'pending' | 'open' | 'awaiting' | 'plain'
  title?: string
}

interface FilterPillsProps {
  options: FilterOption[]
  active: ReadonlySet<string>
  onToggle: (key: string) => void
}

export function FilterPills({ options, active, onToggle }: FilterPillsProps) {
  return (
    <>
      {options
        .filter((option) => option.count > 0)
        .map((option) => {
          const on = active.has(option.key)
          return (
            <button
              key={option.key}
              type="button"
              className={`pill pill-filter ${on ? `pill-${option.tone ?? 'plain'} on` : 'off'}`}
              aria-pressed={on}
              title={option.title ?? (on ? 'Hide these' : 'Show these')}
              onClick={() => onToggle(option.key)}
            >
              {option.count} {option.label}
            </button>
          )
        })}
    </>
  )
}

/** Adds or removes one key, for the `useState<Set<string>>` both panels keep. */
export function toggled(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current)
  if (!next.delete(key)) next.add(key)
  return next
}
