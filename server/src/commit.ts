/**
 * Committing a changeset to disk. The engine in @tb/shared decides *what* the glossary
 * should become; this decides which files change to get there, and re-validates
 * server-side rather than trusting whatever the client selected.
 */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { applyOps, parseChangeset } from '@tb/shared'
import type { Attribute, Changeset, Diagnostic, Term } from '@tb/shared'
import { uniquePath, writeAtomic } from './files.js'
import {
  APPLIED_DIR,
  CHANGESETS_DIR,
  REJECTED_DIR,
  TERMS_DIR,
  findChangesetEntry,
  readTermEntries,
} from './store.js'

async function listResolvedFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/** `RecurringTask` → `recurring-task.json`, matching the seed files. */
export function termFileName(name: string): string {
  return `${name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.json`
}

/** `{ "name": "title", "valueType": "string" }` — one line, with the spacing a human would use. */
function inlineObject(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ')
}

/**
 * Writes a term the way a human would have written it: fixed key order, 2-space indent,
 * and one line per attribute. Matching the hand-authored format matters — otherwise the
 * first applied changeset reformats every file it touches and buries the real change.
 */
function serializeTerm(term: Term): string {
  const attribute = (source: Attribute) => {
    const ordered: Record<string, unknown> = { name: source.name, valueType: source.valueType }
    if (source.default !== undefined) ordered.default = source.default
    if (source.optional !== undefined) ordered.optional = source.optional
    return inlineObject(ordered)
  }

  const attributes = term.attributes.map((source) => `    ${attribute(source)}`)

  const lines = [
    '{',
    `  "name": ${JSON.stringify(term.name)},`,
    `  "type": ${JSON.stringify(term.type)},`,
    `  "spec": ${JSON.stringify(term.spec)},`,
    `  "parent": ${JSON.stringify(term.parent)},`,
    `  "tags": ${JSON.stringify(term.tags)},`,
    attributes.length > 0
      ? `  "attributes": [\n${attributes.join(',\n')}\n  ]`
      : '  "attributes": []',
    '}',
  ]

  return `${lines.join('\n')}\n`
}

function serializeChangeset(changeset: Changeset): string {
  return `${JSON.stringify(changeset, null, 2)}\n`
}

export type CommitOutcome =
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 400; error: string }
  | {
      ok: false
      status: 409
      error: string
      diagnostics: Diagnostic[]
      needsAcknowledgement: boolean
    }
  | {
      ok: true
      appliedOps: number
      remainingOps: number
      written: string[]
      deleted: string[]
      resolvedTo: string
      diagnostics: Diagnostic[]
    }

export interface ApplyRequest {
  opIndices: number[]
  acknowledgeWarnings?: boolean
}

