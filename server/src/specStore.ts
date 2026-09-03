/**
 * The storage seam for the glossary (GH #3).
 *
 * Why this exists: specs are a shared human artifact, not a byproduct of the code. To make
 * them centrally visible to a team (and later multi-tenant/hosted), the content of `specs/`
 * has to be able to live somewhere other than the local filesystem. This interface is the
 * one place that decides *where*; `FileSystemSpecStore` (today's behaviour) and a future
 * `SqlSpecStore` are peers behind it. "Hosted" is a deployment axis, not a third backend.
 *
 * The boundary, stated so we do not blur it:
 *   - SpecStore is PERSISTENCE ONLY — reads, id allocation, and writes. Domain logic stays
 *     in the caller: the changeset engine (`applyOps`), validation (`parseTerm`/…),
 *     diagnostics, and version-guard decisions all remain in commit.ts / propose.ts /
 *     answer.ts / raise.ts / expectations.ts, which compose a SpecStore rather than living
 *     inside it.
 *   - Records are addressed by DOMAIN ID (`term.name`, `changeset.id`, `q-…`, `e-…`). No
 *     filename or path is used to *address* anything — the FS impl keeps its id→file map
 *     private, which is what lets a SQL row id stand in with no change to the caller. The one
 *     value that crosses the line is `StoredAt`, returned by the create methods purely so the
 *     caller can echo "where it landed" in a response; it is opaque and never parsed.
 *   - STATE IS DATA, NOT LOCATION. Today "applied" means a file sits in `applied/` and
 *     "retired" means it sits in `retired/`; here those are state transitions named as
 *     methods. The reads still return the partitioned view; only the FS impl backs it with
 *     folders.
 *   - `problems` survives: a record that will not load is reported, not thrown. It is an FS
 *     truth today (hand-edited files) but an API backend can return partial data too. What
 *     does NOT survive is "re-read from disk every call" — that is an FS detail.
 *
 * Not in scope: `data/transcripts.db` (chat history, its own store) and the version guard /
 * `app/specs.snapshot.json` (tabled — a `version()` method belongs here eventually, once the
 * snapshot is reworked into a queryable authority; deliberately left out of this first slice).
 */
import type { Answer, Changeset, Expectation, Op, Question, SourceProblem, Term } from '@tb/shared'

// ── Partitioned read shapes (relocated here from store.ts — this interface is their home) ──

export interface Glossary {
  terms: Term[]
  problems: SourceProblem[]
}

export interface PendingChangesets {
  changesets: Changeset[]
  problems: SourceProblem[]
  /**
   * What has landed and what was turned down, newest first. Each entry is a distinct set of
   * ops, so a changeset applied in two partial passes appears twice — the honest count.
   */
  applied: Changeset[]
  rejected: Changeset[]
}

export interface QuestionFeed {
  questions: Question[]
  problems: SourceProblem[]
}

export interface ExpectationFeed {
  /** Published, live expectations — what is currently expected to hold. Excludes drafts. */
  expectations: Expectation[]
  /**
   * Drafts — live but not yet published, so they count toward nothing (coverage, the versioned
   * contract, the agents' view) and are returned only for their author's own authoring UI.
   */
  drafts: Expectation[]
  /** Superseded ones, kept so a test citing a retired id still resolves and the reason survives. */
  retired: Expectation[]
  problems: SourceProblem[]
}

/**
 * Where the store put a newly created record. Opaque to callers — a filename for the
 * filesystem backend, a row id for SQL — echoed back in responses, never parsed.
 */
export type StoredAt = string

/**
 * One atomic application (#1, Trap 1). commit.ts runs the engine to produce the post-image,
 * then hands the whole thing here as ONE call so the term writes and the pending→applied move
 * commit together. On the filesystem this is the `writeAtomic` dance (which can half-land
 * across files); on SQL it becomes a real transaction.
 */
export interface CommitApplication {
  /** The pending changeset being (partially) applied. */
  changesetId: string
  /** Full post-image of the glossary the engine produced — the store reconciles disk to this. */
  nextTerms: Term[]
  /** The ops that landed, recorded into the applied record. */
  appliedOps: Op[]
  /** Ops left unselected: they stay pending. Empty means the pending changeset is removed. */
  remainingOps: Op[]
  /** Caller's clock, so this stays testable. */
  appliedAt: string
}

/** What changed, in the store's own terms (filenames for FS, opaque strings for SQL). */
export interface CommitResult {
  written: string[]
  deleted: string[]
  /** Where the applied record now lives — the old relative-path `resolvedTo`, kept verbatim. */
  resolvedTo: string
}

export interface SpecStore {
  // ── Reads ──────────────────────────────────────────────────────────────────────────
  // Partitioned by state, returning domain objects. No file handles.
  readTerms(): Promise<Glossary>
  readChangesets(): Promise<PendingChangesets>
  readQuestions(): Promise<QuestionFeed>
  readExpectations(): Promise<ExpectationFeed>

  findChangeset(id: string): Promise<Changeset | null>
  findQuestion(id: string): Promise<Question | null>
  findExpectation(id: string): Promise<Expectation | null>

  // ── Id allocation ──────────────────────────────────────────────────────────────────
  // Replaces uniquePath + the per-writer nextId scanners. The store owns id generation
  // because a SQL backend does it with a sequence/constraint, not by probing for a free
  // filename. Each counts the partitions that must not hand an id out twice.
  nextChangesetId(): Promise<string> // scans pending + applied + rejected
  nextQuestionId(): Promise<string>
  nextExpectationId(): Promise<string> // counts retired too

  // ── Writes ─────────────────────────────────────────────────────────────────────────
  // Validated domain objects in; state transitions are explicit method names.
  addChangeset(changeset: Changeset): Promise<StoredAt> // enters pending
  addQuestion(question: Question): Promise<StoredAt>
  addExpectation(expectation: Expectation): Promise<StoredAt> // enters live

  /** Atomic: reconcile terms to the post-image and move the changeset pending → applied. */
  commitApplication(application: CommitApplication): Promise<CommitResult>
  /** Move a pending changeset to rejected. Returns where it landed, or null if none matched. */
  rejectChangeset(id: string): Promise<string | null>
  /** Record code written against an applied changeset. Where it lives, or null if none matched. */
  markImplemented(id: string, at: string): Promise<StoredAt | null>

  /** Write an answer into an open question (open → answered), in place. */
  writeAnswer(questionId: string, answer: Answer): Promise<void>

  /** Move a live expectation to retired, storing the given retired record. False if none live. */
  retireExpectation(id: string, retired: Expectation): Promise<boolean>
  /** Rewrite a live expectation in place (e.g. after a recheck). Where it lives, or null if none. */
  rewriteExpectation(expectation: Expectation): Promise<StoredAt | null>
}
