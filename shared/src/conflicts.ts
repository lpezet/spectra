/**
 * "Where should I start?" as a computation rather than a judgement call.
 *
 * Every pending item — a changeset, or one option of an unanswered question — is a list
 * of ops. Whether two of them interact is not a question about term names overlapping
 * (cs-001 and q-001 both touch `Task` and get along fine); it is a question about whether
 * applying one *breaks* the other. So rather than analysing statically, this replays them
 * through the same engine that commits them and reads the diagnostics.
 *
 * Order matters and that is the useful part: adding `Project.archived` before dropping
 * `Project` is fine, and doing it after is an error. "Do this one first" is exactly the
 * answer being asked for.
 */
import { applyOps } from './changeset.js'
import type { Diagnostic, Op } from './types.js'
import type { Term } from './types.js'

export interface PendingItem {
  /** Changeset id, or `<questionId>:<option label>` for a question's proposal. */
  id: string
  kind: 'changeset' | 'question-option'
  label: string
  ops: Op[]
}

export interface ItemReport {
  id: string
  kind: PendingItem['kind']
  label: string
  /** Problems this item has on its own, against the glossary as it stands. */
  diagnostics: Diagnostic[]
}

export interface Conflict {
  /** Applying `first` before `second` is what causes the problems below. */
  first: string
  second: string
  diagnostics: Diagnostic[]
}

export interface ConflictReport {
  items: ItemReport[]
  conflicts: Conflict[]
  /** Items that interact with nothing else — safe in any order, at any time. */
  independent: string[]
}

function fingerprint(diagnostic: Diagnostic): string {
  return `${diagnostic.severity}|${diagnostic.message}`
}

/**
 * Problems that only exist because `first` ran before `second` — anything either one
 * already had on its own is not the pair's fault.
 */
function newProblems(terms: Term[], first: PendingItem, second: PendingItem): Diagnostic[] {
  const alone = new Set([
    ...applyOps(terms, first.ops).diagnostics.map(fingerprint),
    ...applyOps(terms, second.ops).diagnostics.map(fingerprint),
  ])

  return applyOps(terms, [...first.ops, ...second.ops]).diagnostics.filter(
    (diagnostic) => !alone.has(fingerprint(diagnostic)),
  )
}

export function analyzePending(terms: Term[], items: PendingItem[]): ConflictReport {
  const reports: ItemReport[] = items.map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.label,
    diagnostics: applyOps(terms, item.ops).diagnostics,
  }))

  const conflicts: Conflict[] = []
  const entangled = new Set<string>()

  for (const first of items) {
    for (const second of items) {
      if (first.id === second.id) continue

      // Two options of the same question are alternatives, not a sequence — nobody will
      // ever apply both, so reporting them as conflicting is noise.
      if (first.kind === 'question-option' && second.kind === 'question-option') {
        if (questionOf(first.id) === questionOf(second.id)) continue
      }

      const diagnostics = newProblems(terms, first, second)
      if (diagnostics.length === 0) continue

      conflicts.push({ first: first.id, second: second.id, diagnostics })
      entangled.add(first.id)
      entangled.add(second.id)
    }
  }

  return {
    items: reports,
    conflicts,
    independent: items.filter((item) => !entangled.has(item.id)).map((item) => item.id),
  }
}

function questionOf(id: string): string {
  return id.split(':')[0] ?? id
}
