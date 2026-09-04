/**
 * The sandboxed half of @coder.
 *
 * Runs the agent loop next to the code it edits, inside a container that can write only
 * `/work/app`. The spec tool talks to it over HTTP and keeps the transcript — this service
 * holds no history of its own on purpose: the record belongs with the specs, and a box you
 * can delete and rebuild should not be where anything is kept.
 *
 * Approvals work exactly as before. `canUseTool` blocks the run, the pending request goes
 * out on the stream, and the decision comes back in on `/approvals/:id`.
 */
import express from 'express'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

const PORT = Number(process.env.PORT ?? 5177)
// The project @coder implements into — its cwd and only writable mount. Configurable so the
// container can be pointed at whatever project it serves; `spectra init` mounts the repo here.
// The glossary is NOT under this path — it arrives as tool calls (see SPEC_URL below).
const APP_DIR = process.env.APP_DIR ?? '/work/project'
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Where the glossary lives — a URL now, not a mount.
 *
 * This service used to read `/work/specs` from a read-only bind mount through its own copy
 * of the reader. Two problems with that, and the second is the real one. The copy had
 * already drifted from the spec tool's. And a mount can only ever offer *reading*: writes
 * to the glossary directory — raising a question, marking a changeset implemented — were
 * impossible from here, because the only way to grant them would have been a read-write
 * mount that also granted rewriting any term.
 *
 * Over a tool call they are two capabilities, granted individually, executed by the process
 * that owns `specs/` and can refuse. Which tools those are is decided there, not here: this
 * service asks for the `coder` endpoint and gets whatever agents.ts says `@coder` may have.
 */
const SPEC_URL = process.env.SPEC_URL ?? 'http://spec:5174'
const MCP_URL = `${SPEC_URL}/mcp/coder`

/**
 * Who this agent is — fetched, not stored.
 *
 * The system prompt used to live here as a second copy of the one in the spec tool's
 * agents.ts, and it had already started to differ. Same mistake as the glossary reader that
 * used to sit next to it: two answers to "who is @coder", and the copy an attacker who got
 * into this container could edit is this one. So agents.ts is the single definition and this
 * asks for it — prompt, which builtins to load, which run without a card, and the tool list.
 *
 * Fetched per run rather than at boot, so editing agents.ts and restarting the spec tool is
 * enough; this container does not need rebuilding to change who it is.
 */
interface Profile {
  systemPrompt: string
  builtins: string[]
  autoApprove: string[]
  disallowedTools: string[]
  tools: string[]
}

async function profile(): Promise<Profile> {
  const response = await fetch(`${MCP_URL}/profile`, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`The spec tool answered ${response.status} for the agent profile.`)
  return (await response.json()) as Profile
}

interface Pending {
  resolve: (allow: { allow: boolean; note: string | null }) => void
  timer: NodeJS.Timeout
}

const streams = new Map<string, EventEmitter>()
const awaiting = new Map<string, Pending>()
const sdkSessions = new Map<string, string>()
const active = new Set<string>()

function channel(sessionId: string): EventEmitter {
  let emitter = streams.get(sessionId)
  if (!emitter) {
    emitter = new EventEmitter()
    emitter.setMaxListeners(0)
    streams.set(sessionId, emitter)
  }
  return emitter
}

function emit(sessionId: string, event: Record<string, unknown>): void {
  channel(sessionId).emit('event', event)
}

/**
 * Blocks the run until the spec tool relays a decision back in — unless the human has said
 * not to for this session.
 *
 * `unattended` is only ever reached because of where this code runs. The card used to carry
 * the entire boundary; in here the container has no route out, no credential, and one
 * writable mount holding code you can rebuild. Approving `npm run typecheck` under those
 * conditions is ceremony, not safety. The spec tool refuses to turn this on for an agent
 * that is not in a container, which is the case where the card really is the only thing.
 *
 * What it does not skip: `disallowedTools`. Those are refused by the SDK before this
 * callback is consulted, so `git commit` and friends stay refused. Skipping review is not
 * granting everything.
 *
 * Every auto-allowed call is still announced and still recorded. Not asking is not the same
 * as not saying — the point is to stop interrupting you, not to work where you cannot see.
 */
function askPermission(sessionId: string, unattended: boolean) {
  return async (toolName: string, input: Record<string, unknown>) => {
    const approvalId = randomUUID()

    if (unattended) {
      emit(sessionId, { kind: 'auto_approved', approvalId, tool: toolName, input })
      return { behavior: 'allow', updatedInput: input } as const
    }

    emit(sessionId, { kind: 'approval', approvalId, tool: toolName, input })

    const decision = await new Promise<{ allow: boolean; note: string | null }>((resolve) => {
      const timer = setTimeout(() => {
        awaiting.delete(approvalId)
        // Say so, or the card on the other side sits at "waiting" forever describing a
        // decision that has already been made for it.
        emit(sessionId, { kind: 'approval_expired', approvalId })
        resolve({ allow: false, note: 'no answer' })
      }, APPROVAL_TIMEOUT_MS)
      awaiting.set(approvalId, { resolve, timer })
    })

    return decision.allow
      ? ({ behavior: 'allow', updatedInput: input } as const)
      : ({
          behavior: 'deny',
          message: decision.note
            ? `The human declined this: ${decision.note}`
            : 'The human declined this. Do not retry it; ask what they would prefer instead.',
        } as const)
  }
}

