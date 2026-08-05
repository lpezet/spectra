import type { Term, TermType } from '@tb/shared'
import { TERM_TYPES } from '@tb/shared'

/** Substring match over name and spec text — the spec text is searchable on purpose, since
 *  "which functions mention protection?" is the question this tool exists to answer. */
export function filterTerms(terms: Term[], query: string, types: Set<TermType>): Term[] {
  const needle = query.trim().toLowerCase()

  return terms.filter((term) => {
    if (types.size > 0 && !types.has(term.type)) return false
    if (!needle) return true
    return (
      term.name.toLowerCase().includes(needle) || term.spec.toLowerCase().includes(needle)
    )
  })
}

interface SearchBarProps {
  query: string
  onQueryChange: (query: string) => void
  types: Set<TermType>
  onToggleType: (type: TermType) => void
  shown: number
  total: number
}

export function SearchBar({
  query,
  onQueryChange,
  types,
  onToggleType,
  shown,
  total,
}: SearchBarProps) {
  return (
    <div className="search">
      <input
        type="search"
        className="search-input"
        placeholder="Search name or spec…"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />

      <div className="chips">
        {TERM_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className={`chip chip-${type} ${types.has(type) ? 'chip-on' : ''}`}
            onClick={() => onToggleType(type)}
          >
            {type}
          </button>
        ))}
      </div>

      <p className="muted search-count">
        {shown === total ? `${total} terms` : `${shown} of ${total} terms`}
      </p>
    </div>
  )
}
