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
  openId: string | null
  onToggle: (changeset: Changeset) => void
  /** The review surface, rendered inside whichever card is open. */
  renderReview: (changeset: Changeset) => ReactNode
}

export function ChangesetBar({ changesets, openId, onToggle, renderReview }: ChangesetBarProps) {
  if (changesets.length === 0) return null

  return (
    <section className="proposals">
      <h2>
        Proposed changes
        <span className="pill pill-pending">{changesets.length} pending</span>
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
