/**
 * The drift check itself — "do the glossary and the code still agree?" — as pure findings.
 *
 * Kept framework-agnostic on purpose: it returns a list of problems rather than asserting, so a
 * consumer project turns it into a one-line test in whatever runner it already uses (see the README).
 * Empty list means the code and the committed snapshot are in sync.
 *
 * What it catches, and what it deliberately cannot: a malformed marker, a marker naming a term the
 * glossary no longer has, and a term (entity/function/event) nothing implements. It cannot catch a
 * term whose *spec was rewritten* — the marker still names it and still looks right. That is what the
 * per-term `hash` in the snapshot is for: refreshing the file makes `git diff specs.snapshot.json`
 * name the terms that moved, so the check fails loud for structure and review catches the rest.
 */
import { existsSync } from 'node:fs'
import { implementersOf, readMarkers, readSnapshot } from './implements.js'
import type { Marker, Snapshot } from './implements.js'

export type DriftFindingKind =
  | 'no-snapshot'
  | 'no-markers'
  | 'malformed-marker'
  | 'unknown-term'
  | 'unimplemented-term'

export interface DriftFinding {
  kind: DriftFindingKind
  message: string
}

/** Terms that must be implemented by code. attribute-types are value shapes carried by other terms. */
const NEEDS_IMPLEMENTING = new Set(['entity', 'function', 'event'])

/**
 * Compare markers against a snapshot. A null snapshot is itself the finding — a missing committed
 * file, not a missing service, so it fails hard rather than skipping (a green run that checked
 * nothing is the outcome worth refusing).
 */
export function checkDrift(markers: Marker[], snapshot: Snapshot | null): DriftFinding[] {
  if (!snapshot) {
    return [{ kind: 'no-snapshot', message: 'No specs.snapshot.json — run export_specs and commit the result.' }]
  }

  const findings: DriftFinding[] = []

  if (markers.length === 0) {
    findings.push({ kind: 'no-markers', message: 'No `// implements:` markers found under the scanned directory.' })
  }

  for (const marker of markers) {
    if (marker.malformed.length > 0) {
      findings.push({
        kind: 'malformed-marker',
        message: `${marker.file}:${marker.line} — not bare identifiers: ${marker.malformed.join(', ')} (put prose on the next line)`,
      })
    }
  }

  const known = new Set(snapshot.terms.map((term) => term.name))
  for (const marker of markers) {
    for (const term of marker.terms) {
      if (!known.has(term)) {
        findings.push({ kind: 'unknown-term', message: `${marker.file}:${marker.line} — marker names "${term}", not in the glossary (renamed or removed?)` })
      }
    }
  }

  const implementers = implementersOf(markers)
  for (const term of snapshot.terms) {
    if (NEEDS_IMPLEMENTING.has(term.type) && !implementers.has(term.name)) {
      findings.push({ kind: 'unimplemented-term', message: `${term.name} (${term.type}) — nothing implements it; an implementation pass is due` })
    }
  }

  return findings
}

/**
 * Read markers from `srcDir` and the snapshot at `snapshotPath`, and run the check. The convenience
 * a consumer project's test calls: `const { ok, findings } = driftCheck({ srcDir, snapshotPath })`.
 */
export function driftCheck(opts: { srcDir: string; snapshotPath: string }): { ok: boolean; findings: DriftFinding[] } {
  const markers = readMarkers(opts.srcDir)
  const snapshot = existsSync(opts.snapshotPath) ? readSnapshot(opts.snapshotPath) : null
  const findings = checkDrift(markers, snapshot)
  return { ok: findings.length === 0, findings }
}
