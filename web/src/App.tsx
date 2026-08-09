import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Changeset, Expectation, HighlightKind, SourceProblem, Term, TermType } from '@tb/shared'
import { computeBacklinks, computeCoverage, connectionsFor } from '@tb/shared'
import type { ChangesetFeed, ExpectationFeed, Glossary, QuestionFeed } from './api.js'
import {
  answerQuestion,
  applyChangeset,
  fetchChangesets,
  fetchExpectations,
  fetchGlossary,
  fetchQuestions,
  markImplemented,
  rejectChangeset,
} from './api.js'
import type { Entity } from './chat.js'
import { HighlightLegend } from './components/BacklinkHighlight.js'
import { ChangesetBar } from './components/ChangesetBar.js'
import { ChangesetReview } from './components/ChangesetReview.js'
import { ChatPanel } from './components/ChatPanel.js'
import { CoveragePanel } from './components/CoveragePanel.js'
import { QuestionPanel } from './components/QuestionPanel.js'
import { SearchBar, filterTerms } from './components/SearchBar.js'
import { TermDetail } from './components/TermDetail.js'
import { TermList } from './components/TermList.js'
import { reviewChangeset } from './review.js'

const EMPTY_CONNECTIONS: Map<string, HighlightKind> = new Map()
const EMPTY_TERMS: Term[] = []
const EMPTY_CHANGESETS: Changeset[] = []
const EMPTY_EXPECTATIONS: Expectation[] = []