export async function applyChangeset(
  id: string,
  request: ApplyRequest,
): Promise<CommitOutcome> {
  const entry = await findChangesetEntry(id)
  if (!entry) return { ok: false, status: 404, error: `No pending changeset with id "${id}".` }

  const { changeset, file } = entry
  const indices = [...new Set(request.opIndices)].sort((a, b) => a - b)

  if (indices.length === 0) {
    return { ok: false, status: 400, error: 'No ops selected.' }
  }
  if (indices.some((index) => !Number.isInteger(index) || !changeset.ops[index])) {
    return { ok: false, status: 400, error: `Op indices out of range for changeset "${id}".` }
  }

  const { entries: termEntries } = await readTermEntries()
  const before = termEntries.map((termEntry) => termEntry.term)

  // Re-run the same validation the UI ran, against the glossary as it is *now* — the
  // files may have been hand-edited since the client last read them.
  const result = applyOps(
    before,
    indices.map((index) => changeset.ops[index]!),
  )

  // The engine only saw the selected ops, so its indices count within that subset.
  // Report them as positions in the changeset the caller actually sent.
  const diagnostics: Diagnostic[] = result.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    opIndex: diagnostic.opIndex === null ? null : (indices[diagnostic.opIndex] ?? null),
  }))
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')

  if (errors.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'This selection would leave the glossary broken.',
      diagnostics,
      needsAcknowledgement: false,
    }
  }
  if (warnings.length > 0 && !request.acknowledgeWarnings) {
    return {
      ok: false,
      status: 409,
      error: 'This selection orphans references that still point at what it removes.',
      diagnostics,
      needsAcknowledgement: true,
    }
  }

  const fileByName = new Map(termEntries.map((termEntry) => [termEntry.term.name, termEntry.file]))
  const written: string[] = []
  const deleted: string[] = []

  for (const term of result.terms) {
    const target = fileByName.get(term.name) ?? termFileName(term.name)
    const contents = serializeTerm(term)
    const existing = termEntries.find((termEntry) => termEntry.term.name === term.name)
    if (existing && serializeTerm(existing.term) === contents) continue
    await writeAtomic(path.join(TERMS_DIR, target), contents)
    written.push(target)
  }

  const survived = new Set(result.terms.map((term) => term.name))
  for (const termEntry of termEntries) {
    if (survived.has(termEntry.term.name)) continue
    await rm(path.join(TERMS_DIR, termEntry.file))
    deleted.push(termEntry.file)
  }

  // The applied ops move to applied/; anything left unselected stays pending, so a
  // cherry-pick never silently discards the ops the human did not accept.
  const remaining = changeset.ops.filter((_, index) => !indices.includes(index))

  await mkdir(APPLIED_DIR, { recursive: true })
  const appliedPath = await uniquePath(APPLIED_DIR, file)
  await writeAtomic(
    appliedPath,
    serializeChangeset({
      ...changeset,
      ops: indices.map((index) => changeset.ops[index]!),
      appliedAt: new Date().toISOString(),
      // Applied is not implemented. Recording null here is what lets the UI show a change
      // that landed in the glossary with no code written for it — the case the
      // `implements:` markers cannot see, since a rewritten spec leaves them all correct.
      implementedAt: null,
    }),
  )

  const pendingPath = path.join(CHANGESETS_DIR, file)
  if (remaining.length === 0) {
    await rm(pendingPath)
  } else {
    await writeAtomic(pendingPath, serializeChangeset({ ...changeset, ops: remaining }))
  }

  return {
    ok: true,
    appliedOps: indices.length,
    remainingOps: remaining.length,
    written,
    deleted,
    resolvedTo: path.relative(CHANGESETS_DIR, appliedPath),
    diagnostics,
  }
}

/**
 * Records that code has been written for an applied changeset.
 *
 * A stopgap: the human presses a button after re-running the implementation pass. The
 * right owner is the coder agent, which knows exactly when a pass finished and which
 * changesets it read — this is the first tool it should get.
 */
export async function markImplemented(
  id: string,
  at: string,
): Promise<{ ok: boolean; status?: number; error?: string; file?: string }> {
  for (const file of await listResolvedFiles(APPLIED_DIR)) {
    const full = path.join(APPLIED_DIR, file)
    const parsed = parseChangeset(JSON.parse(await readFile(full, 'utf8')))
    if (!parsed.ok || parsed.value.id !== id) continue

    await writeAtomic(full, serializeChangeset({ ...parsed.value, implementedAt: at }))
    return { ok: true, file }
  }

  return { ok: false, status: 404, error: `No applied changeset with id "${id}".` }
}

export async function rejectChangeset(id: string): Promise<CommitOutcome> {
  const entry = await findChangesetEntry(id)
  if (!entry) return { ok: false, status: 404, error: `No pending changeset with id "${id}".` }

  await mkdir(REJECTED_DIR, { recursive: true })
  const rejectedPath = await uniquePath(REJECTED_DIR, entry.file)
  await writeAtomic(rejectedPath, serializeChangeset(entry.changeset))
  await rm(path.join(CHANGESETS_DIR, entry.file))

  return {
    ok: true,
    appliedOps: 0,
    remainingOps: 0,
    written: [],
    deleted: [],
    resolvedTo: path.relative(CHANGESETS_DIR, rejectedPath),
    diagnostics: [],
  }
}
