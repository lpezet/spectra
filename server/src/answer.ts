/**
 * Answering a question. Two things happen and both matter: the answer is written back into the
 * question, where it stays as the record of *why* the glossary says what it says, and the
 * chosen option's proposal is minted into the pending changeset queue, where it goes through
 * the same review the human already has.
 *
 * Note what does not happen: nothing is applied. Answering a question decides the intent;
 * applying the changeset it produces is still a separate, deliberate act.
 */
import type { Answer, Changeset } from '@tb/shared'
import { slug } from './files.js'
import type { SpecStore } from './specStore.js'

export type AnswerOutcome =
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 409; error: string }
  | {
      ok: true
      questionId: string
      answer: Answer
      /** Set when the chosen option carried a proposal. */
      changesetId?: string
      changesetFile?: string
    }

export interface AnswerRequest {
  /** Label of the chosen option, or null to answer in prose without taking one. */
  chose: string | null
  note: string
  /** ISO timestamp; the caller's clock, so this stays testable. */
  answeredAt: string
}

export async function answerQuestion(
  store: SpecStore,
  id: string,
  request: AnswerRequest,
): Promise<AnswerOutcome> {
  const question = await store.findQuestion(id)
  if (!question) return { ok: false, status: 404, error: `No question with id "${id}".` }

  // A decision is a record, not a setting. Changing your mind means a new question (or a
  // hand-edit), so the reasoning that was acted on cannot be quietly overwritten.
  if (question.answer) {
    return {
      ok: false,
      status: 409,
      error: `"${id}" was already answered on ${question.answer.answeredAt}. Raise a new question rather than overwriting the decision.`,
    }
  }

  const option =
    request.chose === null
      ? null
      : question.options.find((candidate) => candidate.label === request.chose)

  if (request.chose !== null && !option) {
    return { ok: false, status: 400, error: `"${id}" has no option labelled "${request.chose}".` }
  }
  if (request.chose === null && !request.note.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'Answering without choosing an option requires a note saying what to do instead.',
    }
  }

  const answer: Answer = {
    chose: request.chose,
    note: request.note,
    answeredAt: request.answeredAt,
  }

  let changesetFile: string | undefined

  if (option?.proposal) {
    const changesetId = `${question.id}-${slug(option.label)}`
    const changeset: Changeset = {
      id: changesetId,
      summary: option.proposal.summary,
      ops: option.proposal.ops,
      tests: option.proposal.tests,
      fromQuestion: question.id,
    }

    // Written before the answer: if the process dies between the two, an unreferenced changeset
    // in the queue is noise someone notices, where an answer citing a changeset that was never
    // written is a dangling reference.
    changesetFile = await store.addChangeset(changeset)
    answer.changesetId = changesetId
  }

  await store.writeAnswer(id, answer)

  return {
    ok: true,
    questionId: question.id,
    answer,
    ...(answer.changesetId ? { changesetId: answer.changesetId } : {}),
    ...(changesetFile ? { changesetFile } : {}),
  }
}
