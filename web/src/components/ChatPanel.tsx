/**
 * The chat dock. Sits beside the glossary rather than replacing it, so you can read a
 * term while asking about it — the point of putting this in the tool at all was to stop
 * bouncing between a terminal and a browser.
 *
 * `@` references terms, questions and changesets by name. That is the vocabulary this
 * project is about, and it is more useful than referencing files: a term's meaning spans
 * its own file plus everything pointing at it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, ChatEvent, ChatSession, Entity, Mention } from '../chat.js'
import { Markdown } from './Markdown.js'
import {
  addresseeOf,
  createSession,
  decideApproval,
  deleteSession,
  fetchChatStatus,
  listAgents,
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
  const [agents, setAgents] = useState<Agent[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Only terms are linkable; an `@q-004` in prose stays plain rather than becoming a
  // dead link to something the glossary has no page for.
  const known = useMemo(
    () => new Set(entities.filter((entity) => entity.kind === 'term').map((entity) => entity.name)),
    [entities],
  )

  const composer = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [mention, setMention] = useState<Mention | null>(null)

  useEffect(() => {
    void fetchChatStatus().then((status) => setConfigured(status.configured))
    void listAgents().then(({ agents: found }) => setAgents(found))
    void listSessions().then(({ sessions: found }) => {
      setSessions(found)
      setSessionId((current) => current ?? found[0]?.id ?? null)
    })
  }, [])

  // A tool call that writes lands on disk; the glossary behind this panel is now stale.
  const settled = useCallback(
    (event: ChatEvent) => {
      // Anything that writes to specs/ leaves the glossary behind this panel stale.
      const writes = ['raise_question', 'propose_changeset', 'mark_implemented']
      if (event.kind === 'tool_call' && event.status === 'completed' && writes.includes(event.text ?? '')) {
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
      const outcome = await sendMessage(target, text, addresseeOf(text, agentNames))
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

  function insert(name: string, sigil: '@' | '#') {
    if (!mention) return
    const caret = composer.current?.selectionStart ?? draft.length
    setDraft(`${draft.slice(0, mention.from)}${sigil}${name} ${draft.slice(caret)}`)
    setMention(null)
    requestAnimationFrame(() => composer.current?.focus())
  }

  const agentNames = agents.map((agent) => agent.name)
  const to = addresseeOf(draft, agentNames)

  // `@` completes over who is in the channel, `#` over what the glossary holds.
  const suggestions =
    mention?.sigil === 'artifact' ? matchEntities(entities, mention.query) : []
  const agentSuggestions =
    mention?.sigil === 'agent'
      ? agents.filter((agent) => agent.name.startsWith(mention.query.toLowerCase()))
      : []

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
              <li>@spec where should I start?</li>
              <li>@spec why does #deleteProject block instead of cascade?</li>
              <li>@coder implement the changesets that just landed</li>
            </ul>
          </div>
        )}

        {events.map((event) => (
          <Bubble
            key={event.id}
            event={event}
            known={known}
            onSelectTerm={onSelectTerm}
            onDecide={(decision, note) => {
              if (event.toolCallId && sessionId) {
                void decideApproval(sessionId, event.toolCallId, decision, note).catch((cause: Error) =>
                  setError(cause.message),
                )
              }
            }}
          />
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
        {(suggestions.length > 0 || agentSuggestions.length > 0) && (
          <ul className="mentions">
            {agentSuggestions.map((agent) => (
              <li key={`agent-${agent.name}`}>
                <button type="button" onClick={() => insert(agent.name, '@')}>
                  <span className="mention-kind mention-agent">agent</span>
                  <span className="mention-name">@{agent.name}</span>
                  <span className="muted mention-hint">{agent.description}</span>
                </button>
              </li>
            ))}
            {suggestions.map((entity) => (
              <li key={`${entity.kind}-${entity.name}`}>
                <button type="button" onClick={() => insert(entity.name, '#')}>
                  <span className={`mention-kind mention-${entity.kind}`}>{entity.kind}</span>
                  <span className="mention-name">#{entity.name}</span>
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
          placeholder="@spec or @coder to address someone, # to refer to a term or change"
          onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setMention(null)
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (agentSuggestions.length > 0) insert(agentSuggestions[0]!.name, '@')
              else if (suggestions.length > 0) insert(suggestions[0]!.name, '#')
              else void submit()
            }
          }}
        />
        <div className="composer-actions">
          <span className="muted">
            {to ? (
              <>
                to <strong className={`author author-${to}`}>@{to}</strong> · Enter to send
              </>
            ) : (
              'Address @spec or @coder — an unaddressed message is recorded but acted on by nobody'
            )}
          </span>
          <button type="button" className="action" disabled={running || !draft.trim()} onClick={() => void submit()}>
            Send
          </button>
        </div>
      </div>
    </aside>
  )
}

function Bubble({
  event,
  known,
  onSelectTerm,
  onDecide,
}: {
  event: ChatEvent
  known: Set<string>
  onSelectTerm: (name: string) => void
  onDecide: (decision: 'allow' | 'deny', note?: string) => void
}) {
  if (event.kind === 'approval') return <Approval event={event} onDecide={onDecide} />
  if (event.kind === 'tool_call') return <ToolCall event={event} />

  if (event.kind === 'error') {
    return (
      <div className="bubble bubble-error">
        <span className={`author author-${event.author}`}>@{event.author}</span>
        {event.text}
      </div>
    )
  }

  // Your own message renders exactly as typed. Only an agent's prose is Markdown.
  if (event.kind === 'user') {
    return <div className="bubble bubble-user">{event.text}</div>
  }

  return (
    <div className={`bubble bubble-${event.kind} bubble-from-${event.author}`}>
      <span className={`author author-${event.author}`}>@{event.author}</span>
      <Markdown text={event.text ?? ''} known={known} onSelectTerm={onSelectTerm} />
    </div>
  )
}

/**
 * The agent is genuinely blocked while this is on screen — the run is suspended inside the
 * SDK's permission callback until one of these buttons is pressed. It renders from the
 * transcript rather than a live message, so reloading the page does not strand the run.
 */
