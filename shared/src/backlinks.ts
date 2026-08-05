/**
 * The glossary's edges, derived rather than stored. Nothing in a term file records
 * "who points at me" — it is recomputed from `parent` and `ref:` attribute types on
 * every read, so a hand-edit can never leave a stale backlink behind.
 */
import type { Term } from './types.js'
import { parseValueType } from './valueType.js'

export type ReferenceKind = 'parent' | 'attribute'

export interface Reference {
  /** The term doing the referencing. */
  from: string
  /** The term name being referenced — may not exist, see `dangling`. */
  to: string
  kind: ReferenceKind
  /** The attribute carrying the reference, or null for an `is-a` edge. */
  via: string | null
  array: boolean
}

export interface Backlinks {
  references: Reference[]
  /** Edges pointing *at* a term, keyed by target name. */
  byTarget: Record<string, Reference[]>
  /** Edges pointing *out of* a term, keyed by source name. */
  bySource: Record<string, Reference[]>
  /** Subtypes, keyed by supertype name. */
  children: Record<string, string[]>
  /** Edges whose target does not exist in the glossary. */
  dangling: Reference[]
}

export function computeBacklinks(terms: Term[]): Backlinks {
  const known = new Set(terms.map((term) => term.name))
  const references: Reference[] = []

  for (const term of terms) {
    if (term.parent) {
      references.push({ from: term.name, to: term.parent, kind: 'parent', via: null, array: false })
    }
    for (const attribute of term.attributes) {
      const parsed = parseValueType(attribute.valueType)
      if (parsed?.kind === 'ref') {
        references.push({
          from: term.name,
          to: parsed.name,
          kind: 'attribute',
          via: attribute.name,
          array: parsed.array,
        })
      }
    }
  }

  const byTarget: Record<string, Reference[]> = {}
  const bySource: Record<string, Reference[]> = {}
  const children: Record<string, string[]> = {}

  for (const reference of references) {
    ;(byTarget[reference.to] ??= []).push(reference)
    ;(bySource[reference.from] ??= []).push(reference)
    if (reference.kind === 'parent') {
      ;(children[reference.to] ??= []).push(reference.from)
    }
  }

  return {
    references,
    byTarget,
    bySource,
    children,
    dangling: references.filter((reference) => !known.has(reference.to)),
  }
}

export type HighlightKind = 'selected' | 'parent' | 'child' | 'referrer' | 'referenced'

/**
 * Everything connected to `name`, in either direction, labelled by how. Drives
 * click-a-term-to-highlight-what-it-touches — the search-first stand-in for wires.
 */
export function connectionsFor(backlinks: Backlinks, name: string): Map<string, HighlightKind> {
  const connections = new Map<string, HighlightKind>()

  // Weakest first: later writes win, so `selected` and is-a edges beat plain references.
  for (const reference of backlinks.bySource[name] ?? []) {
    if (reference.kind === 'attribute') connections.set(reference.to, 'referenced')
  }
  for (const reference of backlinks.byTarget[name] ?? []) {
    if (reference.kind === 'attribute') connections.set(reference.from, 'referrer')
  }
  for (const reference of backlinks.bySource[name] ?? []) {
    if (reference.kind === 'parent') connections.set(reference.to, 'parent')
  }
  for (const child of backlinks.children[name] ?? []) {
    connections.set(child, 'child')
  }

  connections.set(name, 'selected')
  return connections
}
