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
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Changeset } from '@spectra/core'
import { summarizeOp } from '@spectra/core'
import { FilterPills, toggled } from './FilterPills.js'

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

/**
 * `awaiting` is on by default even though it is technically history — a change sitting in
 * the glossary with no code behind it is the one piece of resolved work that still wants
 * doing, and defaulting it off would undo the reason for tracking it.
 */
const DEFAULT_FILTERS = new Set(['pending', 'awaiting'])

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
  const [filters, setFilters] = useState<ReadonlySet<string>>(DEFAULT_FILTERS)

  const awaiting = applied.filter(awaitingImplementation)
  const done = applied.filter((changeset) => !awaitingImplementation(changeset))

  if (changesets.length === 0 && applied.length === 0 && rejected.length === 0) return null

  const shown = [
    ...(filters.has('awaiting') ? awaiting.map((changeset) => ({ changeset, rejected: false })) : []),
    ...(filters.has('applied') ? done.map((changeset) => ({ changeset, rejected: false })) : []),
    ...(filters.has('rejected') ? rejected.map((changeset) => ({ changeset, rejected: true })) : []),
  ]
  const pending = filters.has('pending') ? changesets : []

  return (
    <section className="proposals">
      <h2>
        Proposed changes
        <FilterPills
          active={filters}
          onToggle={(key) => setFilters((current) => toggled(current, key))}
          options={[
            { key: 'pending', label: 'pending', count: changesets.length, tone: 'pending' },
            {
              key: 'awaiting',
              label: 'awaiting implementation',
              count: awaiting.length,
              tone: 'awaiting',
              title: 'Applied to the glossary, but no code written for it yet',
            },
            { key: 'applied', label: 'applied', count: done.length },
            { key: 'rejected', label: 'rejected', count: rejected.length },
          ]}
        />
      </h2>

      {pending.length === 0 && shown.length === 0 && (
        <p className="muted empty-filter">
          {changesets.length === 0 ? 'Nothing pending.' : 'Everything is filtered out.'}
        </p>
      )}

      {pending.map((changeset) => (
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

      {shown.map((entry, index) => (
        <ResolvedCard
          key={`${entry.changeset.id}-${entry.changeset.appliedAt ?? index}`}
          changeset={entry.changeset}
          rejected={entry.rejected}
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
