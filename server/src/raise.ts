/**
 * Raising a question — the one write an agent is allowed to make against `specs/`.
 *
 * Safe by construction: a question changes no term and applies no op. It is a request for a
 * decision, and every path out of it (answering, then reviewing the changeset it mints) still
 * runs through the human. That is why this needs no approval prompt while `proposeChangeset` will.
 */
import { parseQuestion } from '@tb/shared'
import type { Author, Proposal, Question, QuestionOption, RecordStatus } from '@tb/shared'
import type { SpecStore } from './specStore.js'

export interface RaiseRequest {
  asks: string
  because: string
  pass: string
  file?: string
  terms: string[]
  options: Array<{ label: string; detail?: string; proposal?: Proposal | null }>
  /** Draft or published. Absent means `ready`; agents always raise `ready`. */
  status?: RecordStatus
}

export type RaiseOutcome =
  | { ok: false; error: string }
  | { ok: true; id: string; file: string; question: Question }

export async function raiseQuestion(
  store: SpecStore,
  request: RaiseRequest,
  author: Author,
): Promise<RaiseOutcome> {
  const id = await store.nextQuestionId()

  const options: QuestionOption[] = request.options.map((option) => ({
    label: option.label,
    ...(option.detail ? { detail: option.detail } : {}),
    proposal: option.proposal ?? null,
  }))

  const question: Question = {
    id,
    asks: request.asks,
    because: request.because,
    raisedBy: {
      pass: request.pass,
      ...(request.file ? { file: request.file } : {}),
      terms: request.terms,
    },
    author,
    status: request.status ?? 'ready',
    options,
    answer: null,
  }

  // Validate before writing rather than after: a malformed question would otherwise land on
  // disk and come back as a source problem in the UI.
  const parsed = parseQuestion(question)
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; ') }

  const file = await store.addQuestion(question)
  return { ok: true, id, file, question }
}
