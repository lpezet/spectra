import type {
  Answer,
  Changeset,
  Diagnostic,
  Expectation,
  Question,
  SourceProblem,
  Term,
} from '@tb/shared'

export interface Glossary {
  terms: Term[]
  problems: SourceProblem[]
}

export interface ChangesetFeed {
  changesets: Changeset[]
  problems: SourceProblem[]
  /** Resolved changesets, newest first, from changesets/applied and changesets/rejected. */
  applied: Changeset[]
  rejected: Changeset[]
}

export interface QuestionFeed {
  questions: Question[]
  problems: SourceProblem[]
}

export interface ExpectationFeed {
  expectations: Expectation[]
  /** Superseded, kept so a citation of an old id still resolves. */
  retired: Expectation[]
  problems: SourceProblem[]
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} — ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

export function fetchGlossary(): Promise<Glossary> {
  return get<Glossary>('/api/terms')
}

export function fetchChangesets(): Promise<ChangesetFeed> {
  return get<ChangesetFeed>('/api/changesets')
}

export function fetchQuestions(): Promise<QuestionFeed> {
  return get<QuestionFeed>('/api/questions')
}

/**
 * Only the expectations are fetched, never the coverage — that is computed in the browser
 * from the same `computeCoverage` the server and the agents use.
 *
 * Not a saving. It is what lets the board describe the glossary *as a changeset would leave
 * it*: open a proposal that adds a function and its uncovered pairs appear immediately,
 * alongside the highlights and diagnostics that already work that way. A server-computed
 * number could only ever describe the world before the change.
 */
export function fetchExpectations(): Promise<ExpectationFeed> {
  return get<ExpectationFeed>('/api/expectations')
}

export interface CommitOutcome {
  ok: boolean
  error?: string
  diagnostics?: Diagnostic[]
  needsAcknowledgement?: boolean
  appliedOps?: number
  remainingOps?: number
  written?: string[]
  deleted?: string[]
  resolvedTo?: string
}

/** A refused commit (409) is an expected answer, not a transport failure — it comes back as data. */
async function post(url: string, body: unknown): Promise<CommitOutcome> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    return (await response.json()) as CommitOutcome
  } catch {
    return { ok: false, error: `${url} — ${response.status} ${response.statusText}` }
  }
}

export function applyChangeset(
  id: string,
  opIndices: number[],
  acknowledgeWarnings: boolean,
): Promise<CommitOutcome> {
  return post(`/api/changesets/${encodeURIComponent(id)}/apply`, {
    opIndices,
    acknowledgeWarnings,
  })
}

/** Records that code has been written for an applied changeset. */
export function markImplemented(id: string): Promise<CommitOutcome> {
  return post(`/api/changesets/${encodeURIComponent(id)}/implemented`, {})
}

export function rejectChangeset(id: string): Promise<CommitOutcome> {
  return post(`/api/changesets/${encodeURIComponent(id)}/reject`, {})
}

export interface AnswerOutcome extends CommitOutcome {
  questionId?: string
  answer?: Answer
  changesetId?: string
  changesetFile?: string
}

export function answerQuestion(id: string, chose: string | null, note: string): Promise<AnswerOutcome> {
  return post(`/api/questions/${encodeURIComponent(id)}/answer`, { chose, note })
}