async function run(sessionId: string, prompt: string, unattended: boolean): Promise<void> {
  const resume = sdkSessions.get(sessionId)

  let who: Profile
  try {
    who = await profile()
  } catch (cause) {
    // Worth failing loudly rather than running blind: an agent that silently lost the
    // glossary will implement something plausible and wrong.
    emit(sessionId, {
      kind: 'error',
      text: `Cannot reach the spec tool at ${MCP_URL} (${(cause as Error).message}). Not starting a run without it.`,
    })
    return
  }

  try {
    for await (const message of query({
      prompt,
      options: {
        // Over HTTP to the spec tool, not in-process. One definition of these tools exists
        // and it lives with the files they touch.
        mcpServers: { blueprints: { type: 'http', url: MCP_URL } },
        tools: who.builtins,
        // Reads run freely; anything that changes a file or runs a command is not here,
        // which is what routes it through canUseTool and out to the approval card.
        allowedTools: [
          ...who.tools.map((name) => `mcp__blueprints__${name}`),
          ...who.autoApprove,
        ],
        ...(who.disallowedTools.length > 0 ? { disallowedTools: who.disallowedTools } : {}),
        canUseTool: askPermission(sessionId, unattended),
        settingSources: [],
        systemPrompt: who.systemPrompt,
        includePartialMessages: true,
        cwd: APP_DIR,
        ...(resume ? { resume } : {}),
      },
    })) {
      if (message.type === 'system' && 'session_id' in message && message.session_id) {
        sdkSessions.set(sessionId, message.session_id as string)
      } else if (message.type === 'stream_event') {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          emit(sessionId, { kind: 'delta', text: event.delta.text ?? '' })
        }
      } else if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            emit(sessionId, { kind: 'assistant', text: block.text })
          }
          if (block.type === 'tool_use') {
            emit(sessionId, { kind: 'tool_call', tool: block.name, id: block.id, input: block.input })
          }
        }
      } else if (message.type === 'user') {
        // Tool results arrive as a user turn. Relayed on so the transcript on the other
        // side can settle the call — without this a tool row streams as "running" and stays
        // there, because nothing else ever mentions that id again.
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_result') {
              const result = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
              emit(sessionId, {
                kind: 'tool_result',
                id: result.tool_use_id,
                isError: result.is_error === true,
                content: result.content ?? null,
              })
            }
          }
        }
      } else if (message.type === 'result') {
        if (message.session_id) sdkSessions.set(sessionId, message.session_id)
        if (message.subtype !== 'success') {
          emit(sessionId, { kind: 'error', text: `The run ended early (${message.subtype}).` })
        }
      }
    }
  } catch (cause) {
    emit(sessionId, { kind: 'error', text: (cause as Error).message })
  }
}

const app = express()
app.use(express.json({ limit: '4mb' }))

/**
 * The specs version committed in app/, read from the file on this container's mount.
 *
 * This is why mark_implemented needs no version argument. An agent that supplied its own
 * could fetch a fresh one, never write it down, and pass the check on the second try. Only
 * the process holding the mount can say what is actually on disk, so it says it, and the
 * spec tool asks rather than being told.
 */
function snapshotVersion(): string | null {
  try {
    const raw = readFileSync(path.join(APP_DIR, 'specs.snapshot.json'), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

app.get('/health', async (_req, res) => {
  let tools: string[] | null = null
  let glossaryError: string | null = null
  try {
    tools = (await profile()).tools
  } catch (cause) {
    glossaryError = (cause as Error).message
  }

  res.json({
    ok: true,
    appDir: APP_DIR,
    glossary: MCP_URL,
    // Read from the mount on every request, never cached — a cached copy would survive the
    // file being reverted underneath it, which is precisely the case this exists to catch.
    snapshotVersion: snapshotVersion(),
    // The honest answer to "what can this box do to the glossary?", and it comes from the
    // spec tool rather than from here — so it cannot be flattering.
    tools,
    glossaryError,
    // `||`, not `??` — compose passes an unset variable through as "", which `??` accepts
    // as a value and which would then hide the credential in the other slot.
    configured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
  })
})

app.post('/sessions/:id/turn', (req, res) => {
  const sessionId = req.params.id
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  if (!prompt) {
    res.status(400).json({ ok: false, error: 'Expected { prompt: string }.' })
    return
  }
  if (active.has(sessionId)) {
    res.status(409).json({ ok: false, error: '@coder is still working on the previous message.' })
    return
  }

  active.add(sessionId)
  // Decided by the spec tool, per turn — never remembered here. A container that kept its
  // own "permissions off" state would be a container that could keep it on.
  const unattended = req.body?.unattended === true
  void run(sessionId, prompt, unattended).finally(() => {
    active.delete(sessionId)
    emit(sessionId, { kind: 'done' })
  })

  res.status(202).json({ ok: true })
})

app.post('/approvals/:approvalId', (req, res) => {
  const pending = awaiting.get(req.params.approvalId)
  if (!pending) {
    res.status(409).json({ ok: false, error: 'Nothing is waiting on that any more.' })
    return
  }

  clearTimeout(pending.timer)
  awaiting.delete(req.params.approvalId)
  pending.resolve({
    allow: req.body?.decision === 'allow',
    note: typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : null,
  })

  res.json({ ok: true })
})

app.get('/sessions/:id/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const emitter = channel(req.params.id)
  const onEvent = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  emitter.on('event', onEvent)

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(keepAlive)
    emitter.off('event', onEvent)
  })
})

app.listen(PORT, () => {
  console.log(`[coder] app: ${APP_DIR}`)
  console.log(`[coder] glossary: ${MCP_URL} (tools, not a mount)`)
  console.log(`[coder] listening on http://0.0.0.0:${PORT}`)
})
