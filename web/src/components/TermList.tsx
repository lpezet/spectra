import type { HighlightKind, Term, TermType } from '@tb/shared'
import type { TermStatus } from '../review.js'

const TYPE_ORDER: Record<TermType, number> = {
  entity: 0,
  event: 1,
  function: 2,
  'attribute-type': 3,
}

export function sortTerms(terms: Term[]): Term[] {
  return [...terms].sort(
    (a, b) =>
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )
}

interface TermListProps {
  terms: Term[]
  selected: string | null
  connections: Map<string, HighlightKind>
  /** Set while a changeset is open: how each term is touched by the selected ops. */
  statuses?: Map<string, TermStatus>
  onSelect: (name: string) => void
}

export function TermList({ terms, selected, connections, statuses, onSelect }: TermListProps) {
  if (terms.length === 0) {
    return <p className="muted empty">No terms match.</p>
  }

  return (
    <ul className="term-list">
      {sortTerms(terms).map((term) => {
        const highlight = connections.get(term.name)
        const status = statuses?.get(term.name)
        return (
          <li key={term.name}>
            <button
              type="button"
              className={[
                'term-row',
                highlight ? `hl-${highlight}` : '',
                status ? `op-${status}` : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-current={term.name === selected}
              onClick={() => onSelect(term.name)}
            >
              <span className={`badge badge-${term.type}`}>{term.type}</span>
              <span className="term-name">{term.name}</span>
              {status && (
                <span className={`op-marker op-marker-${status}`}>
                  {status === 'add' ? '+' : status === 'remove' ? '−' : '~'}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
