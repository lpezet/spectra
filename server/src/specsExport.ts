/**
 * The specs as a versioned contract the app can be checked against offline.
 *
 * The `implements:` drift check needs two things that live on opposite sides of the sandbox
 * boundary: the markers, which are in `app/`, and the specs, which are here. When `specs/`
 * stopped being mounted into the container the check lost half its inputs and started
 * skipping.
 *
 * A tool that answered the question live would work and would be wrong. `app/` has to stand
 * alone — copy the directory anywhere and `npm test` passes — and a test that needs a
 * service running is a test that fails for a human who does not have one. So this produces
 * a *file*: `@coder` writes it into `app/specs.snapshot.json`, and the check reads it like
 * any other fixture.
 *
 * The model is git's. `version` here is the remote HEAD; the `version` inside the committed
 * snapshot is the local ref. Refusing `mark_implemented` when they differ is the
 * non-fast-forward reject, and `export_specs` is the fetch. Where the analogy stops is worth
 * knowing: git rejects because the merge is genuinely impossible, whereas the write here
 * would succeed fine — what is refused is a *claim* nothing could verify.
 *
 * What goes in the file is only what the check needs. Names and kinds answer "does
 * everything have an implementer, and does every marker name something real". The prose does
 * not, so it is not here — a hash of it is. That makes the snapshot lossy on purpose:
 * catching up is two steps, not one, because knowing *that* a term moved is not knowing what
 * it now says.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Term } from '@tb/shared'
import { CODER_URL } from './sandbox.js'
import { SPECS_DIR } from './store.js'
import { DATA_DIR } from './transcripts.js'

/** Where the last export is remembered. Not in specs/ — it records no decision. */
const LEDGER = path.join(DATA_DIR, 'last-export.json')

/** Only read when @coder runs in-process; otherwise the sandbox is asked. */
const APP_SNAPSHOT =
  process.env.APP_SNAPSHOT ?? path.resolve(SPECS_DIR, '..', 'app', 'specs.snapshot.json')

export interface SnapshotTerm {
  name: string
  type: string
  /** Everything an implementer has to satisfy: spec text, parent, attributes. */
  hash: string
}

export interface Snapshot {
  /** One value for the whole of specs/, so "same or not?" is a string comparison. */
  version: string
  terms: SnapshotTerm[]
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

/**
 * Attributes are sorted by name before hashing. Reordering them in the file changes nothing
 * about what the code must do, and a hash that moved on a reorder would train people to
 * ignore it.
 */
function hashTerm(term: Term): string {
  return digest({
    spec: term.spec,
    parent: term.parent,
    attributes: [...term.attributes]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((attribute) => ({
        name: attribute.name,
        valueType: attribute.valueType,
        default: attribute.default ?? null,
        optional: attribute.optional === true,
      })),
  })
}

/**
 * A pure function of the specs — no timestamp, deliberately.
 *
 * A `generatedAt` field would mean every export dirties the file, so `git status` reports a
 * change whether or not the contract moved and the signal this exists for gets buried in
 * noise. Without it, re-exporting when nothing has changed produces a byte-identical file:
 * run the export, and if git says nothing changed, the contract did not move. When it did,
 * the diff names exactly which terms.
 */
export function specsSnapshot(terms: Term[]): Snapshot {
  const entries: SnapshotTerm[] = [...terms]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((term) => ({ name: term.name, type: term.type, hash: hashTerm(term) }))

  return { version: digest(entries), terms: entries }
}

/**
 * The version actually committed in `app/`, read from the artifact rather than taken on
 * anyone's word.
 *
 * This is the whole reason `mark_implemented` takes no version parameter. An agent that
 * passed its own version could call `export_specs`, hold the new value, never write the
 * file, and sail through the check — which is exactly the hole worth closing. So nothing is
 * passed: the answer is read from the snapshot on disk, either directly or, when the code
 * lives in a container this process cannot see into, from the sandbox reporting what it
 * finds at its own mount.
 *
 * Null means there is no readable snapshot at all — a different failure from being out of
 * date, and it gets a different message.
 */
export async function deployedVersion(): Promise<string | null> {
  if (CODER_URL) {
    try {
      const response = await fetch(`${CODER_URL}/health`, { signal: AbortSignal.timeout(3_000) })
      if (!response.ok) return null
      const health = (await response.json()) as { snapshotVersion?: string | null }
      return health.snapshotVersion ?? null
    } catch {
      return null
    }
  }

  try {
    return (JSON.parse(readFileSync(APP_SNAPSHOT, 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

export interface ExportRecord {
  version: string
  exportedAt: string
}

/**
 * When the last export happened. Informational only — never the gate.
 *
 * It records that the tool was *called*, which is not the same as the file being written:
 * the write still has to pass the approval card. `deployedVersion` is the fact; this is only
 * the timestamp, so @coder can say "you last refreshed three days ago" without it ever being
 * what decides anything.
 */
export function recordExport(snapshot: Snapshot, exportedAt: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(LEDGER, `${JSON.stringify({ version: snapshot.version, exportedAt }, null, 2)}\n`)
  } catch (cause) {
    console.error('[export] could not record the export', cause)
  }
}

export function lastExport(): ExportRecord | null {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8')) as ExportRecord
  } catch {
    return null
  }
}
