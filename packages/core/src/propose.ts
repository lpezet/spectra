/**
 * Minting a changeset — the canonical write, over the {@link SpecStore} seam.
 *
 * It lives in `@spectra/core` for the same reason the seam interfaces do: it is pure (it validates a
 * request and writes through the store, with no server, filesystem, or SDK dependency), and both the
 * open server and an out-of-repo backend need to propose *identically*. Keeping it beside the seam is
 * what makes "propose a changeset" one operation with one meaning, whichever process runs it.
 *
 * Safe for the same reason `raiseQuestion` is: a changeset lands in the pending queue and changes
 * *nothing*. It still has to be reviewed and applied through the same panel, with the same diff
 * preview and conflict detection. "Writes a file" is not "changes the glossary", so this needs no
 * approval prompt of its own — the approval already exists downstream.
 */
import { parseChangeset } from './schema.js'
import type { Author, Changeset, Op } from './types.js'
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
