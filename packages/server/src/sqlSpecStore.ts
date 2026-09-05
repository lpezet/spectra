/**
 * The SQL backing for the glossary — a peer of {@link FileSystemSpecStore} behind {@link SpecStore}.
 *
 * This is the second implementation the interface was built for: the same contract, backed by a
 * table per collection instead of a directory. It is what lets the glossary live somewhere a team
 * (and later a hosted, multi-tenant deployment) can reach — the filesystem impl serves a single
 * local checkout; this one serves a database, and the D1 target reuses the same SQL.
 *
 * The two principles the interface named, made concrete here:
 *   - **State is data, not location.** Where the FS impl moves a file into `applied/` or `retired/`,
 *     this sets a `status` / `lifecycle` column. The partitioned reads are the same query, filtered.
 *   - **Records are addressed by domain id.** The primary key IS the domain id (`term.name`,
 *     `changeset.id`, `q-…`, `e-…`), so a duplicate cannot exist by construction — the FS impl's
 *     duplicate-detection has nothing to report here.
 *
 * Each row stores the record's full JSON (validated on read the same way, so a somehow-corrupt row
 * becomes a `problem` rather than throwing) plus the few columns the store needs to address and
 * partition it. `node:sqlite` is synchronous; the async method signatures wrap sync calls, and
 * `:memory:` makes the store trivially testable.
 *
 * This is slice 1: reads, id allocation, and the simple creates. The state-transition writes
 * (apply, reject, answer, retire, rewrite) and their real optimistic-concurrency enforcement are
 * slice 2 — stubbed below so the class is a complete `SpecStore` in type but honest about what runs.
 */
import { DatabaseSync } from 'node:sqlite'
import {
  parseChangeset,
  parseExpectation,
  parseProjectInfo,
  parseQuestion,
  parseTerm,
} from '@spectra/core'
import type {
  Answer,
  Changeset,
  Expectation,
  ProjectInfo,
  Question,
  SourceProblem,
} from '@spectra/core'
import type {
  CommitApplication,
  CommitResult,
  ExpectationFeed,
  Glossary,
  MutationResult,
  PendingChangesets,
  QuestionFeed,
  SpecStore,
  StoredAt,
} from './specStore.js'

