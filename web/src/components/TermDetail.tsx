import { useState } from 'react'
import type { Attribute, Backlinks, Coverage, Expectation, Term } from '@tb/shared'
import { parseValueType } from '@tb/shared'
import type { TermStatus } from '../review.js'
import { BacklinkPanel } from './BacklinkHighlight.js'
import { ExpectationFields } from './CoveragePanel.js'
import { TermRef } from './TermRef.js'

/**
 * What a supersede sends: the reason, and the replacement (null retires outright).
 *
 * The replacement carries the original's `kind` rather than defaulting to functional — a
 * reworded non-functional expectation is still non-functional, and silently promoting one
 * would put it on the coverage board where it does not belong.
 */
export interface SupersedeDraft {
  note: string
  replacement: {
    kind: Expectation['kind']
    terms: string[]
    given: string
    expect: string
    contested: Array<{ kind: string; subject: string; detail: string; quote?: string }>
  } | null
}

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
  /** Live expectations, unfiltered — this picks out the ones naming this term. */
  expectations: Expectation[]
  coverage: Coverage
  onSupersede: (id: string, draft: SupersedeDraft) => void
  busy: boolean
}

export function TermDetail({
  term,
  termsByName,
  backlinks,
  known,
  onSelect,
  review,
  expectations,
  coverage,
  onSupersede,
  busy,
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

      <ExpectationSection
        term={term}
        expectations={expectations}
        coverage={coverage}
        known={known}
        onSelect={onSelect}
        onSupersede={onSupersede}
        busy={busy}
      />

      <BacklinkPanel name={term.name} backlinks={backlinks} known={known} onSelect={onSelect} />
    </article>
  )
}

/**
 * What is expected of this term, and what nobody has said yet.
 *
 * Both halves are here on purpose. The expectations answer "what must hold"; the gaps answer
 * "what has not been thought about" — and the second is the one a glossary cannot otherwise
 * tell you, because absence has no file to live in.
 */
function ExpectationSection({
  term,
  expectations,
  coverage,
  known,
  onSelect,
  onSupersede,
  busy,
}: {
  term: Term
  expectations: Expectation[]
  coverage: Coverage
  known: Set<string>
  onSelect: (name: string) => void
  onSupersede: (id: string, draft: SupersedeDraft) => void
  busy: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const mine = expectations.filter((expectation) => expectation.terms.includes(term.name))
  const gaps = coverage.gaps.filter((pair) => pair.entity === term.name || pair.action === term.name)

  if (mine.length === 0 && gaps.length === 0) return null

  return (
    <section className="detail-section">
      <h3>Expectations</h3>

      {mine.length > 0 ? (
        <ul className="expectations">
          {mine.map((expectation) => (
            <li
              key={expectation.id}
              className={`expectation kind-${expectation.kind} ${
                expectation.contested.some((clash) => clash.kind === 'contradicts')
                  ? 'expectation-contested'
                  : ''
              }`}
            >
              <div className="expectation-line">
                <code className="expectation-id">{expectation.id}</code>
                <span className="expectation-body">
                  {expectation.given && (
                    <>
                      <span className="muted">Given </span>
                      {expectation.given}
                      <span className="muted"> — </span>
                    </>
                  )}
                  {expectation.expect}
                </span>
                {expectation.kind === 'non-functional' && (
                  <span className="muted expectation-kind">non-functional</span>
                )}
                {expectation.contested.length > 0 && (
                  <span className="expectation-contested-pill" title="Recorded despite disagreeing with the specs">
                    contested
                  </span>
                )}
                <button
                  type="button"
                  className="expectation-retire"
                  disabled={busy}
                  title="This has stopped being true"
                  onClick={() => setOpenId(openId === expectation.id ? null : expectation.id)}
                >
                  {openId === expectation.id ? 'cancel' : 'supersede'}
                </button>
              </div>

              {expectation.contested.map((clash) => (
                <p key={`${clash.kind}.${clash.subject}`} className="expectation-clash">
                  <span className="check-kind">{clash.kind}</span>
                  {clash.detail}
                  {clash.quote && <q className="check-quote">{clash.quote}</q>}
                </p>
              ))}

              {openId === expectation.id && (
                <SupersedeForm
                  expectation={expectation}
                  busy={busy}
                  onSubmit={(draft) => {
                    onSupersede(expectation.id, draft)
                    setOpenId(null)
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing says what should happen to this yet.</p>
      )}

      {gaps.length > 0 && (
        <p className="muted coverage-inline">
          Uncovered:{' '}
          {gaps.map((pair, index) => {
            const other = pair.entity === term.name ? pair.action : pair.entity
            return (
              <span key={`${pair.entity}.${pair.action}`}>
                {index > 0 && ', '}
                <TermRef name={other} known={known} onSelect={onSelect} />
              </span>
            )
          })}
        </p>
      )}
    </section>
  )
}

/**
 * Retiring an expectation, with the reason made mandatory.
 *
 * The note is required and the server enforces it too, because this is the one move that can
 * turn a red check green without touching a line of code. An expectation that vanished with
 * no recorded reason is indistinguishable from one somebody deleted to make a test pass, and
 * the whole value of keeping the retired copy is that the difference stays legible.
 *
 * Replacing is the default and retiring outright is the opt-out, which is the right way round:
 * most expectations move because the wording was imprecise or a decision shifted, and both of
 * those still leave something that ought to hold. "This should never have been expected at
 * all" is the rarer claim, so it takes the extra click.
 */
function SupersedeForm({
  expectation,
  busy,
  onSubmit,
}: {
  expectation: Expectation
  busy: boolean
  onSubmit: (draft: SupersedeDraft) => void
}) {
  const [note, setNote] = useState('')
  const [replacing, setReplacing] = useState(true)

  return (
    <div className="supersede">
      <label className="supersede-note">
        <span className="muted">Why has this stopped applying?</span>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="e.g. q-004 added RecurringTask.ended, so the condition is satisfiable after all"
          disabled={busy}
        />
      </label>

      <label className="supersede-toggle">
        <input
          type="checkbox"
          checked={replacing}
          onChange={(event) => setReplacing(event.target.checked)}
          disabled={busy}
        />
        Replace it with a corrected one
      </label>

      {replacing ? (
        <ExpectationFields
          terms={expectation.terms}
          kind={expectation.kind}
          superseding={expectation.id}
          submitLabel="Supersede"
          busy={busy || note.trim() === ''}
          initialGiven={expectation.given}
          initialExpect={expectation.expect}
          onSubmit={(given, expect, contested) =>
            onSubmit({
              note: note.trim(),
              replacement: { kind: expectation.kind, terms: expectation.terms, given, expect, contested },
            })
          }
        />
      ) : (
        <button
          type="button"
          className="action"
          disabled={busy || note.trim() === ''}
          onClick={() => onSubmit({ note: note.trim(), replacement: null })}
        >
          Retire {expectation.id} without replacing it
        </button>
      )}
    </div>
  )
}
