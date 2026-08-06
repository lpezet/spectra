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
import { z } from 'zod'
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { SPECS_DIR, readChangesets, readQuestions, readTerms, reachable } from './glossary.js'

const PORT = Number(process.env.PORT ?? 5177)
const APP_DIR = process.env.APP_DIR ?? '/work/app'
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000

const SYSTEM_PROMPT = `You are @coder, working inside a sandbox on todo-blueprints. You own app/ — a ToDo app implemented from a glossary of Terms that lives in specs/.

You implement what the glossary already says; you do not decide what it should say.

Your working directory is app/, and it is the only thing you can write. The glossary is mounted read-only: you can read every term, changeset and question, and you cannot change any of them. You also have no network.

Two things follow from that, and you must not pretend otherwise:
- You cannot raise a question or mark a changeset implemented from here. When the specs are wrong, incomplete, or say two contradictory things, say so clearly in your reply and stop — the human will raise it with @spec. Do not work around it, and do not change the code to something the specs do not describe.
- When you finish implementing a changeset, name it in your reply so the human can mark it implemented.

How to run an implementation pass:
1. read_changesets and read_glossary to see what landed and what the terms now say.
2. Find the files whose "// implements:" marker names the affected terms. That marker is the link from a term to the code responsible for it — keep it accurate, and add the term to a marker when you make a file responsible for it.
3. Change the code to match. Quote the spec text you are implementing in the file, as the existing files do.
4. Update the tests, including any the changeset committed to under "tests".
5. Run \`npm test\` and \`npm run typecheck\` and fix what they report.

Every edit and every command is shown to the human for approval before it happens, so make one focused change at a time and say what it is for — a diff nobody can follow gets declined.

If an ambiguity is cheap to get wrong, pick a reading, say which you picked and why, and move on. If getting it wrong would waste the work, stop and say so rather than guessing.

Be concise and concrete. Cite term names, changeset ids and file paths.`

function say(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

const tools = [
  tool(
    'read_glossary',
    'Read the spec glossary. Omit `term` for all of them in summary form; supply one for its full spec and attributes.',
    { term: z.string().optional() },
    async (args) => {
      const terms = readTerms()
      if (!args.term) {
        return say(terms.map((term) => ({ name: term.name, type: term.type, spec: term.spec })))
      }
      const found = terms.find((term) => term.name === args.term)
      return say(found ?? { error: `No term named "${args.term}".`, known: terms.map((t) => t.name) })
    },
    { annotations: { readOnlyHint: true } },
  ),
  tool(
    'read_changesets',
    'Read changesets — what is pending review, and what has been applied to the glossary.',
    {},
    async () => say(readChangesets()),
    { annotations: { readOnlyHint: true } },
  ),
  tool(
    'read_questions',
    'Read questions raised against the glossary, answered and open. Answered ones record why the specs say what they say.',
    {},
    async () => say(readQuestions()),
    { annotations: { readOnlyHint: true } },
  ),
]

const TOOL_NAMES = ['read_glossary', 'read_changesets', 'read_questions'].map(
  (name) => `mcp__glossary__${name}`,
)

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
  const server = createSdkMcpServer({ name: 'glossary', version: '1.0.0', tools })
  const resume = sdkSessions.get(sessionId)

  try {
    for await (const message of query({
      prompt,
      options: {
        mcpServers: { glossary: server },
        tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
        // Reads run freely; anything that changes a file or runs a command is not here,
        // which is what routes it through canUseTool and out to the approval card.
        allowedTools: [...TOOL_NAMES, 'Read', 'Glob', 'Grep'],
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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    appDir: APP_DIR,
    specsDir: SPECS_DIR,
    glossaryReachable: reachable(),
    // Says plainly what this box cannot do, so the caller need not infer it.
    canWriteSpecs: false,
    configured: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN),
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
  console.log(`[coder] specs: ${SPECS_DIR} (read-only, ${reachable() ? 'reachable' : 'NOT MOUNTED'})`)
  console.log(`[coder] listening on http://0.0.0.0:${PORT}`)
})