/** Same neutral default as the FS impl — an unconfigured glossary must not borrow another's name. */
const FALLBACK_PROJECT_INFO: ProjectInfo = {
  name: 'Untitled project',
  domain: 'a shared glossary',
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  domain TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS terms (
  name TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changesets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,           -- pending | applied | rejected
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL DEFAULT 1, -- optimistic-concurrency counter (enforced in slice 2)
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expectations (
  id TEXT PRIMARY KEY,
  lifecycle TEXT NOT NULL,        -- live | retired  (draft/ready is inside the record's own status)
  rev INTEGER NOT NULL DEFAULT 1,
  json TEXT NOT NULL
);
`

interface JsonRow {
  json: string
}

/** Parse the last number out of an id like `chat-004` / `q-012` / `e-3`; -1 if it has none. */
function idNumber(id: string): number {
  const match = /(\d+)\D*$/.exec(id)
  return match ? Number(match[1]) : -1
}

export class SqlSpecStore implements SpecStore {
  private readonly db: DatabaseSync

  /** `file` is a path or `:memory:`, exactly like TranscriptStore. */
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  // ── Project identity ─────────────────────────────────────────────────────────────────

  async projectInfo(): Promise<ProjectInfo> {
    const row = this.db.prepare('SELECT name, domain FROM project WHERE id = 1').get() as
      | { name: string; domain: string }
      | undefined
    if (!row) return FALLBACK_PROJECT_INFO
    const parsed = parseProjectInfo({ name: row.name, domain: row.domain })
    return parsed.ok ? parsed.value : FALLBACK_PROJECT_INFO
  }

  /**
   * Set the glossary's identity. Not part of {@link SpecStore} — the FS impl gets this from a file
   * a human or `spectra init` writes; the SQL impl needs a way to seed the row (init, or a test).
   */
  setProjectInfo(info: ProjectInfo): void {
    this.db
      .prepare(
        `INSERT INTO project (id, name, domain) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, domain = excluded.domain`,
      )
      .run(info.name, info.domain)
  }

  // ── Low-level ────────────────────────────────────────────────────────────────────────

  private rows(sql: string, ...params: Array<string | number>): JsonRow[] {
    return this.db.prepare(sql).all(...params) as unknown as JsonRow[]
  }

  /**
   * Parse each row's JSON with a domain parser, collecting parse failures as `problems` keyed by id
   * rather than throwing — the same graceful degradation the FS reads give. In practice the store
   * only ever writes valid JSON, so `problems` is empty; the path exists because the interface keeps it.
   */
  private parseRows<T extends { id?: string; name?: string }>(
    rows: JsonRow[],
    parse: (data: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  ): { values: T[]; problems: SourceProblem[] } {
    const values: T[] = []
    const problems: SourceProblem[] = []
    for (const row of rows) {
      let data: unknown
      try {
        data = JSON.parse(row.json)
      } catch (error) {
        problems.push({ file: '(row)', message: `invalid JSON — ${(error as Error).message}` })
        continue
      }
      const parsed = parse(data)
      if (parsed.ok) values.push(parsed.value)
      else problems.push({ file: data && typeof data === 'object' ? String((data as { id?: string }).id ?? '(row)') : '(row)', message: parsed.errors.join('; ') })
    }
    return { values, problems }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────

  async readTerms(): Promise<Glossary> {
    const { values, problems } = this.parseRows(this.rows('SELECT json FROM terms'), parseTerm)
    values.sort((a, b) => a.name.localeCompare(b.name))
    return { terms: values, problems }
  }

  async readChangesets(): Promise<PendingChangesets> {
    const pending = this.parseRows(this.rows("SELECT json FROM changesets WHERE status = 'pending'"), parseChangeset)
    const applied = this.parseRows(this.rows("SELECT json FROM changesets WHERE status = 'applied'"), parseChangeset)
    const rejected = this.parseRows(this.rows("SELECT json FROM changesets WHERE status = 'rejected'"), parseChangeset)
    const byAppliedDesc = (a: Changeset, b: Changeset) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? '')
    return {
      changesets: pending.values,
      problems: pending.problems,
      applied: applied.values.sort(byAppliedDesc),
      rejected: rejected.values.sort(byAppliedDesc),
    }
  }

  async readQuestions(): Promise<QuestionFeed> {
    const { values, problems } = this.parseRows(this.rows('SELECT json FROM questions'), parseQuestion)
    return { questions: values, problems }
  }

  async readExpectations(): Promise<ExpectationFeed> {
    const live = this.parseRows(this.rows("SELECT json FROM expectations WHERE lifecycle = 'live'"), parseExpectation)
    const retired = this.parseRows(this.rows("SELECT json FROM expectations WHERE lifecycle = 'retired'"), parseExpectation)
    live.values.sort((a, b) => a.id.localeCompare(b.id))
    retired.values.sort((a, b) => a.id.localeCompare(b.id))
    // Drafts share the live lifecycle with published ones — status is data. Absent status = ready.
    return {
      expectations: live.values.filter((e) => e.status !== 'draft'),
      drafts: live.values.filter((e) => e.status === 'draft'),
      retired: retired.values,
      problems: live.problems,
    }
  }

  private findOne<T>(
    sql: string,
    id: string,
    parse: (data: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  ): T | null {
    const row = this.db.prepare(sql).get(id) as JsonRow | undefined
    if (!row) return null
    const parsed = parse(JSON.parse(row.json))
    return parsed.ok ? parsed.value : null
  }

  async findChangeset(id: string): Promise<Changeset | null> {
    return this.findOne('SELECT json FROM changesets WHERE id = ?', id, parseChangeset)
  }

  async findQuestion(id: string): Promise<Question | null> {
    return this.findOne('SELECT json FROM questions WHERE id = ?', id, parseQuestion)
  }

  async findExpectation(id: string): Promise<Expectation | null> {
    return this.findOne('SELECT json FROM expectations WHERE id = ?', id, parseExpectation)
  }

  // ── Id allocation ──────────────────────────────────────────────────────────────────
  // A `SELECT max` over the whole table, including resolved/retired rows, so an id is never
  // handed out twice — the SQL analogue of the FS impl counting every partition directory.

  private nextId(prefix: string, table: string): string {
    const ids = (this.db.prepare(`SELECT id FROM ${table}`).all() as unknown as Array<{ id: string }>).map((r) => r.id)
    const highest = ids.reduce((max, id) => Math.max(max, idNumber(id)), 0)
    return `${prefix}-${String(highest + 1).padStart(3, '0')}`
  }

  async nextChangesetId(): Promise<string> {
    return this.nextId('chat', 'changesets')
  }
  async nextQuestionId(): Promise<string> {
    return this.nextId('q', 'questions')
  }
  async nextExpectationId(): Promise<string> {
    return this.nextId('e', 'expectations')
  }

  // ── Simple creates ───────────────────────────────────────────────────────────────────

  async addChangeset(changeset: Changeset): Promise<StoredAt> {
    this.db
      .prepare("INSERT INTO changesets (id, status, json) VALUES (?, 'pending', ?)")
      .run(changeset.id, JSON.stringify(changeset))
    return changeset.id
  }

  async addQuestion(question: Question): Promise<StoredAt> {
    this.db
      .prepare('INSERT INTO questions (id, rev, json) VALUES (?, ?, ?)')
      .run(question.id, question.rev ?? 1, JSON.stringify(question))
    return question.id
  }

  async addExpectation(expectation: Expectation): Promise<StoredAt> {
    this.db
      .prepare("INSERT INTO expectations (id, lifecycle, rev, json) VALUES (?, 'live', ?, ?)")
      .run(expectation.id, expectation.rev ?? 1, JSON.stringify(expectation))
    return expectation.id
  }

  // ── State transitions (slice 2) ────────────────────────────────────────────────────
  // Left explicit and throwing rather than silently no-op, so nothing composes this store for
  // writes believing they landed. The transaction + rev/CAS enforcement lands here next.

  private notYet(method: string): never {
    throw new Error(`SqlSpecStore.${method} is not implemented yet (slice 2: transactions + CAS).`)
  }

  async commitApplication(_application: CommitApplication): Promise<CommitResult> {
    return this.notYet('commitApplication')
  }
  async rejectChangeset(_id: string): Promise<string | null> {
    return this.notYet('rejectChangeset')
  }
  async markImplemented(_id: string, _at: string): Promise<StoredAt | null> {
    return this.notYet('markImplemented')
  }
  async writeAnswer(_questionId: string, _answer: Answer, _expectedRev?: number): Promise<MutationResult> {
    return this.notYet('writeAnswer')
  }
  async retireExpectation(_id: string, _retired: Expectation, _expectedRev?: number): Promise<MutationResult> {
    return this.notYet('retireExpectation')
  }
  async rewriteExpectation(_expectation: Expectation, _expectedRev?: number): Promise<MutationResult> {
    return this.notYet('rewriteExpectation')
  }
}
