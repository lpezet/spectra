/**
 * `@spectra/drift-check` — the offline drift check between a Spectra glossary and the code that
 * implements it, as a small package a consumer project depends on.
 *
 * A project keeps a `specs.snapshot.json` (written by @coder's `export_specs`, committed with the
 * code) and `// implements: <Term>` markers in its source. This checks the two agree — offline, with
 * no coordinator running — so it works both in a bare copy of the project and inside @coder's sandbox.
 * It replaces the per-project copied files the check used to be (see `backup/todo-app`).
 *
 * Usage in a consumer project's test (framework-agnostic core; example in vitest):
 *
 *   import { driftCheck } from '@spectra/drift-check'
 *   import { expect, it } from 'vitest'
 *   it('the glossary and the code are in sync', () => {
 *     const { ok, findings } = driftCheck({ srcDir: 'src', snapshotPath: 'specs.snapshot.json' })
 *     expect(ok, findings.map((f) => f.message).join('\n')).toBe(true)
 *   })
 */
export { readMarkers, readSnapshot, implementersOf } from './implements.js'
export type { Marker, Snapshot, TermRecord, ExpectationRecord } from './implements.js'
export { checkDrift, driftCheck } from './check.js'
export type { DriftFinding, DriftFindingKind } from './check.js'