function Approval({
  event,
  onDecide,
}: {
  event: ChatEvent
  onDecide: (decision: 'allow' | 'deny', note?: string) => void
}) {
  const [note, setNote] = useState('')
  const detail = event.payload as { input?: Record<string, unknown>; decision?: string; note?: string } | null
  const settled = event.status === 'completed'
  const allowed = detail?.decision === 'allow'

  return (
    <div className={`approval ${settled ? (allowed ? 'approval-allowed' : 'approval-denied') : 'approval-pending'}`}>
      <div className="approval-head">
        <span className={`author author-${event.author}`}>@{event.author}</span>
        <strong>{event.text}</strong>
        <span className="muted">
          {settled ? (allowed ? 'approved' : 'declined') : 'waiting on you'}
        </span>
      </div>

      <Input input={detail?.input} />

      {settled ? (
        detail?.note && <p className="muted approval-note">{detail.note}</p>
      ) : (
        <div className="approval-actions">
          <input
            value={note}
            onChange={(input) => setNote(input.target.value)}
            placeholder="Why (optional) — sent back either way"
            aria-label="Reason"
          />
          <button type="button" className="action action-apply" onClick={() => onDecide('allow', note)}>
            Approve
          </button>
          <button type="button" className="action" onClick={() => onDecide('deny', note)}>
            Decline
          </button>
        </div>
      )}
    </div>
  )
}

/** File tools carry the whole new content, which is the part worth actually reading. */
function Input({ input }: { input?: Record<string, unknown> }) {
  if (!input) return null
  const {
    file_path: file,
    content,
    new_string: next,
    old_string: previous,
    command,
    description,
    ...rest
  } = input

  return (
    <div className="approval-input">
      {/* A command is the whole decision, so it leads rather than sitting in the JSON. */}
      {typeof command === 'string' && <pre className="approval-diff approval-command">{command}</pre>}
      {typeof description === 'string' && <p className="muted approval-note">{description}</p>}
      {typeof file === 'string' && <code className="approval-file">{file}</code>}
      {typeof previous === 'string' && <pre className="approval-diff approval-old">{previous}</pre>}
      {typeof next === 'string' && <pre className="approval-diff approval-new">{next}</pre>}
      {typeof content === 'string' && <pre className="approval-diff approval-new">{content}</pre>}
      {Object.keys(rest).length > 0 && <pre className="approval-diff">{JSON.stringify(rest, null, 2)}</pre>}
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
        <span className={`author author-${event.author}`}>@{event.author}</span>
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
