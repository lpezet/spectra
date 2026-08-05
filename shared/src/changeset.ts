/**
 * Replaying changeset ops against the glossary. Pure — no filesystem — so the web app
 * can preview exactly what the server will commit, and both agree on what counts as
 * broken. Ops are applied in order and each one can fail independently; a failed op is
 * skipped rather than aborting the run, so the UI can show every problem at once.
 */
import { computeBacklinks } from './backlinks.js'
import type { Reference } from './backlinks.js'
import type { Diagnostic, Op, Term } from './types.js'

export type OpKindClass = 'add' | 'remove' | 'modify'

export interface OpEffect {
  index: number
  op: Op
  kind: OpKindClass
  term: string
  /** Target term immediately before this op, or null if it did not exist yet. */
  before: Term | null
  /** Target term immediately after. Equal to `before` when the op failed. */
  after: Term | null
  ok: boolean
}

export interface ApplyResult {
  terms: Term[]
  diagnostics: Diagnostic[]
  effects: OpEffect[]
}

export function opKindClass(op: Op): OpKindClass {
  switch (op.op) {
    case 'add_entity':
    case 'add_attribute':
      return 'add'
    case 'remove_entity':
    case 'remove_attribute':
      return 'remove'
    case 'modify_spec':
      return 'modify'
  }
}

function referenceKey(reference: Reference): string {
  return `${reference.from}|${reference.via ?? ''}|${reference.to}`
}

function edgeKey(from: string, via: string | null): string {
  return `${from}|${via ?? ''}`
}

function describeEdge(reference: Reference): string {
  return reference.via ? `${reference.from}.${reference.via}` : `${reference.from}'s parent`
}

export function applyOps(terms: Term[], ops: Op[]): ApplyResult {
  const byName = new Map(terms.map((term) => [term.name, structuredClone(term)] as const))
  const diagnostics: Diagnostic[] = []
  const effects: OpEffect[] = []
  /** Edges this op selection creates, so a dangling one can be blamed on the op that made it. */
  const introduced = new Map<string, number>()

  const snapshot = (name: string): Term | null => {
    const term = byName.get(name)
    return term ? structuredClone(term) : null
  }

  ops.forEach((op, index) => {
    const before = snapshot(op.term)
    const kind = opKindClass(op)

    const fail = (message: string) => {
      diagnostics.push({ opIndex: index, severity: 'error', message })
      effects.push({ index, op, kind, term: op.term, before, after: before, ok: false })
    }
    const done = () => {
      effects.push({ index, op, kind, term: op.term, before, after: snapshot(op.term), ok: true })
    }

    switch (op.op) {
      case 'add_entity': {
        if (byName.has(op.term)) return fail(`"${op.term}" already exists.`)
        const created: Term = {
          name: op.term,
          type: op.termType ?? 'entity',
          spec: op.spec,
          parent: op.parent ?? null,
          tags: op.tags ?? [],
          attributes: op.attributes ?? [],
        }
        byName.set(op.term, created)
        if (created.parent) introduced.set(edgeKey(op.term, null), index)
        for (const attribute of created.attributes) {
          introduced.set(edgeKey(op.term, attribute.name), index)
        }
        return done()
      }

      case 'remove_entity': {
        if (!byName.has(op.term)) return fail(`"${op.term}" does not exist.`)
        byName.delete(op.term)
        return done()
      }

      case 'add_attribute': {
        const target = byName.get(op.term)
        if (!target) return fail(`"${op.term}" does not exist.`)
        if (target.attributes.some((existing) => existing.name === op.attribute.name)) {
          return fail(`"${op.term}" already has an attribute named "${op.attribute.name}".`)
        }
        target.attributes.push(structuredClone(op.attribute))
        introduced.set(edgeKey(op.term, op.attribute.name), index)
        return done()
      }

      case 'remove_attribute': {
        const target = byName.get(op.term)
        if (!target) return fail(`"${op.term}" does not exist.`)
        const at = target.attributes.findIndex((existing) => existing.name === op.attribute)
        if (at === -1) return fail(`"${op.term}" has no attribute named "${op.attribute}".`)
        target.attributes.splice(at, 1)
        return done()
      }

      case 'modify_spec': {
        const target = byName.get(op.term)
        if (!target) return fail(`"${op.term}" does not exist.`)
        target.spec = op.spec
        return done()
      }
    }
  })

  const result = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))

  // Only edges this selection *newly* breaks are its problem — a glossary that was
  // already broken by hand stays broken without blaming the changeset for it.
  const alreadyDangling = new Set(computeBacklinks(terms).dangling.map(referenceKey))

  for (const reference of computeBacklinks(result).dangling) {
    if (alreadyDangling.has(referenceKey(reference))) continue

    const culprit = introduced.get(edgeKey(reference.from, reference.via))
    if (culprit !== undefined) {
      // The selection adds a reference to something it never creates — usually a
      // cherry-pick that left its dependency behind. Nothing to acknowledge; it is wrong.
      diagnostics.push({
        opIndex: culprit,
        severity: 'error',
        message: `${describeEdge(reference)} references "${reference.to}", which does not exist. The op that creates it is not part of this selection.`,
      })
    } else {
      // A reference that was fine until this selection removed its target. Real, but the
      // human may mean it — surface it and make them say so.
      diagnostics.push({
        opIndex: null,
        severity: 'warning',
        message: `${describeEdge(reference)} references "${reference.to}", which this change removes.`,
      })
    }
  }

  return { terms: result, diagnostics, effects }
}

export function validateOps(terms: Term[], ops: Op[]): Diagnostic[] {
  return applyOps(terms, ops).diagnostics
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
}

export function hasWarnings(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'warning')
}

/** One-line human summary of an op, for the review list. */
export function summarizeOp(op: Op): string {
  switch (op.op) {
    case 'add_entity':
      return `add ${op.termType ?? 'entity'} ${op.term}${op.parent ? ` (is-a ${op.parent})` : ''}`
    case 'remove_entity':
      return `remove ${op.term}`
    case 'add_attribute':
      return `add ${op.term}.${op.attribute.name}: ${op.attribute.valueType}`
    case 'remove_attribute':
      return `remove ${op.term}.${op.attribute}`
    case 'modify_spec':
      return `rewrite the spec of ${op.term}`
  }
}
