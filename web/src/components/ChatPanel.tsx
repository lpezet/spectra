/**
 * The chat dock. Sits beside the glossary rather than replacing it, so you can read a
 * term while asking about it — the point of putting this in the tool at all was to stop
 * bouncing between a terminal and a browser.
 *
 * `@` references terms, questions and changesets by name. That is the vocabulary this
 * project is about, and it is more useful than referencing files: a term's meaning spans
 * its own file plus everything pointing at it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatSession, Entity } from '../chat.js'
import {
  createSession,
  deleteSession,
  fetchChatStatus,
  listSessions,
  matchEntities,
  mentionAt,
  sendMessage,
  streamSession,
} from '../chat.js'

interface ChatPanelProps {
  entities: Entity[]
  /** Something changed on disk — the glossary and queues should be refetched. */
  onSpecsChanged: () => void
  onSelectTerm: (name: string) => void
  onClose: () => void
}

export function ChatPanel({ entities, onSpecsChanged, onSelectTerm, onClose }: ChatPanelProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const composer = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [mention, setMention] = useState<{ query: string; from: number } | null>(null)

  useEffect(() => {
    void fetchChatStatus().then((status) => setConfigured(status.configured))
    void listSessions().then(({ sessions: found }) => {
      setSessions(found)
      setSessionId((current) => current ?? found[0]?.id ?? null)
    })
  }, [])

  // A tool call that writes lands on disk; the glossary behind this panel is now stale.
  const settled = useCallback(
    (event: ChatEvent) => {
      if (event.kind === 'tool_call' && event.status === 'completed' && event.text === 'raise_question') {
        onSpecsChanged()
      }
    },
    [onSpecsChanged],
  )

  useEffect(() => {
    if (!sessionId) return
    setEvents([])
    setStreaming('')

    return streamSession(sessionId, 0, {
      onAppend: (event) => {
        setStreaming('')
        setEvents((current) => (current.some((e) => e.id === event.id) ? current : [...current, event]))
      },
      onUpdate: (event) => {
        setEvents((current) => current.map((e) => (e.id === event.id ? event : e)))
        settled(event)
      },
      onDelta: (text) => setStreaming((current) => current + text),
      onReady: setRunning,
      onDone: () => {
        setRunning(false)
        setStreaming('')
      },
    })
  }, [sessionId, settled])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [events, streaming])

  async function start() {
    const { session } = await createSession()
    setSessions((current) => [session, ...current])
    setSessionId(session.id)
  }

  async function submit() {
    const text = draft.trim()
    if (!text || running) return

    let target = sessionId
    if (!target) {
      const { session } = await createSession()
      setSessions((current) => [session, ...current])
      setSessionId(session.id)
      target = session.id
    }

    setDraft('')
    setMention(null)
    setRunning(true)
    setError(null)

    try {
      const outcome = await sendMessage(target, text)
      if (!outcome.ok) {
        setError(outcome.error ?? 'The message was refused.')
        setRunning(false)
      }
    } catch (cause) {
      setError((cause as Error).message)
      setRunning(false)
    }
  }

  function onDraftChange(value: string, caret: number) {
    setDraft(value)
    setMention(mentionAt(value, caret))
  }

  function insertMention(entity: Entity) {
    if (!mention) return
    const caret = composer.current?.selectionStart ?? draft.length
    const next = `${draft.slice(0, mention.from)}@${entity.name} ${draft.slice(caret)}`
    setDraft(next)
    setMention(null)
    requestAnimationFrame(() => composer.current?.focus())
  }

  const suggestions = mention ? matchEntities(entities, mention.query) : []

  return (
    <aside className="chat">
      <header className="chat-header">
        <strong>Chat</strong>
        <select
          className="chat-sessions"
          value={sessionId ?? ''}
          onChange={(event) => setSessionId(event.target.value || null)}
        >
          {sessions.length === 0 && <option value="">no conversations</option>}
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {when(session.updatedAt)} · {session.title}
            </option>
          ))}
        </select>
        <button type="button" className="chat-icon" title="New conversation" onClick={() => void start()}>
          +
        </button>
        {sessionId && (
          <button
            type="button"
            className="chat-icon"
            title="Delete this conversation"
            onClick={async () => {
              await deleteSession(sessionId)
              const { sessions: left } = await listSessions()
              setSessions(left)
              setSessionId(left[0]?.id ?? null)
            }}
          >
            ×
          </button>
        )}
        <button type="button" className="close" onClick={onClose} aria-label="Close chat">
          ⟩
        </button>
      </header>

      {!configured && (
        <p className="chat-warn">
          <code>ANTHROPIC_API_KEY</code> is not set on the server, so the agent cannot run. Messages
          are still recorded.
        </p>
      )}

      <div className="chat-scroll" ref={scroller}>
        {events.length === 0 && !streaming && (
          <div className="chat-empty">
            <p className="muted">Ask about the specs. It can read the glossary, the questions and the pending changesets, work out what conflicts with what, and raise a question — but it cannot edit a term.</p>
            <ul className="chat-hints">
              <li>Where should I start?</li>
              <li>Why does @deleteProject block instead of cascade?</li>
              <li>What does @q-004 depend on?</li>
            </ul>
          </div>
        )}

        {events.map((event) => (
          <Bubble key={event.id} event={event} onSelectTerm={onSelectTerm} />
        ))}

        {streaming && (
          <div className="bubble bubble-assistant">
            {streaming}
            <span className="cursor" />
          </div>
        )}
        {running && !streaming && <p className="muted chat-thinking">thinking…</p>}
      </div>

      {error && <p className="chat-warn">{error}</p>}

      <div className="composer">
        {suggestions.length > 0 && (
          <ul className="mentions">
            {suggestions.map((entity) => (
              <li key={`${entity.kind}-${entity.name}`}>
                <button type="button" onClick={() => insertMention(entity)}>
                  <span className={`mention-kind mention-${entity.kind}`}>{entity.kind}</span>
                  <span className="mention-name">{entity.name}</span>
                  <span className="muted mention-hint">{entity.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={composer}
          value={draft}
          rows={3}
          placeholder="Ask about the specs — @ to reference a term, question or changeset"
          onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setMention(null)
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (suggestions.length > 0) insertMention(suggestions[0]!)
              else void submit()
            }
          }}
        />
        <div className="composer-actions">
          <span className="muted">Enter to send · Shift+Enter for a new line</span>
          <button type="button" className="action" disabled={running || !draft.trim()} onClick={() => void submit()}>
            Send
          </button>
        </div>
      </div>
    </aside>
  )
}

function Bubble({ event, onSelectTerm }: { event: ChatEvent; onSelectTerm: (name: string) => void }) {
  if (event.kind === 'tool_call') return <ToolCall event={event} />

  if (event.kind === 'error') {
    return <div className="bubble bubble-error">{event.text}</div>
  }

  return (
    <div className={`bubble bubble-${event.kind}`}>
      {linkify(event.text ?? '', onSelectTerm)}
    </div>
  )
}

function ToolCall({ event }: { event: ChatEvent }) {
  const [open, setOpen] = useState(false)
  const detail = event.payload as { input?: unknown; output?: unknown } | null

  return (
    <div className={`tool tool-${event.status ?? 'started'}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-dot" />
        <code>{event.text}</code>
        <span className="muted">{event.status === 'started' ? 'running…' : event.status}</span>
      </button>
      {open && detail && (
        <pre className="tool-detail">{JSON.stringify(detail, null, 2)}</pre>
      )}
    </div>
  )
}

/**
 * Conversations are titled from their first message, which collides constantly — ask
 * "where should I start?" three times and you get three identical entries. The timestamp
 * is what actually distinguishes them.
 */
function when(iso: string): string {
  const at = new Date(iso)
  const today = new Date().toDateString() === at.toDateString()
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return today ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

/** Renders `@Name` as a link into the glossary, leaving the rest of the text alone. */
function linkify(text: string, onSelectTerm: (name: string) => void) {
  const parts = text.split(/(@[A-Za-z][A-Za-z0-9_-]*)/g)
  return parts.map((part, index) =>
    part.startsWith('@') ? (
      <button key={index} type="button" className="term-ref" onClick={() => onSelectTerm(part.slice(1))}>
        {part.slice(1)}
      </button>
    ) : (
      <span key={index}>{part}</span>
    ),
  )
}
