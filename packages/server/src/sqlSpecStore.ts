/**
 * The SQL backing for the glossary — a peer of {@link FileSystemSpecStore} behind {@link SpecStore}.
 *
 * This is the second implementation the interface was built for: the same contract, backed by a
 * table per collection instead of a directory. It is what lets the glossary live somewhere a team
 * (and later a hosted, multi-tenant deployment) can reach — the filesystem impl serves a single
 * local checkout; this one serves a database, and the D1 target reuses the same SQL.
 *
 * **One database, many projects.** The filesystem impl gets away with "one directory = one project"
 * because a directory *is* the partition. A central DB is the opposite point: it holds every
 * project's glossary at once — a solo dev's several projects, and later many tenants' — so every
 * collection row carries a `project_id`, and a store instance is **scoped to one project** (its
 * `projectId`). Reads and writes filter to it; ids are allocated within it. Resolving *which*
 * project a request is for — a checkout's `.spectra` link locally, an authenticated tenant when
 * hosted — happens above this, at the composition root, which constructs the store per project.
 *
 * The two principles the interface named, made concrete here:
 *   - **State is data, not location.** Where the FS impl moves a file into `applied/` or `retired/`,
 *     this sets a `status` / `lifecycle` column. The partitioned reads are the same query, filtered.
 *   - **Records are addressed by domain id.** The primary key is `(project_id, domain id)`, so a
 *     duplicate cannot exist within a project — the FS impl's duplicate-detection has nothing to
 *     report here — while the same `chat-001` can exist in two different projects.
 *
 * Each row stores the record's full JSON (validated on read the same way, so a somehow-corrupt row
 * becomes a `problem` rather than throwing). `node:sqlite` is synchronous; the async method
 * signatures wrap sync calls, and `:memory:` makes the store trivially testable.
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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS terms (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS changesets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  status TEXT NOT NULL,           -- pending | applied | rejected
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS questions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1, -- optimistic-concurrency counter (enforced in slice 2)
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS expectations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,        -- live | retired  (draft/ready is inside the record's own status)
  rev INTEGER NOT NULL DEFAULT 1,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
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
  private readonly projectId: string

  /**
   * `file` is a path or `:memory:` (like TranscriptStore); `projectId` scopes every read and write.
   * The project is registered with a neutral identity if new — the "ship empty" state — which
   * `setProjectInfo` names later; this also keeps the collections' `project_id` foreign key valid.
   */
  constructor(file: string, projectId: string) {
    this.projectId = projectId
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON')
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.db
      .prepare('INSERT OR IGNORE INTO projects (id, name, domain) VALUES (?, ?, ?)')
      .run(projectId, FALLBACK_PROJECT_INFO.name, FALLBACK_PROJECT_INFO.domain)
  }

  close(): void {
    this.db.close()
  }

  // ── Project identity ─────────────────────────────────────────────────────────────────

  async projectInfo(): Promise<ProjectInfo> {
    const row = this.db.prepare('SELECT name, domain FROM projects WHERE id = ?').get(this.projectId) as
      | { name: string; domain: string }
      | undefined
    if (!row) return FALLBACK_PROJECT_INFO
    const parsed = parseProjectInfo({ name: row.name, domain: row.domain })
    return parsed.ok ? parsed.value : FALLBACK_PROJECT_INFO
  }

  /**
   * Name this project. Not part of {@link SpecStore} — the FS impl gets identity from a file a
   * human or `spectra init` writes; here it updates the project's row (created at construction).
   */
  setProjectInfo(info: ProjectInfo): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, domain) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, domain = excluded.domain`,
      )
      .run(this.projectId, info.name, info.domain)
  }

  // ── Low-level ────────────────────────────────────────────────────────────────────────

  /** Every query is scoped to this project, so projectId is always the first bound parameter. */
  private rows(sql: string, ...params: Array<string | number>): JsonRow[] {
    return this.db.prepare(sql).all(this.projectId, ...params) as unknown as JsonRow[]
  }

  /**
   * Parse each row's JSON with a domain parser, collecting parse failures as `problems` rather than
   * throwing — the same graceful degradation the FS reads give. In practice the store only ever
   * writes valid JSON, so `problems` is empty; the path exists because the interface keeps it.
   */
  private parseRows<T>(
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
      else {
        const id = data && typeof data === 'object' ? String((data as { id?: string }).id ?? '(row)') : '(row)'
        problems.push({ file: id, message: parsed.errors.join('; ') })
      }
    }
    return { values, problems }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────

  async readTerms(): Promise<Glossary> {
    const { values, problems } = this.parseRows(this.rows('SELECT json FROM terms WHERE project_id = ?'), parseTerm)
    values.sort((a, b) => a.name.localeCompare(b.name))
    return { terms: values, problems }
  }

  async readChangesets(): Promise<PendingChangesets> {
    const pending = this.parseRows(this.rows("SELECT json FROM changesets WHERE project_id = ? AND status = 'pending'"), parseChangeset)
    const applied = this.parseRows(this.rows("SELECT json FROM changesets WHERE project_id = ? AND status = 'applied'"), parseChangeset)
    const rejected = this.parseRows(this.rows("SELECT json FROM changesets WHERE project_id = ? AND status = 'rejected'"), parseChangeset)
    const byAppliedDesc = (a: Changeset, b: Changeset) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? '')
    return {
      changesets: pending.values,
      problems: pending.problems,
      applied: applied.values.sort(byAppliedDesc),
      rejected: rejected.values.sort(byAppliedDesc),
    }
  }

  async readQuestions(): Promise<QuestionFeed> {
    const { values, problems } = this.parseRows(this.rows('SELECT json FROM questions WHERE project_id = ?'), parseQuestion)
    return { questions: values, problems }
  }

  async readExpectations(): Promise<ExpectationFeed> {
    const live = this.parseRows(this.rows("SELECT json FROM expectations WHERE project_id = ? AND lifecycle = 'live'"), parseExpectation)
    const retired = this.parseRows(this.rows("SELECT json FROM expectations WHERE project_id = ? AND lifecycle = 'retired'"), parseExpectation)
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
    table: string,
    id: string,
    parse: (data: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  ): T | null {
    const row = this.db
      .prepare(`SELECT json FROM ${table} WHERE project_id = ? AND id = ?`)
      .get(this.projectId, id) as JsonRow | undefined
    if (!row) return null
    const parsed = parse(JSON.parse(row.json))
    return parsed.ok ? parsed.value : null
  }

  async findChangeset(id: string): Promise<Changeset | null> {
    return this.findOne('changesets', id, parseChangeset)
  }

  async findQuestion(id: string): Promise<Question | null> {
    return this.findOne('questions', id, parseQuestion)
  }

  async findExpectation(id: string): Promise<Expectation | null> {
    return this.findOne('expectations', id, parseExpectation)
  }

  // ── Id allocation ──────────────────────────────────────────────────────────────────
  // A `SELECT max` over the whole table for this project, including resolved/retired rows, so an id
  // is never handed out twice — the SQL analogue of the FS impl counting every partition directory.

  private nextId(prefix: string, table: string): string {
    const ids = (
      this.db.prepare(`SELECT id FROM ${table} WHERE project_id = ?`).all(this.projectId) as unknown as Array<{ id: string }>
    ).map((r) => r.id)
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
      .prepare("INSERT INTO changesets (project_id, id, status, json) VALUES (?, ?, 'pending', ?)")
      .run(this.projectId, changeset.id, JSON.stringify(changeset))
    return changeset.id
  }

  async addQuestion(question: Question): Promise<StoredAt> {
    this.db
      .prepare('INSERT INTO questions (project_id, id, rev, json) VALUES (?, ?, ?, ?)')
      .run(this.projectId, question.id, question.rev ?? 1, JSON.stringify(question))
    return question.id
  }

  async addExpectation(expectation: Expectation): Promise<StoredAt> {
    this.db
      .prepare("INSERT INTO expectations (project_id, id, lifecycle, rev, json) VALUES (?, ?, 'live', ?, ?)")
      .run(this.projectId, expectation.id, expectation.rev ?? 1, JSON.stringify(expectation))
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
