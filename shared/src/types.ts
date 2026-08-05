/**
 * The glossary schema. These types are the contract between the human authoring
 * specs in the UI and the AI agent that implements them — everything else in this
 * repo is a view over data shaped like this.
 */

export type TermType = 'entity' | 'event' | 'function' | 'attribute-type'

export const TERM_TYPES: readonly TermType[] = [
  'entity',
  'event',
  'function',
  'attribute-type',
]

export interface Attribute {
  name: string
  /** A primitive (`string`, `number`, `boolean`, `date`) or `ref:<TermName>`, either with an optional `[]` suffix. */
  valueType: string
  default?: unknown
  optional?: boolean
}

export interface Term {
  name: string
  type: TermType
  /** Short natural-language description — spec-worthy, precise enough to generate tests from. */
  spec: string
  /** Single supertype (is-a), or null. */
  parent: string | null
  /** Free cross-cutting labels; not a hierarchy. */
  tags: string[]
  attributes: Attribute[]
}

/** How the AI (or a hand-authored fixture) proposes an edit: structured ops, never free text. */
export type Op =
  | {
      op: 'add_entity'
      term: string
      /** Defaults to `entity`; carries the other kinds so one op can add functions and events too. */
      termType?: TermType
      parent?: string | null
      spec: string
      tags?: string[]
      attributes?: Attribute[]
    }
  | { op: 'remove_entity'; term: string }
  | { op: 'add_attribute'; term: string; attribute: Attribute }
  | { op: 'remove_attribute'; term: string; attribute: string }
  | { op: 'modify_spec'; term: string; spec: string }

export type OpKind = Op['op']

export interface Changeset {
  id: string
  summary: string
  ops: Op[]
  /** Plain-language test intentions; a changeset carrying passing tests is safer to auto-approve. */
  tests: string[]
  /** Set when this changeset was minted by answering a Question — the id of that question. */
  fromQuestion?: string
  /** ISO timestamp, written when the changeset lands. Absent while it is still pending. */
  appliedAt?: string
  /**
   * When code was written for this change. `null` means applied but not yet implemented —
   * the state the `implements:` markers cannot detect, because a rewritten spec leaves
   * every marker looking correct. Absent on changesets applied before this was tracked.
   */
  implementedAt?: string | null
}

/**
 * A question raised against the glossary — normally by an agent that tried to implement
 * it and hit something the specs do not settle.
 *
 * The unit here is deliberately a *question*, not a "finding": if an entry cannot be
 * phrased as something the human answers, it does not belong in the queue. That rules out
 * the observations an implementation pass would otherwise flood it with, and it keeps the
 * agent from quietly making product decisions by dressing a guess up as a proposal.
 */
export interface Question {
  id: string
  /** The question itself, answerable as written. */
  asks: string
  /** Why it is being asked — must quote the spec text in conflict, not just describe inconvenience. */
  because: string
  raisedBy: QuestionOrigin
  /**
   * Candidate answers. The count is the answer shape, so there is no separate field to
   * keep in sync: one option is approve-or-decline, several is a choice, none means only
   * the human can write the spec text.
   */
  options: QuestionOption[]
  /** Null while open. Kept after answering — the reasoning outlives the changeset. */
  answer: Answer | null
}

export interface QuestionOrigin {
  /** What was being done when it came up, e.g. `implementation`. */
  pass: string
  file?: string
  /** Terms the question is about, so it can be shown against them in the glossary. */
  terms: string[]
}

export interface QuestionOption {
  label: string
  /** The tradeoff in plain language, including what answering this way costs. */
  detail?: string
  /** What would go into the pending queue. Null when this option changes no specs. */
  proposal: Proposal | null
}

/** A changeset body without an id — the id is minted when the option is chosen. */
export interface Proposal {
  summary: string
  ops: Op[]
  tests: string[]
}

export interface Answer {
  /** Label of the chosen option, or null when the human answered without taking one. */
  chose: string | null
  note: string
  /** ISO timestamp. */
  answeredAt: string
  /** Id of the changeset this answer put into the pending queue, if any. */
  changesetId?: string
}

export type Severity = 'error' | 'warning'

export interface Diagnostic {
  /** Index into the op list this diagnostic belongs to, or null when it describes the resulting state as a whole. */
  opIndex: number | null
  severity: Severity
  message: string
}

/** A term file that could not be read or did not match the schema. Surfaced in the UI instead of crashing. */
export interface SourceProblem {
  file: string
  message: string
}