export function App() {
  const [glossary, setGlossary] = useState<Glossary | null>(null)
  const [feed, setFeed] = useState<ChangesetFeed | null>(null)
  const [questionFeed, setQuestionFeed] = useState<QuestionFeed | null>(null)
  const [expectationFeed, setExpectationFeed] = useState<ExpectationFeed | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [types, setTypes] = useState<Set<TermType>>(new Set())

  const [openId, setOpenId] = useState<string | null>(null)
  const [selectedOps, setSelectedOps] = useState<Set<number>>(new Set())
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; message: string } | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  const load = useCallback(async () => {
    const [nextGlossary, nextFeed, nextQuestions, nextExpectations] = await Promise.all([
      fetchGlossary(),
      fetchChangesets(),
      fetchQuestions(),
      fetchExpectations(),
    ])
    setGlossary(nextGlossary)
    setFeed(nextFeed)
    setQuestionFeed(nextQuestions)
    setExpectationFeed(nextExpectations)
  }, [])

  useEffect(() => {
    load().catch((cause: Error) => setError(cause.message))
  }, [load])

  const terms = glossary?.terms ?? EMPTY_TERMS
  const changesets = feed?.changesets ?? EMPTY_CHANGESETS
  const openChangeset = changesets.find((changeset) => changeset.id === openId) ?? null

  const review = useMemo(
    () => (openChangeset ? reviewChangeset(terms, openChangeset, selectedOps) : null),
    [terms, openChangeset, selectedOps],
  )

  // While a changeset is open the whole view renders against the projected glossary, so
  // backlinks, dangling refs and highlights all describe the world *after* the change.
  const projected = review ? review.projected : terms
  const backlinks = useMemo(() => computeBacklinks(projected), [projected])
  const known = useMemo(() => new Set(projected.map((term) => term.name)), [projected])

  // Terms the change removes stay in the list so the removal is visible and clickable.
  const display = useMemo(() => {
    if (!review) return terms
    const byName = new Map(review.projected.map((term) => [term.name, term] as const))
    for (const term of terms) if (!byName.has(term.name)) byName.set(term.name, term)
    return [...byName.values()]
  }, [terms, review])

  const displayByName = useMemo(
    () => new Map(display.map((term) => [term.name, term] as const)),
    [display],
  )
  const originalByName = useMemo(
    () => new Map(terms.map((term) => [term.name, term] as const)),
    [terms],
  )

  const expectations = expectationFeed?.expectations ?? EMPTY_EXPECTATIONS

  // Computed against `projected`, not `terms`. While a changeset is open the board describes
  // the glossary the change would leave behind — a proposal that adds a function shows its
  // uncovered pairs before anyone applies it, which is the same trick the highlights and
  // diagnostics already do.
  const coverage = useMemo(
    () => computeCoverage(projected, expectations),
    [projected, expectations],
  )

  const connections = useMemo(
    () => (selected ? connectionsFor(backlinks, selected) : EMPTY_CONNECTIONS),
    [backlinks, selected],
  )
  const visible = useMemo(() => filterTerms(display, query, types), [display, query, types])

  // What `@` completes over: the vocabulary itself, not files.
  const entities = useMemo<Entity[]>(
    () => [
      ...terms.map((term) => ({ name: term.name, kind: 'term' as const, hint: term.type })),
      ...(questionFeed?.questions ?? []).map((question) => ({
        name: question.id,
        kind: 'question' as const,
        hint: question.answer ? 'answered' : 'open',
      })),
      ...changesets.map((changeset) => ({
        name: changeset.id,
        kind: 'changeset' as const,
        hint: changeset.summary.slice(0, 40),
      })),
      ...expectations.map((expectation) => ({
        name: expectation.id,
        kind: 'expectation' as const,
        hint: expectation.expect.slice(0, 40),
      })),
    ],
    [terms, questionFeed, changesets, expectations],
  )

  function toggleType(type: TermType) {
    setTypes((current) => {
      const next = new Set(current)
      if (!next.delete(type)) next.add(type)
      return next
    })
  }

  function openReview(changeset: Changeset) {
    setOpenId(changeset.id)
    setSelectedOps(new Set(changeset.ops.map((_, index) => index)))
    setAcknowledged(false)
    setNotice(null)
  }

  function closeReview() {
    setOpenId(null)
    setSelectedOps(new Set())
    setAcknowledged(false)
  }

  async function commit(action: () => Promise<Awaited<ReturnType<typeof applyChangeset>>>) {
    setBusy(true)
    setNotice(null)
    try {
      const outcome = await action()
      if (!outcome.ok) {
        setNotice({ tone: 'bad', message: outcome.error ?? 'The change was refused.' })
        return
      }

      const parts: string[] = []
      if (outcome.appliedOps) parts.push(`applied ${outcome.appliedOps} op(s)`)
      if (outcome.written?.length) parts.push(`wrote ${outcome.written.join(', ')}`)
      if (outcome.deleted?.length) parts.push(`deleted ${outcome.deleted.join(', ')}`)
      if (outcome.remainingOps) parts.push(`${outcome.remainingOps} op(s) still pending`)
      parts.push(`changeset now at changesets/${outcome.resolvedTo}`)

      setNotice({ tone: 'ok', message: parts.join(' · ') })
      closeReview()
      await load()
    } catch (cause) {
      setNotice({ tone: 'bad', message: (cause as Error).message })
    } finally {
      setBusy(false)
    }
  }

  function toggleOp(index: number) {
    setSelectedOps((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  function setAllOps(all: boolean) {
    setSelectedOps(all ? new Set((openChangeset?.ops ?? []).map((_, index) => index)) : new Set())
  }

  async function recordAnswer(id: string, chose: string | null, note: string) {
    setBusy(true)
    setNotice(null)
    try {
      const outcome = await answerQuestion(id, chose, note)
      if (!outcome.ok) {
        setNotice({ tone: 'bad', message: outcome.error ?? 'The answer was refused.' })
        return
      }

      setNotice({
        tone: 'ok',
        message: outcome.changesetId
          ? `answered ${id} · raised changeset ${outcome.changesetId} for review`
          : `answered ${id} · no spec change`,
      })
      await load()
    } catch (cause) {
      setNotice({ tone: 'bad', message: (cause as Error).message })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="error">Could not load the glossary: {error}</p>
  if (!glossary || !feed || !questionFeed || !expectationFeed)
    return <p className="muted empty">Loading…</p>

  const selectedTerm = selected ? displayByName.get(selected) : undefined
  const status = selected ? review?.statuses.get(selected) : undefined
  const detailReview =
    status && selected ? { previous: originalByName.get(selected) ?? null, status } : undefined

  const problems: SourceProblem[] = [
    ...glossary.problems,
    ...feed.problems,
    ...questionFeed.problems,
    ...expectationFeed.problems,
  ]

  return (
    <div className={`app ${chatOpen ? 'app-with-chat' : ''}`}>
      <div className="app-main">
      <header className="app-header">
        <h1>todo-blueprints</h1>
        <span className="muted">spec glossary</span>
        <HighlightLegend />
        {!chatOpen && (
          <button type="button" className="action chat-open" onClick={() => setChatOpen(true)}>
            Chat
          </button>
        )}
      </header>

      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((problem) => (
            <li key={problem.file}>
              <code>{problem.file}</code> — {problem.message}
            </li>
          ))}
        </ul>
      )}

      {notice && <p className={`notice notice-${notice.tone}`}>{notice.message}</p>}

      <QuestionPanel
        questions={questionFeed.questions}
        known={known}
        onSelectTerm={setSelected}
        onAnswer={recordAnswer}
        busy={busy}
      />

      <CoveragePanel
        coverage={coverage}
        expectations={expectations}
        known={known}
        onSelectTerm={setSelected}
      />

      <ChangesetBar
        changesets={changesets}
        applied={feed.applied}
        rejected={feed.rejected}
        openId={openId}
        busy={busy}
        onImplemented={(id) => commit(() => markImplemented(id))}
        onToggle={(changeset) => (changeset.id === openId ? closeReview() : openReview(changeset))}
        renderReview={(changeset) =>
          review && (
            <ChangesetReview
              changeset={changeset}
              review={review}
              selectedOps={selectedOps}
              onToggleOp={toggleOp}
              onSetAllOps={setAllOps}
              onSelectTerm={setSelected}
              onClose={closeReview}
              acknowledged={acknowledged}
              onAcknowledge={setAcknowledged}
              onApply={() => commit(() => applyChangeset(changeset.id, [...selectedOps], acknowledged))}
              onReject={() => commit(() => rejectChangeset(changeset.id))}
              busy={busy}
            />
          )
        }
      />

      <div className="panes">
        <div className="pane pane-list">
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            types={types}
            onToggleType={toggleType}
            shown={visible.length}
            total={display.length}
          />
          <TermList
            terms={visible}
            selected={selected}
            connections={connections}
            statuses={review?.statuses}
            onSelect={setSelected}
          />
        </div>

        <div className="pane pane-detail">
          {selectedTerm ? (
            <TermDetail
              term={selectedTerm}
              termsByName={displayByName}
              backlinks={backlinks}
              known={known}
              onSelect={setSelected}
              review={detailReview}
              expectations={expectations}
              coverage={coverage}
            />
          ) : (
            <p className="muted empty">Pick a term to see its spec, attributes and backlinks.</p>
          )}
        </div>
      </div>
      </div>

      {chatOpen && (
        <ChatPanel
          entities={entities}
          onSpecsChanged={() => void load()}
          onSelectTerm={setSelected}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  )
}
