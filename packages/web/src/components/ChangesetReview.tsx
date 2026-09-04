import type { Changeset, Diagnostic } from '@spectra/core'
import { opKindClass, summarizeOp } from '@spectra/core'
import type { Review } from '../review.js'

function Diagnostics({ items }: { items: Diagnostic[] }) {
  if (items.length === 0) return null
  return (
    <ul className="diagnostics">
      {items.map((item, index) => (
        <li key={index} className={`diagnostic diagnostic-${item.severity}`}>
          {item.severity === 'error' ? '✕' : '⚠'} {item.message}
        </li>
      ))}
    </ul>
  )
}

interface ChangesetReviewProps {
  changeset: Changeset
  review: Review
  selectedOps: ReadonlySet<number>
  onToggleOp: (index: number) => void
  onSetAllOps: (selected: boolean) => void
  onSelectTerm: (name: string) => void
  onClose: () => void
  acknowledged: boolean
  onAcknowledge: (acknowledged: boolean) => void
  onApply: () => void
  onReject: () => void
  busy: boolean
}

/**
 * The review surface for one proposed change. Ops are individually selectable and the
 * whole thing re-validates on every toggle, so a cherry-pick that breaks the glossary
 * says so the moment you make it rather than at apply time.
 */
export function ChangesetReview({
  changeset,
  review,
  selectedOps,
  onToggleOp,
  onSetAllOps,
  onSelectTerm,
  onClose,
  acknowledged,
  onAcknowledge,
  onApply,
  onReject,
  busy,
}: ChangesetReviewProps) {
  const total = changeset.ops.length
  const partial = selectedOps.size > 0 && selectedOps.size < total
  const warnings = review.overall.filter((diagnostic) => diagnostic.severity === 'warning')
  const blocked =
    busy ||
    selectedOps.size === 0 ||
    review.hasErrors ||
    (warnings.length > 0 && !acknowledged)

  return (
    <section className="changeset">
      <header className="changeset-header">
        <code className="changeset-id">{changeset.id}</code>
        <h2>{changeset.summary}</h2>
        {changeset.fromQuestion && (
          <span className="pill" title="Minted by answering a question">
            answers {changeset.fromQuestion}
          </span>
        )}
        <button type="button" className="close" onClick={onClose} aria-label="Close review">
          ×
        </button>
      </header>

      <div className="changeset-toolbar">
        <button type="button" className="chip" onClick={() => onSetAllOps(true)}>
          all
        </button>
        <button type="button" className="chip" onClick={() => onSetAllOps(false)}>
          none
        </button>
        <span className="muted">
          {selectedOps.size} of {total} ops selected
          {partial && <span className="cherry"> · cherry-pick</span>}
        </span>
      </div>

      <ol className="op-list">
        {changeset.ops.map((op, index) => {
          const checked = selectedOps.has(index)
          const kind = opKindClass(op)
          return (
            <li key={index} className={`op op-${kind} ${checked ? '' : 'op-off'}`}>
              <label className="op-row">
                <input type="checkbox" checked={checked} onChange={() => onToggleOp(index)} />
                <span className={`op-marker op-marker-${kind}`} aria-hidden="true">
                  {kind === 'add' ? '+' : kind === 'remove' ? '−' : '~'}
                </span>
                <span className="op-summary">{summarizeOp(op)}</span>
                <button
                  type="button"
                  className="term-ref op-target"
                  onClick={(event) => {
                    event.preventDefault()
                    onSelectTerm(op.term)
                  }}
                >
                  {op.term}
                </button>
              </label>
              {checked && <Diagnostics items={review.diagnosticsByOp.get(index) ?? []} />}
            </li>
          )
        })}
      </ol>

      <Diagnostics items={review.overall} />

      {changeset.tests.length > 0 && (
        <section className="detail-section">
          <h3>Tests this change should satisfy</h3>
          <ul className="test-list">
            {changeset.tests.map((test) => (
              <li key={test}>{test}</li>
            ))}
          </ul>
        </section>
      )}

      <footer className="changeset-actions">
        {warnings.length > 0 && (
          <label className="acknowledge">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => onAcknowledge(event.target.checked)}
            />
            I understand this leaves {warnings.length} reference
            {warnings.length === 1 ? '' : 's'} pointing at something that no longer exists.
          </label>
        )}

        <button type="button" className="action action-apply" disabled={blocked} onClick={onApply}>
          {partial ? `Apply ${selectedOps.size} of ${total} ops` : 'Apply'}
        </button>
        <button type="button" className="action" disabled={busy} onClick={onReject}>
          Reject
        </button>

        {review.hasErrors && (
          <span className="muted">Fix the errors above before applying.</span>
        )}
      </footer>
    </section>
  )
}
