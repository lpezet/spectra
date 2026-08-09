import { useState } from 'react'
import type { Coverage, CoveragePair, Expectation } from '@tb/shared'
import { FilterPills, toggled } from './FilterPills.js'
import { TermRef } from './TermRef.js'

interface CoveragePanelProps {
  coverage: Coverage
  expectations: Expectation[]
  known: Set<string>
  onSelectTerm: (name: string) => void
}

/**
 * What the glossary has named but nobody has said anything about.
 *
 * Uncovered is the default view for the same reason unanswered questions are: a gap is
 * something still waiting on you, and a covered pair is a thing already done. Covered pairs
 * stay one click away rather than competing for the screen.
 */
const DEFAULT_FILTERS = new Set(['gaps'])

/**
 * Deliberately no percentage.
 *
 * Coverage here means "has anyone said what should happen", not "is it correct" — five
 * expectations on a pair is five times someone thought about it, which a score would quietly
 * present as a quality measure. So this counts and lists, and leaves the judgement where
 * `/api/specs/version` leaves it: with the person reading two numbers.
 */
export function CoveragePanel({ coverage, expectations, known, onSelectTerm }: CoveragePanelProps) {
  const [filters, setFilters] = useState<ReadonlySet<string>>(DEFAULT_FILTERS)

  const pairs = coverage.entities.flatMap((entry) => entry.pairs)
  const covered = pairs.filter((pair) => pair.expectations.length > 0)

  if (pairs.length === 0 && expectations.length === 0) return null

  const byId = new Map(expectations.map((expectation) => [expectation.id, expectation] as const))

  const shown = [
    ...(filters.has('gaps') ? coverage.gaps : []),
    ...(filters.has('covered') ? covered : []),
  ]

  return (
    <section className="coverage">
      <h2>
        Coverage
        <FilterPills
          active={filters}
          onToggle={(key) => setFilters((current) => toggled(current, key))}
          options={[
            {
              key: 'gaps',
              label: 'uncovered',
              count: coverage.gaps.length,
              tone: 'open',
              title: 'Pairs no expectation names both ends of',
            },
            { key: 'covered', label: 'covered', count: covered.length },
          ]}
        />
        <span className="muted coverage-note">
          lifecycle pairs — an entity and something that happens to it
        </span>
      </h2>

      {coverage.dangling.length > 0 && (
        <ul className="problems">
          {coverage.dangling.map((entry) => (
            <li key={`${entry.expectation}.${entry.term}`}>
              <code>{entry.expectation}</code> names <code>{entry.term}</code>, which no term
              declares.
            </li>
          ))}
        </ul>
      )}

      {shown.length === 0 ? (
        <p className="muted empty-filter">
          {coverage.gaps.length === 0 ? 'Every pair has an expectation.' : 'Everything is filtered out.'}
        </p>
      ) : (
        <ul className="coverage-list">
          {shown.map((pair) => (
            <PairRow
              key={`${pair.entity}.${pair.action}`}
              pair={pair}
              byId={byId}
              known={known}
              onSelectTerm={onSelectTerm}
            />
          ))}
        </ul>
      )}

      {coverage.nonFunctional.length > 0 && (
        <p className="muted coverage-nonfunctional">
          {coverage.nonFunctional.length} non-functional expectation
          {coverage.nonFunctional.length === 1 ? '' : 's'} — properties of a running build, so
          they belong to no pair and are never counted above:{' '}
          {coverage.nonFunctional.map((id) => (
            <code key={id}>{id} </code>
          ))}
        </p>
      )}
    </section>
  )
}

function PairRow({
  pair,
  byId,
  known,
  onSelectTerm,
}: {
  pair: CoveragePair
  byId: Map<string, Expectation>
  known: Set<string>
  onSelectTerm: (name: string) => void
}) {
  const gap = pair.expectations.length === 0

  return (
    <li className={`coverage-row ${gap ? 'coverage-gap' : 'coverage-covered'}`}>
      <span
        className={`distance distance-${pair.distance}`}
        title={
          pair.distance === 1
            ? 'The action names this entity directly'
            : `Reached through ${pair.distance - 1} step(s) of the entity graph — an interaction neither file mentions`
        }
      >
        d{pair.distance}
      </span>

      <span className="coverage-pair">
        <TermRef name={pair.entity} known={known} onSelect={onSelectTerm} />
        <span className="muted"> × </span>
        <TermRef name={pair.action} known={known} onSelect={onSelectTerm} />
      </span>

      {gap ? (
        <span className="muted coverage-empty">nothing says what should happen</span>
      ) : (
        <span className="coverage-ids">
          {pair.expectations.map((id) => (
            <code key={id} title={summarize(byId.get(id))}>
              {id}
            </code>
          ))}
        </span>
      )}
    </li>
  )
}

function summarize(expectation: Expectation | undefined): string {
  if (!expectation) return ''
  return expectation.given ? `Given ${expectation.given} — ${expectation.expect}` : expectation.expect
}
