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
import os from 'node:os'
import path from 'node:path'
import { loadPlugin } from './plugin.js'
import type { NewEvent, Session, ToolStatus, TranscriptEvent, TranscriptStore } from '@spectra/core'

/**
 * Runtime data — the transcripts DB and the export ledger — does not belong in the source
 * tree, the same way SPECS_DIR no longer does. The default is the XDG data home
 * (`$XDG_DATA_HOME` or `~/.local/share`) under `spectra/`, which is where an installed copy
 * writes; `npm run dev` overrides DATA_DIR to a gitignored `.dev/data` so a dev checkout keeps
 * its scratch state local and out of git. Override either with DATA_DIR / TRANSCRIPTS_DB.
 */
const XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
export const DATA_DIR = process.env.DATA_DIR ?? path.join(XDG_DATA_HOME, 'spectra')
export const TRANSCRIPTS_DB = process.env.TRANSCRIPTS_DB ?? path.join(DATA_DIR, 'transcripts.db')

// The transcript seam (TranscriptStore) and its data shapes (Session, TranscriptEvent, NewEvent,
// EventKind, ToolStatus) now live in @spectra/core — the stable public boundary an out-of-repo store
// implements. This file keeps the node:sqlite backend, the plugin loader, and the on-disk defaults.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id        TEXT PRIMARY KEY,
  projectId TEXT NOT NULL DEFAULT '',
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

export class SqliteTranscriptStore implements TranscriptStore {
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
    const eventColumns = this.db.prepare('PRAGMA table_info(events)').all() as unknown as Array<{ name: string }>
    if (!eventColumns.some((column) => column.name === 'author')) {
      this.db.exec("ALTER TABLE events ADD COLUMN author TEXT NOT NULL DEFAULT 'spec'")
      this.db.exec("UPDATE events SET author = 'human' WHERE kind = 'user'")
    }

    // `projectId` arrived with per-project sessions. Existing rows cannot be back-filled — the
    // project they belonged to is config we do not have here — so they default to '' and fall
    // outside every real project's listing. That only hides old scratch conversations, never a
    // decision (those live in specs/), which is the whole reason this database is disposable.
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as unknown as Array<{ name: string }>
    if (!sessionColumns.some((column) => column.name === 'projectId')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN projectId TEXT NOT NULL DEFAULT ''")
    }
  }

  async createSession(id: string, projectId: string, title: string, now: string): Promise<Session> {
    this.db
      .prepare('INSERT INTO sessions (id, projectId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
      .run(id, projectId, title, now, now)
    return { id, projectId, title, createdAt: now, updatedAt: now }
  }

  async renameSession(id: string, title: string, now: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?').run(title, now, id)
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? (row as unknown as Session) : null
  }

  async listSessions(projectId: string, limit = 50): Promise<Session[]> {
    return this.db
      .prepare('SELECT * FROM sessions WHERE projectId = ? ORDER BY updatedAt DESC LIMIT ?')
      .all(projectId, limit) as unknown as Session[]
  }

  /** Appends one event and returns its id — which doubles as the replay cursor. */
  async append(sessionId: string, event: NewEvent, now: string): Promise<number> {
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
  async settleApproval(approvalId: string, decision: 'allow' | 'deny', note: string | null): Promise<void> {
    this.db
      .prepare(
        `UPDATE events SET status = 'completed', payload = json_patch(COALESCE(payload, '{}'), ?)
         WHERE toolCallId = ? AND kind = 'approval'`,
      )
      .run(JSON.stringify({ decision, note }), approvalId)
  }

  async readApproval(approvalId: string): Promise<TranscriptEvent | null> {
    const row = this.db
      .prepare("SELECT * FROM events WHERE toolCallId = ? AND kind = 'approval'")
      .get(approvalId) as unknown as (Omit<TranscriptEvent, 'payload'> & { payload: string | null }) | undefined

    if (!row) return null
    return { ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }
  }

  /** Closes out a `tool_call` row once the handler returns — or throws. */
  async settleToolCall(toolCallId: string, status: ToolStatus, output: unknown): Promise<void> {
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
  async readToolCall(toolCallId: string): Promise<TranscriptEvent | null> {
    const row = this.db
      .prepare("SELECT * FROM events WHERE toolCallId = ? AND kind = 'tool_call'")
      .get(toolCallId) as unknown as (Omit<TranscriptEvent, 'payload'> & { payload: string | null }) | undefined

    if (!row) return null
    return { ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }
  }

  /** Everything after `afterId`, in order. `afterId` of 0 replays the whole session. */
  async read(sessionId: string, afterId = 0): Promise<TranscriptEvent[]> {
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
  async search(query: string, limit = 20): Promise<Array<TranscriptEvent & { title: string }>> {
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

  async deleteSession(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /** Maintenance: drop sessions untouched since `before` (ISO timestamp). */
  async pruneBefore(before: string): Promise<number> {
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

/** What a plugin transcript store is handed to configure itself (it reads its settings from `env`). */
export interface TranscriptStoreContext {
  env: Record<string, string | undefined>
  /** The XDG data dir, for a store that wants a file beside the built-in's. */
  dataDir: string
}

/** A value satisfies the transcript-store shape — the validation `loadPlugin` runs on a plugin. */
export function isTranscriptStore(value: unknown): value is TranscriptStore {
  const store = value as Partial<TranscriptStore> | null
  return (
    !!store &&
    typeof store.createSession === 'function' &&
    typeof store.listSessions === 'function' &&
    typeof store.append === 'function' &&
    typeof store.read === 'function'
  )
}

/**
 * Resolve the transcript store from configuration — the same plugin boundary as the spec backend
 * (a networked/D1 store for a hosted deploy is a module the server does not ship). `TRANSCRIPT_STORE`
 * is `sqlite` by default (the node:sqlite store); any other value is a module specifier imported and
 * asked for a store via `createTranscriptStore` (or its default export).
 */
export async function resolveTranscriptStore(
  env: Record<string, string | undefined>,
  dataDir: string,
): Promise<TranscriptStore> {
  const spec = env.TRANSCRIPT_STORE
  if (spec === undefined || spec === 'sqlite') {
    return new SqliteTranscriptStore()
  }
  return loadPlugin(spec, 'createTranscriptStore', { env, dataDir } satisfies TranscriptStoreContext, 'TRANSCRIPT_STORE', isTranscriptStore)
}
