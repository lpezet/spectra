/**
 * Chat client. The stream is the source of truth for what has happened; posting a message
 * only kicks the agent off and returns. Everything that comes back — including the echo of
 * what you just sent — arrives over SSE, so one code path renders a live turn and a
 * reload of an old conversation.
 */

export type ChatEventKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error' | 'approval'

export type Author = 'human' | 'spec' | 'coder'

export interface ChatEvent {
  id: number
  sessionId: string
  author: Author
  kind: ChatEventKind
  text: string | null
  payload: unknown
  toolCallId: string | null
  status: 'started' | 'completed' | 'failed' | null
  createdAt: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `${url} — ${response.status}`)
  return body
}

export function fetchChatStatus(): Promise<{ configured: boolean }> {
  return json('/api/chat/status')
}

export function listSessions(): Promise<{ sessions: ChatSession[] }> {
  return json('/api/chat/sessions')
}

export function createSession(): Promise<{ session: ChatSession }> {
  return json('/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

export function deleteSession(id: string): Promise<{ ok: boolean }> {
  return json(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface Agent {
  name: string
  label: string
  description: string
}

export function listAgents(): Promise<{ agents: Agent[] }> {
  return json('/api/chat/agents')
}

export function sendMessage(
  id: string,
  text: string,
  to: string | null,
): Promise<{ ok: boolean; error?: string }> {
  return json(`/api/chat/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, to }),
  })
}

/**
 * Session state without the transcript.
 *
 * Reuses the events endpoint with a cursor past the end, so it returns the flags and an
 * empty list. `unattended` lives in the server's memory, so the browser has to ask — and a
 * server restart correctly reports it back off rather than the UI insisting it is still on.
 */
export function fetchSessionState(id: string): Promise<{ running: boolean; unattended: boolean }> {
  return json(`/api/chat/sessions/${encodeURIComponent(id)}/events?after=${Number.MAX_SAFE_INTEGER}`)
}

/**
 * Lets @coder work without a card in this conversation.
 *
 * The server can refuse — it only permits this where there is a reachable sandbox, since
 * without one the card is the only boundary. So the answer comes back rather than being
 * assumed, and the returned `unattended` is what the UI should believe.
 */
export function setUnattended(
  sessionId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string; unattended: boolean }> {
  return json(`/api/chat/sessions/${encodeURIComponent(sessionId)}/unattended`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

/** Answers a pending approval. The agent is blocked until this returns. */
export function decideApproval(
  sessionId: string,
  approvalId: string,
  decision: 'allow' | 'deny',
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  return json(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, note }),
    },
  )
}

export interface StreamHandlers {
  onAppend: (event: ChatEvent) => void
  onUpdate: (event: ChatEvent) => void
  onDelta: (text: string) => void
  onDone: () => void
  onReady: (running: boolean) => void
}

/**
 * Opens the stream from `after`. EventSource reconnects on its own, but it would replay
 * from the same cursor, so the cursor advances here as events arrive — a reconnect then
 * resumes rather than duplicating.
 */
export function streamSession(id: string, after: number, handlers: StreamHandlers): () => void {
  let cursor = after
  let source: EventSource | null = null
  let closed = false

  const open = () => {
    if (closed) return
    source = new EventSource(`/api/chat/sessions/${encodeURIComponent(id)}/stream?after=${cursor}`)

    source.addEventListener('append', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as ChatEvent
      cursor = Math.max(cursor, event.id)
      handlers.onAppend(event)
    })

    source.addEventListener('update', (message) => {
      handlers.onUpdate(JSON.parse((message as MessageEvent<string>).data) as ChatEvent)
    })

    source.addEventListener('delta', (message) => {
      handlers.onDelta((JSON.parse((message as MessageEvent<string>).data) as { text: string }).text)
    })

    source.addEventListener('ready', (message) => {
      handlers.onReady((JSON.parse((message as MessageEvent<string>).data) as { running: boolean }).running)
    })

    source.addEventListener('done', () => handlers.onDone())

    source.onerror = () => {
      // Reopen at the advanced cursor rather than letting EventSource retry the old one.
      source?.close()
      if (!closed) setTimeout(open, 1000)
    }
  }

  open()

  return () => {
    closed = true
    source?.close()
  }
}

export interface Entity {
  name: string
  kind: 'term' | 'question' | 'changeset'
  hint: string
}

/**
 * `@` addresses a person, `#` refers to a thing — the convention every messaging app
 * already taught everyone. `@` used to do artifacts here; with two agents in the channel
 * it has to mean "who is this for".
 */
export type SigilKind = 'agent' | 'artifact'

export interface Mention {
  sigil: SigilKind
  query: string
  from: number
}

/** Matches a trailing `@partial` or `#partial` the caret is sitting in. */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)([@#])([A-Za-z0-9_-]*)$/.exec(before)
  if (!match) return null

  const query = match[3] ?? ''
  return {
    sigil: match[2] === '@' ? 'agent' : 'artifact',
    query,
    from: caret - query.length - 1,
  }
}

/**
 * Who a message is addressed to — the first `@name` that matches a real agent. An
 * unaddressed message is recorded and acted on by nobody, as in any channel.
 */
export function addresseeOf(text: string, agents: readonly string[]): string | null {
  for (const match of text.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+)/g)) {
    if (agents.includes(match[1]!)) return match[1]!
  }
  return null
}

export function matchEntities(entities: Entity[], query: string, limit = 8): Entity[] {
  const needle = query.toLowerCase()
  return entities
    .filter((entity) => entity.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1
      const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1
      return aStarts - bStarts || a.name.localeCompare(b.name)
    })
    .slice(0, limit)
}
