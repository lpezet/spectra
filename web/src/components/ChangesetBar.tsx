/**
 * Pending changesets, presented the same way as questions: a headed section of cards that
 * expand in place. Both are things waiting on you, so they should read alike — the review
 * opens inside its card rather than as a separate panel below the list.
 *
 * Resolved changesets stay visible below, the way answered questions do. They are not
 * only history: a change that landed in the glossary with no code written for it is still
 * outstanding work, and hiding it behind a count is how that gets forgotten.
 *
 * The left edge is coloured differently on purpose. A question is waiting for a decision
 * only you can make; a changeset is a proposal already formed and waiting to be checked.
 * Same shape, different job.
 */
import type { ReactNode } from 'react'
import type { Changeset } from '@tb/shared'
import { summarizeOp } from '@tb/shared'

interface ChangesetBarProps {
  changesets: Changeset[]
  applied: Changeset[]
  rejected: Changeset[]
  openId: string | null
  onToggle: (changeset: Changeset) => void
  /** Records that the implementation pass has been run for this change. */
  onImplemented: (id: string) => void
  busy: boolean
  /** The review surface, rendered inside whichever pending card is open. */
  renderReview: (changeset: Changeset) => ReactNode
}

/** Applied, but nothing has been built from it yet. */
function awaitingImplementation(changeset: Changeset): boolean {
  return changeset.implementedAt === null
}

export function ChangesetBar({
  changesets,
  applied,
  rejected,
  openId,
  onToggle,
  onImplemented,
  busy,
  renderReview,
}: ChangesetBarProps) {
  const resolved = [...applied, ...rejected]
  if (changesets.length === 0 && resolved.length === 0) return null

  const awaiting = applied.filter(awaitingImplementation).length

  return (
    <section className="proposals">
      <h2>
        Proposed changes
        {changesets.length > 0 && (
          <span className="pill pill-pending">{changesets.length} pending</span>
        )}
        {applied.length > 0 && <span className="pill">{applied.length} applied</span>}
        {rejected.length > 0 && <span className="pill">{rejected.length} rejected</span>}
        {awaiting > 0 && (
          <span className="pill pill-awaiting" title="Applied to the glossary, but no code written for it yet">
            {awaiting} awaiting implementation
          </span>
        )}
        {changesets.length === 0 && <span className="muted">nothing pending</span>}
      </h2>

      {changesets.map((changeset) => (
        <article key={changeset.id} className="proposal">
          <button type="button" className="question-head" onClick={() => onToggle(changeset)}>
            <Head changeset={changeset} />
            <span className="pill pill-pending">
              {changeset.ops.length} op{changeset.ops.length === 1 ? '' : 's'}
            </span>
          </button>

          {changeset.id === openId && <div className="proposal-body">{renderReview(changeset)}</div>}
        </article>
      ))}

      {resolved.map((changeset, index) => (
        <ResolvedCard
          key={`${changeset.id}-${changeset.appliedAt ?? index}`}
          changeset={changeset}
          rejected={rejected.includes(changeset)}
          onImplemented={onImplemented}
          busy={busy}
        />
      ))}
    </section>
  )
}

function Head({ changeset }: { changeset: Changeset }) {
  return (
    <>
      <span className="question-id">{changeset.id}</span>
      <span className="asks">{changeset.summary}</span>
      {changeset.fromQuestion && (
        <span className="pill" title="Raised by answering a question">
          answers {changeset.fromQuestion}
        </span>
      )}
    </>
  )
}

function ResolvedCard({
  changeset,
  rejected,
  onImplemented,
  busy,
}: {
  changeset: Changeset
  rejected: boolean
  onImplemented: (id: string) => void
  busy: boolean
}) {
  const awaiting = !rejected && awaitingImplementation(changeset)

  return (
    <article className={`proposal resolved ${awaiting ? 'awaiting' : ''}`}>
      <div className="question-head resolved-head">
        <Head changeset={changeset} />
        {awaiting ? (
          <span className="pill pill-awaiting">awaiting implementation</span>
        ) : (
          <span className="pill">
            {rejected ? 'rejected' : changeset.implementedAt ? 'implemented' : 'applied'}
          </span>
        )}
      </div>

      {awaiting && (
        <div className="resolved-body">
          <p className="muted">
            In the glossary, not yet in <code>app/</code>. Re-run the implementation pass, then
            record it.
          </p>
          <ul className="op-list">
            {changeset.ops.map((op, index) => (
              <li key={index} className="op-preview">
                {summarizeOp(op)}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="action"
            disabled={busy}
            onClick={() => onImplemented(changeset.id)}
          >
            Mark implemented
          </button>
        </div>
      )}
    </article>
  )
}
