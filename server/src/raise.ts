/**
 * Raising a question — the one write an agent is allowed to make against `specs/`.
 *
 * Safe by construction: a question changes no term and applies no op. It is a request for
 * a decision, and every path out of it (answering, then reviewing the changeset it mints)
 * still runs through the human. That is why this needs no approval prompt while
 * `proposeChangeset` will.
 */
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { parseQuestion } from '@tb/shared'
import type { Proposal, Question, QuestionOption } from '@tb/shared'
import { slug, uniquePath, writeAtomic } from './files.js'
import { QUESTIONS_DIR, readQuestionEntries } from './store.js'

export interface RaiseRequest {
  asks: string
  because: string
  pass: string
  file?: string
  terms: string[]
  options: Array<{ label: string; detail?: string; proposal?: Proposal | null }>
}

export type RaiseOutcome =
  | { ok: false; error: string }
  | { ok: true; id: string; file: string; question: Question }

/** `q-004` after `q-003`. Ids are per-directory, so a gap from a deleted file is fine. */
async function nextQuestionId(): Promise<string> {
  const { entries } = await readQuestionEntries()
  const highest = entries.reduce((max, entry) => {
    const match = /^q-(\d+)$/.exec(entry.question.id)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return `q-${String(highest + 1).padStart(3, '0')}`
}

export async function raiseQuestion(request: RaiseRequest): Promise<RaiseOutcome> {
  const id = await nextQuestionId()

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
    options,
    answer: null,
  }

  // Validate before writing rather than after: a malformed question would otherwise land
  // on disk and come back as a source problem in the UI.
  const parsed = parseQuestion(question)
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; ') }

  await mkdir(QUESTIONS_DIR, { recursive: true })
  const target = await uniquePath(QUESTIONS_DIR, `${id}-${slug(request.asks)}.json`)
  await writeAtomic(target, `${JSON.stringify(question, null, 2)}\n`)

  return { ok: true, id, file: path.basename(target), question }
}
