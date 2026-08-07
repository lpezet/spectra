/**
 * The glossary as a contract the app can be checked against offline.
 *
 * The `implements:` drift check needs two things that live on opposite sides of the sandbox
 * boundary: the markers, which are in `app/`, and the glossary, which is here. When `app/`
 * stopped being mounted into the container the check lost half its inputs and started
 * skipping.
 *
 * A tool that answers the question live would work and would be wrong. `app/` has to stand
 * alone — copy the directory anywhere and `npm test` passes — and a test that needs a
 * service running is a test that fails for a human who does not have one. So this produces
 * a *file*: `@coder` writes it into `app/specs.snapshot.json`, and the check reads it like
 * any other fixture.
 *
 * What goes in it is only what the check needs. Names and kinds answer "does everything have
 * an implementer, and does every marker name something real". The prose does not, so it is
 * not here — a hash of it is.
 *
 * That hash is the interesting part. The drift check has never been able to catch a
 * changeset that *rewrites* an existing term: the marker still names the term and still
 * looks correct, so nothing goes red. It still cannot. But refreshing the snapshot makes
 * `git diff app/specs.snapshot.json` name exactly which terms moved, so the thing a test
 * cannot see shows up in review instead — and the snapshot stays quiet when nothing about
 * the contract changed.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Term } from '@tb/shared'
import { DATA_DIR } from './transcripts.js'

/** Where the last export is remembered. Not in specs/ — it records no decision. */
const LEDGER = path.join(DATA_DIR, 'last-export.json')

export interface SnapshotTerm {
  name: string
  type: string
  /** Everything an implementer has to satisfy: spec text, parent, attributes. */
  hash: string
}

export interface Snapshot {
  /** One value for the whole glossary, so "has it moved?" is a string comparison. */
  fingerprint: string
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
 * A pure function of the glossary — no timestamp, deliberately.
 *
 * A `generatedAt` field would mean every export dirties the file, so `git status` reports a
 * change whether or not the contract moved and the signal this exists for gets buried in
 * noise. Without it, re-exporting when nothing has changed produces a byte-identical file:
 * run the export, and if git says nothing changed, the contract did not move. When it did,
 * the diff names exactly which terms.
 *
 * The timestamp still exists, on the side that can use it — the export ledger below.
 */
export function snapshotOf(terms: Term[]): Snapshot {
  const entries: SnapshotTerm[] = [...terms]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((term) => ({ name: term.name, type: term.type, hash: hashTerm(term) }))

  return { fingerprint: digest(entries), terms: entries }
}

export interface ExportRecord {
  fingerprint: string
  exportedAt: string
}

/**
 * Remembered so staleness is answerable from this side alone.
 *
 * The spec tool cannot see `app/` — that is the whole point of the sandbox — so it cannot
 * read the snapshot to check whether it is current. What it can know is what it last handed
 * out. "The glossary has changed since the last export" is the same question from the only
 * angle available, and it needs no visibility into the container at all.
 */
export function recordExport(snapshot: Snapshot, exportedAt: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(LEDGER, `${JSON.stringify({ fingerprint: snapshot.fingerprint, exportedAt }, null, 2)}\n`)
  } catch (cause) {
    // Losing this costs a staleness warning, never a decision. Not worth failing the export.
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
