/**
 * Runs the spec agent and records what it does.
 *
 * The run is deliberately not tied to the HTTP request that started it. A turn can take
 * minutes; closing the tab must not kill it. So `send()` returns as soon as the run is
 * launched, every durable event lands in SQLite, and the SSE endpoint reads from there.
 * Reconnecting is then just "replay from cursor" rather than anything stateful.
 *
 * Two stores, on purpose. SQLite is the product record — searchable, prunable, and what
 * the UI replays. The SDK keeps its own session for resuming a conversation; we hold on
 * to its id and nothing more.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk'
import { SPECS_DIR } from '../store.js'
import type { TranscriptStore } from '../transcripts.js'
import { TOOL_NAMES, blueprintTools } from './tools.js'

const SYSTEM_PROMPT = `You are the spec agent for todo-blueprints, a tool for authoring a shared glossary that a human and an AI coder both work from. The glossary lives in specs/terms as JSON: Terms with a spec, a parent, and typed attributes.

Rules you work under:

- The human write path is changesets only. You cannot edit terms and must not describe doing so as though you could.
- When something is genuinely undecided, raise a question. A question is for a decision a human must make, not for an observation. If it cannot be phrased as something someone answers, do not raise it.
- When asked what to work on first, call analyze_pending and answer from what it returns. Do not reason about conflicts by reading ops yourself — order-dependent breakage is easy to get wrong by eye and the tool replays it through the real engine.
- Prefer quoting spec text over paraphrasing it. Precision about what the specs actually say is the point of this tool.

Be concise and concrete. Cite term names, question ids and changeset ids. When you are unsure whether something is settled, check with read_questions before assuming.`

export interface RunnerEvent {
  /** `update` re-sends a row that already streamed — a tool call that has now settled. */
  kind: 'append' | 'update' | 'delta' | 'done'
  /** Durable events carry their transcript id; deltas do not. */
  id?: number
  toolCallId?: string
  text?: string
}

export class AgentRunner {
  private readonly emitters = new Map<string, EventEmitter>()
  /** SDK session id per chat session, so a follow-up turn resumes rather than restarts. */
  private readonly sdkSessions = new Map<string, string>()
  private readonly active = new Set<string>()

  constructor(private readonly transcripts: TranscriptStore) {}

