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
import { query } from '@anthropic-ai/claude-agent-sdk'

const PORT = Number(process.env.PORT ?? 5177)
const APP_DIR = process.env.APP_DIR ?? '/work/app'
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

const SYSTEM_PROMPT = `You are @coder, working inside a sandbox on todo-blueprints. You own app/ — a ToDo app implemented from a glossary of Terms that lives in specs/.

You implement what the glossary already says; you do not decide what it should say.

Your working directory is app/, and it is the only thing you can write. The glossary is not on your filesystem at all — you reach it through tools served by the spec tool, which owns those files. You can read every term, changeset and question through them, and there is no tool here that edits a term. That is not a rule you are being asked to follow; it is the whole surface you have.

Two of those tools do write, and they are the way work comes back:
- raise_question, when the specs are wrong, incomplete, or say two contradictory things. Raise it rather than working around it, and do not change the code to something the specs do not describe. A question is for a decision a human must make — if it cannot be phrased as something someone answers, do not raise it.
- mark_implemented, when you have finished a changeset and its tests pass.

How to run an implementation pass:
1. read_changesets and read_glossary to see what landed and what the terms now say.
2. Find the files whose "// implements:" marker names the affected terms. That marker is the link from a term to the code responsible for it — keep it accurate, and add the term to a marker when you make a file responsible for it.
3. Change the code to match. Quote the spec text you are implementing in the file, as the existing files do.
4. Update the tests, including any the changeset committed to under "tests".
5. Run \`npm test\` and \`npm run typecheck\` and fix what they report.
6. Call mark_implemented with the changeset id.

Every edit, and every command that changes anything, is shown to the human for approval before it happens. Commands the SDK judges read-only run without asking. So make one focused change at a time and say what it is for — a diff nobody can follow gets declined.

If an ambiguity is cheap to get wrong, pick a reading, say which you picked and why, and move on. If getting it wrong would waste the work, stop and say so rather than guessing.

Be concise and concrete. Cite term names, changeset ids and file paths.`

/**
 * Which glossary tools this agent may call — asked, not assumed.
 *
 * The obvious thing is a hardcoded list here. But then two places would decide what @coder
 * can do, and the one in this container is the one an attacker who got in would edit. So
 * ask the spec tool, and let the answer be whatever agents.ts says. Naming a tool the
 * server does not serve gets "tool not found" from the server regardless, so this list is
 * a convenience for the model, not the boundary.
 *
 * Cached for the life of the process: it changes when agents.ts changes, which means a
 * restart of the other container anyway.
 */
let cachedToolNames: string[] | null = null

async function glossaryToolNames(): Promise<string[]> {
  if (cachedToolNames) return cachedToolNames

  const response = await fetch(`${MCP_URL}/tools`, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`The spec tool answered ${response.status} for the tool list.`)

  const body = (await response.json()) as { tools: Array<{ name: string }> }
  cachedToolNames = body.tools.map((entry) => `mcp__blueprints__${entry.name}`)
  return cachedToolNames
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

/** Blocks the run until the spec tool relays a decision back in. */
function askPermission(sessionId: string) {
  return async (toolName: string, input: Record<string, unknown>) => {
    const approvalId = randomUUID()
    emit(sessionId, { kind: 'approval', approvalId, tool: toolName, input })

    const decision = await new Promise<{ allow: boolean; note: string | null }>((resolve) => {
      const timer = setTimeout(() => {
        awaiting.delete(approvalId)
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

async function run(sessionId: string, prompt: string): Promise<void> {
  const resume = sdkSessions.get(sessionId)

  let toolNames: string[]
  try {
    toolNames = await glossaryToolNames()
  } catch (cause) {
    // Worth failing loudly rather than running blind: an agent that silently lost the
    // glossary will implement something plausible and wrong.
    emit(sessionId, {
      kind: 'error',
      text: `Cannot reach the glossary at ${MCP_URL} (${(cause as Error).message}). Not starting a run without it.`,
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
        tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
        // Reads run freely; anything that changes a file or runs a command is not here,
        // which is what routes it through canUseTool and out to the approval card.
        allowedTools: [...toolNames, 'Read', 'Glob', 'Grep'],
        canUseTool: askPermission(sessionId),
        settingSources: [],
        systemPrompt: SYSTEM_PROMPT,
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

app.get('/health', async (_req, res) => {
  let tools: string[] | null = null
  let glossaryError: string | null = null
  try {
    tools = (await glossaryToolNames()).map((name) => name.replace('mcp__blueprints__', ''))
  } catch (cause) {
    glossaryError = (cause as Error).message
  }

  res.json({
    ok: true,
    appDir: APP_DIR,
    glossary: MCP_URL,
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
  void run(sessionId, prompt).finally(() => {
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
