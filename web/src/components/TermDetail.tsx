import type { Attribute, Backlinks, Term } from '@tb/shared'
import { parseValueType } from '@tb/shared'
import type { TermStatus } from '../review.js'
import { BacklinkPanel } from './BacklinkHighlight.js'
import { TermRef } from './TermRef.js'

/** Walks `parent` up to the root, guarding against a cycle a hand-edit could introduce. */
export function ancestorsOf(term: Term, termsByName: Map<string, Term>): Term[] {
  const chain: Term[] = []
  const seen = new Set<string>([term.name])
  let current = term.parent ? termsByName.get(term.parent) : undefined

  while (current && !seen.has(current.name)) {
    chain.push(current)
    seen.add(current.name)
    current = current.parent ? termsByName.get(current.parent) : undefined
  }
  return chain
}

interface AttributeRow {
  attribute: Attribute
  /** Inherited from this ancestor, if any. */
  source?: string
  /** Set only while reviewing a changeset. */
  status?: 'add' | 'remove'
}

function ValueType({
  attribute,
  known,
  onSelect,
}: {
  attribute: Attribute
  known: Set<string>
  onSelect: (name: string) => void
}) {
  const parsed = parseValueType(attribute.valueType)

  if (parsed?.kind === 'ref') {
    return (
      <>
        <TermRef name={parsed.name} known={known} onSelect={onSelect} />
        {parsed.array && <span className="muted">[]</span>}
      </>
    )
  }
  return <code className={parsed ? '' : 'invalid'}>{attribute.valueType}</code>
}

interface TermDetailProps {
  term: Term
  termsByName: Map<string, Term>
  backlinks: Backlinks
  known: Set<string>
  onSelect: (name: string) => void
  /** Present while a changeset is open and touches this term. `previous` is null for a new term. */
  review?: { previous: Term | null; status: TermStatus }
}

export function TermDetail({
  term,
  termsByName,
  backlinks,
  known,
  onSelect,
  review,
}: TermDetailProps) {
  const ancestors = ancestorsOf(term, termsByName)
  const outgoing = backlinks.bySource[term.name] ?? []
  const broken = outgoing.filter((reference) => !known.has(reference.to))

  const previous = review?.previous ?? null
  // A removed term is rendered from its old state, so nothing inside it counts as changed.
  const diffing = review !== undefined && review.status !== 'remove'
  const previousAttributes = new Set((previous?.attributes ?? []).map((a) => a.name))

  const rows: AttributeRow[] = term.attributes.map((attribute) => ({
    attribute,
    status: diffing && !previousAttributes.has(attribute.name) ? 'add' : undefined,
  }))
  if (diffing && previous) {
    for (const attribute of previous.attributes) {
      if (!term.attributes.some((current) => current.name === attribute.name)) {
        rows.push({ attribute, status: 'remove' })
      }
    }
  }
  for (const ancestor of ancestors) {
    for (const attribute of ancestor.attributes) {
      rows.push({ attribute, source: ancestor.name })
    }
  }

  const specChanged = diffing && previous !== null && previous.spec !== term.spec

  return (
    <article className={`detail ${review ? `diff-${review.status}` : ''}`}>
      <header className="detail-header">
        <span className={`badge badge-${term.type}`}>{term.type}</span>
        <h2>{term.name}</h2>
        {review && (
          <span className={`status-pill op-marker-${review.status}`}>
            {review.status === 'add'
              ? 'added by this change'
              : review.status === 'remove'
                ? 'removed by this change'
                : 'modified by this change'}
          </span>
        )}
      </header>

      {specChanged && <p className="spec spec-old">{previous!.spec}</p>}
      <p className={`spec ${specChanged ? 'spec-new' : ''}`}>
        {term.spec || <span className="muted">No spec written yet.</span>}
      </p>

      {term.tags.length > 0 && (
        <div className="tags">
          {term.tags.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      {broken.length > 0 && (
        <ul className="problems">
          {broken.map((reference) => (
            <li key={reference.via ?? 'parent'}>
              {reference.kind === 'parent' ? 'parent' : `attribute ${reference.via}`} points at{' '}
              <code>{reference.to}</code>, which no term declares.
            </li>
          ))}
        </ul>
      )}

      {term.parent && (
        <section className="detail-section">
          <h3>Is-a</h3>
          <p className="chain">
            {[term.parent, ...ancestors.slice(1).map((ancestor) => ancestor.name)].map(
              (name, index) => (
                <span key={name}>
                  {index > 0 && <span className="muted"> → </span>}
                  <TermRef name={name} known={known} onSelect={onSelect} />
                </span>
              ),
            )}
          </p>
        </section>
      )}

      <section className="detail-section">
        <h3>Attributes</h3>
        {rows.length > 0 ? (
          <table className="attributes">
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.source ?? ''}.${row.attribute.name}.${row.status ?? ''}`}
                  className={[row.source ? 'inherited' : '', row.status ? `op-${row.status}` : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <td>
                    <code>{row.attribute.name}</code>
                    {row.attribute.optional && (
                      <span className="muted" title="optional">
                        ?
                      </span>
                    )}
                  </td>
                  <td>
                    <ValueType attribute={row.attribute} known={known} onSelect={onSelect} />
                  </td>
                  <td className="muted">
                    {row.attribute.default !== undefined && (
                      <>= {JSON.stringify(row.attribute.default)}</>
                    )}
                  </td>
                  <td className="muted">
                    {row.source && <>from {row.source}</>}
                    {row.status === 'add' && <span className="op-marker-add">added</span>}
                    {row.status === 'remove' && <span className="op-marker-remove">removed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">None.</p>
        )}
      </section>

      <BacklinkPanel name={term.name} backlinks={backlinks} known={known} onSelect={onSelect} />
    </article>
  )
}
