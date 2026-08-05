/**
 * The drift check between the glossary and this app.
 *
 * This is the test that answers "do I need to re-run the implementation pass?" without
 * anyone remembering to ask. When a changeset adds a term, this goes red until something
 * in app/ claims it.
 *
 * What it cannot catch: a changeset that *rewrites* an existing term's spec. The marker
 * still names the term and still looks correct, so the code silently drifts from the
 * prose. That case needs the `implementedAt` flag on the applied changeset, not this.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { implementersOf, readGlossary, readMarkers } from './implements.js'

const APP_SRC = path.resolve(import.meta.dirname)
const TERMS = path.resolve(import.meta.dirname, '../../specs/terms')

const markers = readMarkers(APP_SRC)
const glossary = readGlossary(TERMS)
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

  it('only name terms that exist', () => {
    const known = new Set(glossary.map((term) => term.name))
    const unknown = markers.flatMap((marker) =>
      marker.terms.filter((term) => !known.has(term)).map((term) => `${marker.file}:${marker.line} — ${term}`),
    )

    expect(unknown, 'a marker names a term the glossary does not have — renamed or removed?').toEqual([])
  })

  it('cover every entity, function and event in the glossary', () => {
    const missing = glossary
      .filter((term) => NEEDS_IMPLEMENTING.has(term.type))
      .filter((term) => !implementers.has(term.name))
      .map((term) => `${term.name} (${term.type})`)

    expect(missing, 'the glossary has terms nothing in app/ implements — an implementation pass is due').toEqual([])
  })
})
