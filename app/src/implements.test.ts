/**
 * The drift check between the glossary and this app.
 *
 * This is the test that answers "do I need to re-run the implementation pass?" without
 * anyone remembering to ask. When a changeset adds a term, this goes red until something
 * in app/ claims it.
 *
 * It checks against `specs.snapshot.json` rather than `specs/terms`, and that is not a
 * compromise — it is what makes the check work at all in the two places it matters. `app/`
 * stands alone: copy the directory anywhere and `npm test` passes, with no repo and no spec
 * tool around it. And @coder's sandbox cannot see `specs/` by design, which is exactly where
 * this check had started skipping. A committed file works in both; a live lookup works in
 * neither.
 *
 * The snapshot is written by @coder from the export_glossary tool and committed with the
 * code. It can go stale — that is the cost — and the spec tool answers that from its own
 * side at GET /api/glossary/snapshot, by remembering what it last handed out.
 *
 * What this still cannot catch: a changeset that *rewrites* an existing term's spec. The
 * marker still names the term and still looks correct. But each snapshot entry carries a
 * hash of the spec, parent and attributes, so refreshing the file makes `git diff
 * specs.snapshot.json` name the terms that moved. The test cannot see it; review can.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { implementersOf, readMarkers, readSnapshot } from './implements.js'

const APP_SRC = path.resolve(import.meta.dirname)
const SNAPSHOT = path.resolve(import.meta.dirname, '../specs.snapshot.json')

const present = existsSync(SNAPSHOT)

const markers = readMarkers(APP_SRC)
const snapshot = present ? readSnapshot(SNAPSHOT) : null
const implementers = implementersOf(markers)

/** attribute-types are value shapes carried by other terms; they need no file of their own. */
const NEEDS_IMPLEMENTING = new Set(['entity', 'function', 'event'])

describe('implements markers', () => {
  it('finds markers at all', () => {
    expect(markers.length).toBeGreaterThan(0)
  })

  it('are all well-formed', () => {
    const bad = markers
      .filter((marker) => marker.malformed.length > 0)
      .map((marker) => `${marker.file}:${marker.line} — ${marker.malformed.join(', ')}`)

    expect(bad, 'a marker must be comma-separated bare term names; put prose on the next line').toEqual([])
  })
})

describe('the glossary snapshot', () => {
  /**
   * A hard failure, not a skip. The old version skipped when it could not reach `specs/`,
   * because that was a situation nobody could fix from inside app/. This one is committed to
   * the repo, so its absence is a missing file rather than a missing service — and a green
   * run that silently checked nothing is the outcome worth refusing.
   */
  it('is present — run export_glossary and commit the result if this fails', () => {
    expect(present, `no snapshot at ${SNAPSHOT}`).toBe(true)
    expect(snapshot?.terms.length ?? 0).toBeGreaterThan(0)
  })

  it('only has markers naming terms that exist', () => {
    const known = new Set(snapshot?.terms.map((term) => term.name) ?? [])
    const unknown = markers.flatMap((marker) =>
      marker.terms.filter((term) => !known.has(term)).map((term) => `${marker.file}:${marker.line} — ${term}`),
    )

    expect(unknown, 'a marker names a term the glossary does not have — renamed or removed?').toEqual([])
  })

  it('has every entity, function and event implemented somewhere', () => {
    const missing = (snapshot?.terms ?? [])
      .filter((term) => NEEDS_IMPLEMENTING.has(term.type))
      .filter((term) => !implementers.has(term.name))
      .map((term) => `${term.name} (${term.type})`)

    expect(missing, 'the glossary has terms nothing in app/ implements — an implementation pass is due').toEqual([])
  })
})
