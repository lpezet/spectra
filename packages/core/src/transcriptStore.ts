/**
 * The storage seam for agent-conversation transcripts — the interface only.
 *
 * Like {@link SpecStore}, it lives in `@spectra/core`, the pure package, so an out-of-repo store can
 * implement it without depending on a server's Express/agent machinery: the cloud backs it with D1,
 * the open server with node:sqlite ({@link SqliteTranscriptStore} in `@spectra/server`), and both
 * satisfy this one contract. The concrete backend, the plugin loader, and the on-disk defaults stay
 * in the server; only the shape an implementor must match is here.
 *
 * Every read and write is async. A node:sqlite backend is synchronous underneath and resolves
 * immediately, but the interface awaits because a store that talks to a database over the wire — the
 * kind a multi-instance/hosted deploy needs — cannot answer synchronously, and the interface, not one
 * backend, is the boundary implementors depend on. `close` is the one exception: tearing down a
 * connection has nothing to await for a networked store.
 *
 * One instance serves every project, keyed by `projectId` per call (unlike SpecStore, which binds to
 * one project): the runner is a long-lived singleton and sessions carry globally-unique ids, so only
 * the operations that *scope* — creating and listing sessions — need the project; the rest resolve a
 * session by its id.
 */
import type { AuthorKind } from './types.js'

/**
 * `tool_call` rows carry a status so a run interrupted mid-flight can be reasoned about later — on
 * resume, a call left `started` may or may not have taken effect.
 */
export type EventKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error' | 'approval'
export type ToolStatus = 'started' | 'completed' | 'failed'

export interface TranscriptEvent {
  id: number
  sessionId: string
  /** Who produced the event — human or one of the agents. `kind` says what it is; this says who. */
  author: AuthorKind
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
  /** The project this conversation belongs to. Sessions are listed and reached per project. */
  projectId: string
  /**
   * The user who owns this conversation, or `null` for an unattributed one. Sessions are per-user:
   * a hosted deployment stamps the authenticated user here and lists each user only their own. On a
   * single-user install there is no account, so it is `null` and listing is not narrowed — the owner
   * of the durable record (who edited the glossary) lives on the changeset's `author.user`, not here.
   */
  ownerId: string | null
  title: string
  createdAt: string
  updatedAt: string
}

export interface NewEvent {
  author: AuthorKind
  kind: EventKind
  text?: string | null
  payload?: unknown
  toolCallId?: string | null
  status?: ToolStatus | null
}

export interface TranscriptStore {
  createSession(id: string, projectId: string, ownerId: string | null, title: string, now: string): Promise<Session>
  renameSession(id: string, title: string, now: string): Promise<void>
  getSession(id: string): Promise<Session | null>
  /** Sessions for a project, newest first. `ownerId` narrows to one user's; omit it for all of them. */
  listSessions(projectId: string, ownerId?: string, limit?: number): Promise<Session[]>
  append(sessionId: string, event: NewEvent, now: string): Promise<number>
  settleApproval(approvalId: string, decision: 'allow' | 'deny', note: string | null): Promise<void>
  readApproval(approvalId: string): Promise<TranscriptEvent | null>
  settleToolCall(toolCallId: string, status: ToolStatus, output: unknown): Promise<void>
  readToolCall(toolCallId: string): Promise<TranscriptEvent | null>
  read(sessionId: string, afterId?: number): Promise<TranscriptEvent[]>
  search(query: string, limit?: number): Promise<Array<TranscriptEvent & { title: string }>>
  deleteSession(id: string): Promise<void>
  pruneBefore(before: string): Promise<number>
  close(): void
}