  /**
   * Two ways to authenticate, and they are not interchangeable. A console API key
   * (`sk-ant-api...`) goes in ANTHROPIC_API_KEY; a Claude subscription token from
   * `claude setup-token` (`sk-ant-oat...`) goes in CLAUDE_CODE_OAUTH_TOKEN. Putting an
   * OAuth token in the API-key variable loads cleanly and then fails at the first call
   * with "Invalid API key", which is a confusing way to find out.
   */
  static get configured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN)
  }

  /** Null when the credential looks like it is in the wrong variable. */
  static get misconfiguration(): string | null {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (apiKey?.startsWith('sk-ant-oat')) {
      return 'ANTHROPIC_API_KEY holds a Claude Code OAuth token (sk-ant-oat…). Move it to CLAUDE_CODE_OAUTH_TOKEN, or use a console API key (sk-ant-api…) instead.'
    }
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (oauth?.startsWith('sk-ant-api')) {
      return 'CLAUDE_CODE_OAUTH_TOKEN holds a console API key (sk-ant-api…). Move it to ANTHROPIC_API_KEY.'
    }
    return null
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  events(sessionId: string): EventEmitter {
    let emitter = this.emitters.get(sessionId)
    if (!emitter) {
      emitter = new EventEmitter()
      emitter.setMaxListeners(0)
      this.emitters.set(sessionId, emitter)
    }
    return emitter
  }

  private record(sessionId: string, event: Parameters<TranscriptStore['append']>[1]): number {
    const id = this.transcripts.append(sessionId, event, new Date().toISOString())
    this.events(sessionId).emit('event', { kind: 'append', id } satisfies RunnerEvent)
    return id
  }

  /**
   * Records the human turn, then launches the agent. Returns once the run has started —
   * output arrives over the session's event stream.
   */
  send(sessionId: string, prompt: string): { ok: boolean; error?: string } {
    if (this.active.has(sessionId)) {
      return { ok: false, error: 'That conversation is still working on the previous message.' }
    }

    this.record(sessionId, { kind: 'user', text: prompt })

    const misconfigured = AgentRunner.misconfiguration
    if (misconfigured) {
      this.record(sessionId, { kind: 'error', text: misconfigured })
      return { ok: true }
    }

    if (!AgentRunner.configured) {
      this.record(sessionId, {
        kind: 'error',
        text: 'No credential is set, so the agent cannot run. Put a console API key in ANTHROPIC_API_KEY, or a `claude setup-token` token in CLAUDE_CODE_OAUTH_TOKEN, then restart the server.',
      })
      return { ok: true }
    }

    this.active.add(sessionId)
    void this.run(sessionId, prompt).finally(() => {
      this.active.delete(sessionId)
      this.events(sessionId).emit('event', { kind: 'done' } satisfies RunnerEvent)
    })

    return { ok: true }
  }

  private async run(sessionId: string, prompt: string): Promise<void> {
    const server = createSdkMcpServer({
      name: 'blueprints',
      version: '1.0.0',
      tools: blueprintTools(this.transcripts),
    })

    const resume = this.sdkSessions.get(sessionId)
    /** Tool calls seen this turn, so a result can be matched back to its call. */
    const openCalls = new Map<string, string>()

    try {
      for await (const message of query({
        prompt,
        options: {
          mcpServers: { blueprints: server },
          // No built-in tools at all: the agent reaches the repo only through the domain
          // tools above, which is what keeps it on the changeset path.
          tools: [],
          allowedTools: TOOL_NAMES,
          // Do not inherit the machine's Claude Code settings. Without this the spec agent
          // picks up whatever MCP servers the user has configured globally — Gmail, Drive,
          // Calendar — which have no business being reachable from a glossary tool.
          settingSources: [],
          systemPrompt: SYSTEM_PROMPT,
          includePartialMessages: true,
          cwd: SPECS_DIR,
          ...(resume ? { resume } : {}),
        },
      })) {
        if (message.type === 'system' && 'session_id' in message && message.session_id) {
          this.sdkSessions.set(sessionId, message.session_id as string)
          continue
        }

        if (message.type === 'stream_event') {
          const event = message.event as { type?: string; delta?: { type?: string; text?: string } }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            // Deltas are for live typing only — never persisted, so a reconnect mid-answer
            // simply waits for the complete message rather than stitching fragments.
            this.events(sessionId).emit('event', {
              kind: 'delta',
              text: event.delta.text ?? '',
            } satisfies RunnerEvent)
          }
          continue
        }

        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              this.record(sessionId, { kind: 'assistant', text: block.text })
            }
            if (block.type === 'tool_use') {
              openCalls.set(block.id, block.name)
              this.record(sessionId, {
                kind: 'tool_call',
                text: shortName(block.name),
                payload: { input: block.input },
                toolCallId: block.id,
                status: 'started',
              })
            }
          }
          continue
        }

        if (message.type === 'user') {
          // Tool results come back as a user turn; settle the call they belong to.
          const content = message.message.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_result') {
                const result = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
                if (!openCalls.has(result.tool_use_id)) continue
                this.transcripts.settleToolCall(
                  result.tool_use_id,
                  result.is_error ? 'failed' : 'completed',
                  result.content ?? null,
                )
                openCalls.delete(result.tool_use_id)
                this.events(sessionId).emit('event', {
                  kind: 'update',
                  toolCallId: result.tool_use_id,
                } satisfies RunnerEvent)
              }
            }
          }
          continue
        }

        if (message.type === 'result') {
          if (message.session_id) this.sdkSessions.set(sessionId, message.session_id)
          if (message.subtype !== 'success') {
            this.record(sessionId, {
              kind: 'error',
              text: `The run ended early (${message.subtype}).`,
            })
          }
        }
      }
    } catch (cause) {
      this.record(sessionId, { kind: 'error', text: (cause as Error).message })
    } finally {
      // Anything still open died with the run. Leaving it marked `started` is the honest
      // record — a later resume can see the call may or may not have taken effect.
      for (const [callId] of openCalls) {
        this.transcripts.settleToolCall(callId, 'failed', { error: 'the run ended before this returned' })
      }
    }
  }

  newSessionId(): string {
    return randomUUID()
  }
}

function shortName(toolName: string): string {
  return toolName.replace(/^mcp__blueprints__/, '')
}
