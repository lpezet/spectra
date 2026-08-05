import type { Changeset, Diagnostic, OpEffect, Term } from '@tb/shared'
import { applyOps } from '@tb/shared'

export type TermStatus = 'add' | 'remove' | 'modify'

export interface Review {
  /** The glossary as it would look if the selected ops were applied. */
  projected: Term[]
  /** Diagnostics with `opIndex` remapped back to positions in the full changeset. */
  diagnostics: Diagnostic[]
  diagnosticsByOp: Map<number, Diagnostic[]>
  /** Diagnostics about the resulting state as a whole rather than one op. */
  overall: Diagnostic[]
  effects: OpEffect[]
  statuses: Map<string, TermStatus>
  hasErrors: boolean
  hasWarnings: boolean
}

/**
 * Runs the selected subset of a changeset against the current glossary.
 *
 * The engine only sees the ops that are checked, so their indices no longer line up
 * with the changeset the human is looking at — everything coming back gets remapped
 * to the original positions before the UI ever sees it.
 */
export function reviewChangeset(
  terms: Term[],
  changeset: Changeset,
  selected: ReadonlySet<number>,
): Review {
  const indices = [...selected].sort((a, b) => a - b)
  const result = applyOps(
    terms,
    indices.map((index) => changeset.ops[index]!),
  )

  const diagnostics = result.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    opIndex: diagnostic.opIndex === null ? null : (indices[diagnostic.opIndex] ?? null),
  }))
  const effects = result.effects.map((effect) => ({ ...effect, index: indices[effect.index]! }))

  const diagnosticsByOp = new Map<number, Diagnostic[]>()
  const overall: Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    if (diagnostic.opIndex === null) {
      overall.push(diagnostic)
    } else {
      const list = diagnosticsByOp.get(diagnostic.opIndex)
      if (list) list.push(diagnostic)
      else diagnosticsByOp.set(diagnostic.opIndex, [diagnostic])
    }
  }

  const statuses = new Map<string, TermStatus>()
  for (const effect of effects) {
    if (!effect.ok) continue
    if (effect.op.op === 'add_entity') statuses.set(effect.term, 'add')
    else if (effect.op.op === 'remove_entity') statuses.set(effect.term, 'remove')
    else if (!statuses.has(effect.term)) statuses.set(effect.term, 'modify')
  }

  return {
    projected: result.terms,
    diagnostics,
    diagnosticsByOp,
    overall,
    effects,
    statuses,
    hasErrors: diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    hasWarnings: diagnostics.some((diagnostic) => diagnostic.severity === 'warning'),
  }
}
