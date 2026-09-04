/**
 * Minting a changeset from the chat.
 *
 * Safe for the same reason `raiseQuestion` is: a changeset lands in the pending queue and
 * changes *nothing*. It still has to be reviewed and applied through the same panel, with the
 * same diff preview and conflict detection. "Writes a file" is not "changes the glossary", so
 * this needs no approval prompt of its own — the approval already exists downstream.
 */
import { parseChangeset } from '@spectra/core'
import type { Author, Changeset, Op } from '@spectra/core'
import type { SpecStore } from './specStore.js'

export interface ProposeRequest {
  summary: string
  ops: Op[]
  tests: string[]
  /** Set when the proposal follows from a question that has already been answered. */
  fromQuestion?: string
}

export type ProposeOutcome =
  | { ok: false; error: string }
  | { ok: true; id: string; file: string; changeset: Changeset }

export async function proposeChangeset(
  store: SpecStore,
  request: ProposeRequest,
  author: Author,
): Promise<ProposeOutcome> {
  const id = await store.nextChangesetId()
  const changeset: Changeset = {
    id,
    summary: request.summary,
    ops: request.ops,
    tests: request.tests,
    ...(request.fromQuestion ? { fromQuestion: request.fromQuestion } : {}),
    author,
  }

  // Validate before writing: a malformed changeset on disk comes back as a source problem in
  // the UI, which is a worse way to learn about it than a message here.
  const parsed = parseChangeset(changeset)
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; ') }

  const file = await store.addChangeset(changeset)
  return { ok: true, id, file, changeset }
}
