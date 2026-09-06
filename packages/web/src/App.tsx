import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Changeset, Expectation, HighlightKind, ProjectInfo, SourceProblem, Term, TermType } from '@spectra/core'
import { computeBacklinks, computeCoverage, connectionsFor } from '@spectra/core'
import type { ChangesetFeed, ExpectationFeed, Glossary, Org, ProjectSummary, QuestionFeed } from './api.js'
import {
  answerQuestion,
  applyChangeset,
  configureProject,
  fetchChangesets,
  fetchContext,
  fetchExpectations,
  fetchGlossary,
  fetchOrgs,
  fetchProjects,
  fetchQuestions,
  markImplemented,
  raiseExpectation,
  recheckExpectation,
  rejectChangeset,
  supersedeExpectation,
} from './api.js'
import type { Entity } from './chat.js'
import { HighlightLegend } from './components/BacklinkHighlight.js'
import { ChangesetBar } from './components/ChangesetBar.js'
import { ChangesetReview } from './components/ChangesetReview.js'
import { ChatPanel } from './components/ChatPanel.js'
import { CoveragePanel } from './components/CoveragePanel.js'
import { QuestionPanel } from './components/QuestionPanel.js'
import type { SupersedeDraft } from './components/TermDetail.js'
import { ProjectSwitcher } from './components/ProjectSwitcher.js'
import { SearchBar, filterTerms } from './components/SearchBar.js'
import { TermDetail } from './components/TermDetail.js'
import { TermList } from './components/TermList.js'
import { reviewChangeset } from './review.js'

const EMPTY_CONNECTIONS: Map<string, HighlightKind> = new Map()
const EMPTY_TERMS: Term[] = []
const EMPTY_CHANGESETS: Changeset[] = []
const EMPTY_EXPECTATIONS: Expectation[] = []

const LAST_ORG = 'spectra.org'
const LAST_PROJECT = 'spectra.projectId'

// localStorage remembers the last-picked org/project so a reload returns you where you were.
// Wrapped because it throws in a private window or with site data blocked — a convenience, never
// load-bearing (the server's /api/context default covers a first visit or a cleared store).
const recall = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // no-op: remembering the selection is a nicety, not a requirement
  }
}

/** First preference that actually exists in `available`, else the first available, else null. */
const pick = (available: string[], ...preferences: Array<string | null | undefined>): string | null => {
  for (const preference of preferences) {
    if (preference && available.includes(preference)) return preference
  }
  return available[0] ?? null
}

export function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [orgs, setOrgs] = useState<Org[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [org, setOrg] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
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

  // Point the API at a project, remember the choice, show its identity, and load its glossary. Every
  // glossary call lives under the project's prefix, so configuring first is what makes them resolve.
  const openProject = useCallback(
    async (nextOrg: string, nextProjectId: string, inOrg: ProjectSummary[]) => {
      configureProject(nextOrg, nextProjectId)
      setOrg(nextOrg)
      setProjectId(nextProjectId)
      remember(LAST_ORG, nextOrg)
      remember(LAST_PROJECT, nextProjectId)
      const info = inOrg.find((entry) => entry.id === nextProjectId)
      if (info) setProject({ name: info.name, domain: info.domain })
      await load()
    },
    [load],
  )

  // Switch org: fetch its projects, then open the remembered one (or the first). Its projects become
  // the project selector's options.
  const openOrg = useCallback(
    async (nextOrg: string, preferProjectId?: string) => {
      const { projects: inOrg } = await fetchProjects(nextOrg)
      setProjects(inOrg)
      const chosen = pick(inOrg.map((entry) => entry.id), preferProjectId, recall(LAST_PROJECT))
      if (chosen) await openProject(nextOrg, chosen, inOrg)
    },
    [openProject],
  )

  // Bootstrap: the orgs to pick from and the server's default scope (un-prefixed, before any project
  // is configured). Open the remembered org (or the default, or the only one), which opens a project
  // and loads. A single org/project just auto-selects — the picker never makes you choose the only one.
  useEffect(() => {
    Promise.all([fetchOrgs(), fetchContext()])
      .then(async ([{ orgs: available }, context]) => {
        setOrgs(available)
        const chosenOrg = pick(available.map((entry) => entry.id), recall(LAST_ORG), context.org)
        if (chosenOrg) await openOrg(chosenOrg, recall(LAST_PROJECT) ?? context.projectId)
      })
      .catch((cause: Error) => setError(cause.message))
  }, [openOrg])

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

  /**
   * Both writes reload and report, and neither goes through `commit` — that helper speaks in
   * ops applied and files written, which is the vocabulary of changing the glossary. These do
   * not change it; they change what is expected of it.
   */
  async function recordExpectation<T extends { ok: boolean; error?: string }>(
    action: () => Promise<T>,
    describe: (outcome: T) => string,
  ) {
    setBusy(true)
    setNotice(null)
    try {
      const outcome = await action()
      if (!outcome.ok) {
        setNotice({ tone: 'bad', message: outcome.error ?? 'Refused.' })
        return
      }
      setNotice({ tone: 'ok', message: describe(outcome) })
      await load()
    } catch (cause) {
      setNotice({ tone: 'bad', message: (cause as Error).message })
    } finally {
      setBusy(false)
    }
  }

  function raise(
    draft: { terms: string[]; given: string; expect: string },
    contested: Array<{ kind: string; subject: string; detail: string; quote?: string }>,
  ) {
    const clashes = contested.filter((finding) => finding.kind === 'contradicts')
    void recordExpectation(
      () => raiseExpectation({ kind: 'functional', ...draft }, contested),
      (outcome) =>
        clashes.length > 0
          ? `raised ${outcome.id}, contested — it disagrees with ${clashes.map((c) => c.subject).join(', ')}, so it covers nothing until someone settles which side gives`
          : `raised ${outcome.id} · live now — the committed snapshot is behind, refresh it before the next implementation pass`,
    )
  }

  function recheck(id: string) {
    void recordExpectation(
      () => recheckExpectation(id),
      (outcome) => {
        const clashes = outcome.expectation?.contested ?? []
        return clashes.length === 0
          ? `${id} re-checked · nothing clashes any more, so it counts as coverage again`
          : `${id} re-checked · still clashes with ${clashes.map((clash) => clash.subject).join(', ')}`
      },
    )
  }

  function supersede(id: string, draft: SupersedeDraft) {
    void recordExpectation(
      () => supersedeExpectation(id, draft.note, draft.replacement),
      (outcome) =>
        outcome.replacement
          ? `${id} retired to expectations/retired · replaced by ${outcome.replacement.id}`
          : `${id} retired to expectations/retired · nothing replaces it`,
    )
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
        <h1>{project?.name ?? 'Spectra'}</h1>
        <ProjectSwitcher
          orgs={orgs}
          projects={projects}
          org={org}
          projectId={projectId}
          onOrg={(next) => void openOrg(next).catch((cause: Error) => setError(cause.message))}
          onProject={(next) =>
            org && void openProject(org, next, projects).catch((cause: Error) => setError(cause.message))
          }
        />
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
        onRaise={raise}
        busy={busy}
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
              onSupersede={supersede}
              onRecheck={recheck}
              busy={busy}
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
