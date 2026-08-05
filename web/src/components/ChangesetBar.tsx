/**
 * Pending changesets, presented the same way as questions: a headed section of cards that
 * expand in place. Both are things waiting on you, so they should read alike — the review
 * opens inside its card rather than as a separate panel below the list.
 *
 * The left edge is coloured differently on purpose. A question is waiting for a decision
 * only you can make; a changeset is a proposal already formed and waiting to be checked.
 * Same shape, different job.
 */
import type { ReactNode } from 'react'
import type { Changeset } from '@tb/shared'

interface ChangesetBarProps {
  changesets: Changeset[]
  /** Counts of what has already landed or been turned down; the files live under changesets/. */
  applied: number
  rejected: number
  openId: string | null
  onToggle: (changeset: Changeset) => void
  /** The review surface, rendered inside whichever card is open. */
  renderReview: (changeset: Changeset) => ReactNode
}

export function ChangesetBar({
  changesets,
  applied,
  rejected,
  openId,
  onToggle,
  renderReview,
}: ChangesetBarProps) {
  // Still worth showing the header once everything has landed — "0 pending · 4 applied"
  // says the queue is clear, where an absent section just looks like nothing happened.
  if (changesets.length === 0 && applied === 0 && rejected === 0) return null

  return (
    <section className="proposals">
      <h2>
        Proposed changes
        {changesets.length > 0 && (
          <span className="pill pill-pending">{changesets.length} pending</span>
        )}
        {applied > 0 && <span className="pill">{applied} applied</span>}
        {rejected > 0 && <span className="pill">{rejected} rejected</span>}
        {changesets.length === 0 && <span className="muted">nothing pending</span>}
      </h2>

      {changesets.map((changeset) => {
        const expanded = changeset.id === openId
        return (
          <article key={changeset.id} className="proposal">
            <button type="button" className="question-head" onClick={() => onToggle(changeset)}>
              <span className="question-id">{changeset.id}</span>
              <span className="asks">{changeset.summary}</span>
              {changeset.fromQuestion && (
                <span className="pill" title="Raised by answering a question">
                  answers {changeset.fromQuestion}
                </span>
              )}
              <span className="pill pill-pending">
                {changeset.ops.length} op{changeset.ops.length === 1 ? '' : 's'}
              </span>
            </button>

            {expanded && <div className="proposal-body">{renderReview(changeset)}</div>}
          </article>
        )
      })}
    </section>
  )
}
