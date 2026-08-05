import type { Answer, Changeset, Diagnostic, Question, SourceProblem, Term } from '@tb/shared'

export interface Glossary {
  terms: Term[]
  problems: SourceProblem[]
}

export interface ChangesetFeed {
  changesets: Changeset[]
  problems: SourceProblem[]
  /** Counts only — the files themselves live in changesets/applied and changesets/rejected. */
  applied: number
  rejected: number
}

export interface QuestionFeed {
  questions: Question[]
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
