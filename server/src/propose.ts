/**
 * Minting a changeset from the chat.
 *
 * Safe for the same reason `raiseQuestion` is, and I had this wrong at first: a changeset
 * lands in the pending queue and changes *nothing*. It still has to be reviewed and applied
 * through the same panel, with the same diff preview and conflict detection. "Writes a
 * file" is not the same as "changes the glossary", so this needs no approval prompt of its
 * own — the approval already exists downstream.
 */
import path from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'
import { parseChangeset } from '@tb/shared'
import type { Changeset, Op } from '@tb/shared'
import { slug, uniquePath, writeAtomic } from './files.js'
import { APPLIED_DIR, CHANGESETS_DIR, REJECTED_DIR } from './store.js'

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

async function ids(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.json'))
  } catch {
    return []
  }
}

/**
 * `chat-004` after `chat-003`. Counts resolved directories too — reusing the id of an
 * applied changeset would make the history ambiguous.
 */
async function nextId(): Promise<string> {
  const files = (await Promise.all([ids(CHANGESETS_DIR), ids(APPLIED_DIR), ids(REJECTED_DIR)])).flat()
  const highest = files.reduce((max, file) => {
    const match = /^chat-(\d+)/.exec(file)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return `chat-${String(highest + 1).padStart(3, '0')}`
}

export async function proposeChangeset(request: ProposeRequest): Promise<ProposeOutcome> {
  const id = await nextId()
  const changeset: Changeset = {
    id,
    summary: request.summary,
    ops: request.ops,
    tests: request.tests,
    ...(request.fromQuestion ? { fromQuestion: request.fromQuestion } : {}),
  }

  // Validate before writing: a malformed changeset on disk comes back as a source problem
  // in the UI, which is a worse way to learn about it than a message here.
  const parsed = parseChangeset(changeset)
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; ') }

  await mkdir(CHANGESETS_DIR, { recursive: true })
  const target = await uniquePath(CHANGESETS_DIR, `${id}-${slug(request.summary)}.json`)
  await writeAtomic(target, `${JSON.stringify(changeset, null, 2)}\n`)

  return { ok: true, id, file: path.basename(target), changeset }
}
