import type { Backlinks, Reference } from '@tb/shared'
import { TermRef } from './TermRef.js'

const LEGEND: Array<[string, string]> = [
  ['selected', 'selected'],
  ['parent', 'is-a (up)'],
  ['child', 'subtype'],
  ['referrer', 'references it'],
  ['referenced', 'it references'],
]

export function HighlightLegend() {
  return (
    <div className="legend">
      {LEGEND.map(([kind, label]) => (
        <span key={kind} className={`legend-item hl-${kind}`}>
          {label}
        </span>
      ))}
    </div>
  )
}

function describe(reference: Reference): string {
  if (reference.kind === 'parent') return 'is-a'
  return `${reference.via}${reference.array ? '[]' : ''}`
}

interface BacklinkPanelProps {
  name: string
  backlinks: Backlinks
  known: Set<string>
  onSelect: (name: string) => void
}

/**
 * The whole "what touches this term" view — subtypes plus everything pointing at it,
 * grouped by *how* it points. This is the stand-in for a Blueprint's incoming wires.
 */
export function BacklinkPanel({ name, backlinks, known, onSelect }: BacklinkPanelProps) {
  const children = backlinks.children[name] ?? []
  const referrers = (backlinks.byTarget[name] ?? []).filter(
    (reference) => reference.kind === 'attribute',
  )

  if (children.length === 0 && referrers.length === 0) {
    return (
      <section className="detail-section">
        <h3>Referenced by</h3>
        <p className="muted">Nothing references {name} yet.</p>
      </section>
    )
  }

  return (
    <>
      {children.length > 0 && (
        <section className="detail-section">
          <h3>Subtypes</h3>
          <ul className="ref-list">
            {children.map((child) => (
              <li key={child}>
                <TermRef name={child} known={known} onSelect={onSelect} />
                <span className="muted"> is-a {name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {referrers.length > 0 && (
        <section className="detail-section">
          <h3>Referenced by</h3>
          <ul className="ref-list">
            {referrers.map((reference) => (
              <li key={`${reference.from}.${reference.via}`}>
                <TermRef name={reference.from} known={known} onSelect={onSelect} />
                <span className="muted"> via </span>
                <code>{describe(reference)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
