/**
 * Transcript storage for agent conversations.
 *
 * Deliberately *not* in `specs/` and not in git. The specs are the record — what was
 * decided and why. A transcript is the workspace that led there: useful, searchable,
 * and safe to truncate. A question may point at the exchange that produced it, but must
 * stay readable without it, so losing this database costs context and never costs a
 * decision.
 *
 * One append-only `events` table rather than separate message/tool tables: replay after a
 * dropped connection is then a single ordered read from a cursor, which is the operation
 * that happens most.
 *
 * Uses the built-in `node:sqlite` (Node 22.5+) to avoid a native dependency. It is still
 * flagged experimental, so everything touching it lives behind this module — swapping in
 * better-sqlite3 later is a change to this file only.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(import.meta.dirname, '../../data')
export const TRANSCRIPTS_DB = process.env.TRANSCRIPTS_DB ?? path.join(DATA_DIR, 'transcripts.db')

/**
 * `tool_call` rows carry a status so a run interrupted mid-flight can be reasoned about
 * later — on resume, a call left `started` may or may not have taken effect. Nothing uses
 * that yet; recording it now is what lets restart-resume be added without a migration.
 */
export type EventKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error' | 'approval'
export type ToolStatus = 'started' | 'completed' | 'failed'

/** Who produced an event. `kind` says what it is; this says who said it. */
export type Author = 'human' | 'spec' | 'coder'

export interface TranscriptEvent {
  id: number
  sessionId: string
  author: Author
  kind: EventKind
  /** Plain text, kept searchable. For tool events, a one-line summary. */
  text: string | null
  /** Structured detail as JSON — tool input/output, error causes. */
  payload: unknown
  toolCallId: string | null
  status: ToolStatus | null
  createdAt: string
}

export interface Session {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface NewEvent {
  author: Author
  kind: EventKind
  text?: string | null
  payload?: unknown
  toolCallId?: string | null
  status?: ToolStatus | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author      TEXT NOT NULL DEFAULT 'spec',
  kind        TEXT NOT NULL,
  text        TEXT,
  payload     TEXT,
  toolCallId  TEXT,
  status      TEXT,
  createdAt   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_session ON events (sessionId, id);
CREATE INDEX IF NOT EXISTS events_by_tool_call ON events (toolCallId);
`

export class TranscriptStore {
  private readonly db: DatabaseSync

  constructor(file: string = TRANSCRIPTS_DB) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON')
    // WAL keeps a reader (the UI replaying) from blocking the writer (a live agent run).
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /**
   * `author` arrived after the first transcripts were written. Existing rows are back-filled
   * from `kind`, which is the best guess available and right for every row that existed:
   * only the human and one agent were talking.
   */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(events)').all() as unknown as Array<{ name: string }>
    if (columns.some((column) => column.name === 'author')) return

    this.db.exec("ALTER TABLE events ADD COLUMN author TEXT NOT NULL DEFAULT 'spec'")
    this.db.exec("UPDATE events SET author = 'human' WHERE kind = 'user'")
  }

  createSession(id: string, title: string, now: string): Session {
    this.db
      .prepare('INSERT INTO sessions (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)')
      .run(id, title, now, now)
    return { id, title, createdAt: now, updatedAt: now }
  }

  renameSession(id: string, title: string, now: string): void {
    this.db.prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?').run(title, now, id)
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? (row as unknown as Session) : null
  }

  listSessions(limit = 50): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updatedAt DESC LIMIT ?')
      .all(limit) as unknown as Session[]
  }

  /** Appends one event and returns its id — which doubles as the replay cursor. */
  append(sessionId: string, event: NewEvent, now: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO events (sessionId, author, kind, text, payload, toolCallId, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        event.author,
        event.kind,
        event.text ?? null,
        event.payload === undefined ? null : JSON.stringify(event.payload),
        event.toolCallId ?? null,
        event.status ?? null,
        now,
      )

    this.db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(now, sessionId)
    return Number(result.lastInsertRowid)
  }

  /**
   * Resolves an `approval` row. `status` says it is settled; the payload says how, because
   * a denial is a completed approval, not a failed one.
   */
  settleApproval(approvalId: string, decision: 'allow' | 'deny', note: string | null): void {
    this.db
      .prepare(
        `UPDATE events SET status = 'completed', payload = json_patch(COALESCE(payload, '{}'), ?)
         WHERE toolCallId = ? AND kind = 'approval'`,
      )
      .run(JSON.stringify({ decision, note }), approvalId)
  }

  readApproval(approvalId: string): TranscriptEvent | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE toolCallId = ? AND kind = 'approval'")
      .get(approvalId) as unknown as (Omit<TranscriptEvent, 'payload'> & { payload: string | null }) | undefined

    if (!row) return null
    return { ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }
  }

  /** Closes out a `tool_call` row once the handler returns — or throws. */
  settleToolCall(toolCallId: string, status: ToolStatus, output: unknown): void {
    this.db
      .prepare(
        `UPDATE events SET status = ?, payload = json_patch(COALESCE(payload, '{}'), ?)
         WHERE toolCallId = ? AND kind = 'tool_call'`,
      )
      .run(status, JSON.stringify({ output: output ?? null }), toolCallId)
  }

  /**
   * One tool-call row by its call id. Settling mutates a row the replay cursor has
   * already passed, so a live stream needs to fetch it directly rather than waiting for
   * it to come round again.
   */
  readToolCall(toolCallId: string): TranscriptEvent | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE toolCallId = ? AND kind = 'tool_call'")
      .get(toolCallId) as unknown as (Omit<TranscriptEvent, 'payload'> & { payload: string | null }) | undefined

    if (!row) return null
    return { ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }
  }

  /** Everything after `afterId`, in order. `afterId` of 0 replays the whole session. */
  read(sessionId: string, afterId = 0): TranscriptEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE sessionId = ? AND id > ? ORDER BY id')
      .all(sessionId, afterId) as unknown as Array<Omit<TranscriptEvent, 'payload'> & { payload: string | null }>

    return rows.map((row) => ({ ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }))
  }

  /**
   * Substring search across sessions, newest first. Backs the agent's own
   * `searchTranscripts` tool — "what did we say about RecurringTask" is a question the
   * agent should be able to answer without the human digging.
   */
  search(query: string, limit = 20): Array<TranscriptEvent & { title: string }> {
    const rows = this.db
      .prepare(
        `SELECT events.*, sessions.title FROM events
         JOIN sessions ON sessions.id = events.sessionId
         WHERE events.text LIKE ? ESCAPE '\\' AND events.kind IN ('user', 'assistant')
         ORDER BY events.id DESC LIMIT ?`,
      )
      .all(`%${escapeLike(query)}%`, limit) as unknown as Array<
      Omit<TranscriptEvent, 'payload'> & { payload: string | null; title: string }
    >

    return rows.map((row) => ({ ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }))
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /** Maintenance: drop sessions untouched since `before` (ISO timestamp). */
  pruneBefore(before: string): number {
    const result = this.db.prepare('DELETE FROM sessions WHERE updatedAt < ?').run(before)
    return Number(result.changes)
  }

  close(): void {
    this.db.close()
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}
