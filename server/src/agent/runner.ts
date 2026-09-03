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
import type { TranscriptStore } from '../transcripts.js'
import type { SpecStore } from '../specStore.js'
import { CODER_URL, probeSandbox } from '../sandbox.js'
import { AGENTS } from './agents.js'
import type { AgentName } from './agents.js'
import { qualified, toolsFor } from './tools.js'

/** How long a pending approval waits before giving up, so a run cannot hang forever. */
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000

interface PendingApproval {
  resolve: (decision: { allow: boolean; note: string | null }) => void
  timer: NodeJS.Timeout
}

export interface RunnerEvent {
  /** `update` re-sends a row that already streamed — a tool call that has now settled. */
  kind: 'append' | 'update' | 'delta' | 'done' | 'approval'
  /** Durable events carry their transcript id; deltas do not. */
  id?: number
  toolCallId?: string
  approvalId?: string
  text?: string
}

export class AgentRunner {
  private readonly emitters = new Map<string, EventEmitter>()
  /**
   * SDK session id per channel *and* agent — each keeps its own conversation, so asking
   * @coder something does not land in the middle of @spec's thread.
   */
  private readonly sdkSessions = new Map<string, string>()
  /** Keyed the same way: @spec working does not block you from messaging @coder. */
  private readonly active = new Set<string>()
  /** Tool calls waiting on a human decision, keyed by the approval id shown in the card. */
  private readonly awaiting = new Map<string, PendingApproval>()
  /**
   * Approvals owned by the sandbox rather than by a promise in this process. The card looks
   * identical from the UI; the difference is where the decision has to be delivered.
   */
  private readonly remoteApprovals = new Map<string, string>()
  /**
   * Sessions where the human has said not to ask, by session id.
   *
   * Deliberately in memory. A permission relaxation that survives a restart is one nobody
   * remembers granting, and the cost of losing it is a single click.
   */
  private readonly unattended = new Set<string>()

  constructor(
    private readonly store: SpecStore,
    private readonly transcripts: TranscriptStore,
  ) {}

  /**
   * Two ways to authenticate, and they are not interchangeable. A console API key
   * (`sk-ant-api...`) goes in ANTHROPIC_API_KEY; a Claude subscription token from
   * `claude setup-token` (`sk-ant-oat...`) goes in CLAUDE_CODE_OAUTH_TOKEN. Putting an
   * OAuth token in the API-key variable loads cleanly and then fails at the first call
   * with "Invalid API key", which is a confusing way to find out.
   *
   * `||` and not `??`: docker compose's `${VAR:-}` sets the variable to an empty string
   * rather than leaving it absent, and `??` treats "" as a present value — so the API-key
   * slot being empty would mask a perfectly good OAuth token sitting next to it.
   */
  static get configured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)
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
    return [...this.active].some((key) => key.startsWith(`${sessionId}:`))
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
  send(sessionId: string, prompt: string, to: AgentName | null): { ok: boolean; error?: string } {
    this.record(sessionId, { author: 'human', kind: 'user', text: prompt })

    // Unaddressed messages go to nobody, as in any channel. Two agents racing to answer
    // is worse than a message that visibly waits for you to say who it is for.
    if (!to) return { ok: true }

    const key = `${sessionId}:${to}`
    if (this.active.has(key)) {
      return { ok: false, error: `@${to} is still working on the previous message.` }
    }

    const misconfigured = AgentRunner.misconfiguration
    if (misconfigured) {
      this.record(sessionId, { author: to, kind: 'error', text: misconfigured })
      return { ok: true }
    }

    if (!AgentRunner.configured) {
      this.record(sessionId, {
        author: to,
        kind: 'error',
        text: 'No credential is set, so the agent cannot run. Put a console API key in ANTHROPIC_API_KEY, or a `claude setup-token` token in CLAUDE_CODE_OAUTH_TOKEN, then restart the server.',
      })
      return { ok: true }
    }

    this.active.add(key)
    // @coder runs in the sandbox when there is one. @spec never does — it has no filesystem
    // and no shell, so there is nothing to contain.
    const start = to === 'coder' && CODER_URL ? this.relay(sessionId, prompt) : this.run(sessionId, prompt, to)
    void start.finally(() => {
      this.active.delete(key)
      this.events(sessionId).emit('event', { kind: 'done' } satisfies RunnerEvent)
    })

    return { ok: true }
  }

  private async run(sessionId: string, prompt: string, to: AgentName): Promise<void> {
    const agent = AGENTS[to]
    const server = createSdkMcpServer({
      name: 'blueprints',
      version: '1.0.0',
      tools: toolsFor(this.store, this.transcripts, agent.domainTools),
    })

    const key = `${sessionId}:${to}`
    const resume = this.sdkSessions.get(key)
    /** Tool calls seen this turn, so a result can be matched back to its call. */
    const openCalls = new Map<string, string>()

    try {
      for await (const message of query({
        prompt,
        options: {
          mcpServers: { blueprints: server },
          // @spec gets none of these, so it reaches the repo only through domain tools.
          // @coder gets file access, rooted at app/ by cwd below.
          tools: agent.builtins,
          // Only the auto-approved builtins go here. A tool named bare in allowedTools
          // never reaches canUseTool, so listing Edit would silently skip its card.
          allowedTools: [...qualified(agent.domainTools), ...agent.autoApprove],
          canUseTool: this.askPermission(sessionId, to),
          ...(agent.disallowedTools ? { disallowedTools: agent.disallowedTools } : {}),
          // Do not inherit the machine's Claude Code settings. Without this the spec agent
          // picks up whatever MCP servers the user has configured globally — Gmail, Drive,
          // Calendar — which have no business being reachable from a glossary tool.
          settingSources: [],
          systemPrompt: agent.systemPrompt,
          includePartialMessages: true,
          cwd: agent.cwd,
          ...(resume ? { resume } : {}),
        },
      })) {
        if (message.type === 'system' && 'session_id' in message && message.session_id) {
          this.sdkSessions.set(key, message.session_id as string)
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
              this.record(sessionId, { author: to, kind: 'assistant', text: block.text })
            }
            if (block.type === 'tool_use') {
              openCalls.set(block.id, block.name)
              this.record(sessionId, {
                author: to,
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
          if (message.session_id) this.sdkSessions.set(key, message.session_id)
          if (message.subtype !== 'success') {
            this.record(sessionId, {
              author: to,
              kind: 'error',
              text: `The run ended early (${message.subtype}).`,
            })
          }
        }
      }
    } catch (cause) {
      this.record(sessionId, { author: to, kind: 'error', text: (cause as Error).message })
    } finally {
      // Anything still open died with the run. Leaving it marked `started` is the honest
      // record — a later resume can see the call may or may not have taken effect.
      for (const [callId] of openCalls) {
        this.transcripts.settleToolCall(callId, 'failed', { error: 'the run ended before this returned' })
      }
    }
  }

  /**
   * The same turn, run in the sandbox instead of here.
   *
   * The container holds no history on purpose, so this is not a handoff — it is a relay.
   * Every event that arrives is written to the same transcript rows the in-process path
   * writes, which is why the UI needs no idea which side ran the turn.
   *
   * There is no fallback. If the sandbox is configured and unreachable, the turn does not
   * run. Quietly running unsandboxed under a UI that says "sandboxed" would be worse than
   * both options it sits between: you would think you had a boundary and you would not.
   * (An *unset* CODER_URL is a different thing — a deliberate choice to run without a
   * sandbox at all, which `send` routes to `run` and /api/sandbox reports honestly.)
   */
  private async relay(sessionId: string, prompt: string): Promise<void> {
    const to: AgentName = 'coder'
    const openCalls = new Set<string>()
    const controller = new AbortController()

    const status = await probeSandbox()
    if (!status.reachable) {
      this.record(sessionId, {
        author: to,
        kind: 'error',
        text: `The @coder sandbox at ${CODER_URL} is not reachable${status.error ? ` (${status.error})` : ''}. Nothing ran — start it with \`docker compose up -d\`. There is deliberately no fallback: running unsandboxed while the UI says otherwise is worse than not running.`,
      })
      return
    }

    try {
      // Open the stream before sending the turn. The container's emitter does not buffer,
      // so anything it publishes before this listener attaches is simply gone — and the
      // first tool call arrives fast enough for that to be a real race, not a theoretical.
      const stream = await fetch(`${CODER_URL}/sessions/${sessionId}/stream`, {
        signal: controller.signal,
      })
      if (!stream.ok || !stream.body) {
        throw new Error(`The sandbox would not open a stream (${stream.status}).`)
      }

      const turn = await fetch(`${CODER_URL}/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sent per turn rather than set on the container, so the sandbox never holds its own
        // idea of whether it may skip approvals.
        body: JSON.stringify({ prompt, unattended: this.unattended.has(sessionId) }),
      })
      if (!turn.ok) {
        throw new Error(`The sandbox refused the turn (${turn.status}): ${await turn.text()}`)
      }

      for await (const event of readEvents(stream.body)) {
        if (event.kind === 'done') break

        if (event.kind === 'delta') {
          this.events(sessionId).emit('event', {
            kind: 'delta',
            text: String(event.text ?? ''),
          } satisfies RunnerEvent)
        } else if (event.kind === 'assistant') {
          this.record(sessionId, { author: to, kind: 'assistant', text: String(event.text ?? '') })
        } else if (event.kind === 'tool_call') {
          const id = String(event.id)
          openCalls.add(id)
          this.record(sessionId, {
            author: to,
            kind: 'tool_call',
            text: shortName(String(event.tool)),
            payload: { input: event.input },
            toolCallId: id,
            status: 'started',
          })
        } else if (event.kind === 'tool_result') {
          const id = String(event.id)
          if (!openCalls.delete(id)) continue
          this.transcripts.settleToolCall(id, event.isError ? 'failed' : 'completed', event.content ?? null)
          this.events(sessionId).emit('event', { kind: 'update', toolCallId: id } satisfies RunnerEvent)
        } else if (event.kind === 'approval') {
          const approvalId = String(event.approvalId)
          // Recorded here, decided here, delivered back over HTTP by `decide`.
          this.remoteApprovals.set(approvalId, sessionId)
          this.record(sessionId, {
            author: to,
            kind: 'approval',
            text: String(event.tool),
            payload: { input: event.input },
            toolCallId: approvalId,
            status: 'started',
          })
        } else if (event.kind === 'auto_approved') {
          // Recorded exactly like one you answered, settled in the same breath. Not asking
          // is not the same as not saying: the transcript still shows every write and every
          // command, so an unattended run is reviewable after the fact rather than invisible.
          const approvalId = String(event.approvalId)
          this.record(sessionId, {
            author: to,
            kind: 'approval',
            text: String(event.tool),
            payload: { input: event.input },
            toolCallId: approvalId,
            status: 'started',
          })
          this.transcripts.settleApproval(approvalId, 'allow', 'unattended')
          this.events(sessionId).emit('event', { kind: 'approval', approvalId } satisfies RunnerEvent)
        } else if (event.kind === 'approval_expired') {
          const approvalId = String(event.approvalId)
          this.remoteApprovals.delete(approvalId)
          this.transcripts.settleApproval(approvalId, 'deny', 'no answer')
          this.events(sessionId).emit('event', { kind: 'approval', approvalId } satisfies RunnerEvent)
        } else if (event.kind === 'error') {
          this.record(sessionId, { author: to, kind: 'error', text: String(event.text ?? '') })
        }
      }
    } catch (cause) {
      this.record(sessionId, { author: to, kind: 'error', text: (cause as Error).message })
    } finally {
      controller.abort()
      // Same honesty as the in-process path: a call still open died with the run, and may
      // or may not have taken effect on the far side.
      for (const callId of openCalls) {
        this.transcripts.settleToolCall(callId, 'failed', { error: 'the run ended before this returned' })
      }
    }
  }

  isUnattended(sessionId: string): boolean {
    return this.unattended.has(sessionId)
  }

  /**
   * Lets @coder work without a card for this session — and only where that is defensible.
   *
   * Refused outright when there is no reachable sandbox, rather than warned about. Running
   * in-process means the agent has a shell on your actual filesystem and the card is the
   * only boundary there is; "skip the only boundary" is not a preference to be respected.
   * The permission is a property of running in a box, so no box means no permission.
   *
   * Turning it *off* never needs a sandbox — you can always ask to be asked again.
   */
  async setUnattended(sessionId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!enabled) {
      this.unattended.delete(sessionId)
      return { ok: true }
    }

    if (!CODER_URL) {
      return {
        ok: false,
        error: 'No sandbox is configured, so @coder runs in this process with a shell on your filesystem. The approval card is the only boundary there — it cannot be turned off.',
      }
    }

    const status = await probeSandbox()
    if (!status.reachable) {
      return {
        ok: false,
        error: `The sandbox is not reachable${status.error ? ` (${status.error})` : ''}, so nothing can run unattended. Start it with \`docker compose up -d\`.`,
      }
    }

    this.unattended.add(sessionId)
    return { ok: true }
  }

  newSessionId(): string {
    return randomUUID()
  }

  /**
   * Answers a pending approval. Returns false when nothing is waiting — the run was
   * abandoned, or the server restarted and the promise went with it. The transcript row
   * still says `started` in that case, which is the honest record.
   */
  async decide(approvalId: string, allow: boolean, note: string | null): Promise<boolean> {
    const pending = this.awaiting.get(approvalId)
    if (pending) {
      clearTimeout(pending.timer)
      this.awaiting.delete(approvalId)
      this.transcripts.settleApproval(approvalId, allow ? 'allow' : 'deny', note)
      this.events(this.sessionOf(approvalId)).emit('event', {
        kind: 'approval',
        approvalId,
      } satisfies RunnerEvent)
      pending.resolve({ allow, note })
      return true
    }

    // Not ours: a run blocked inside the sandbox, waiting on this decision over HTTP.
    const sessionId = this.remoteApprovals.get(approvalId)
    if (sessionId === undefined) return false

    // Deliver first, record second. Settling the transcript for a decision that never
    // arrived would leave the row saying "allowed" beside an agent still sitting on the
    // question — the one inconsistency worth ordering the code around.
    const response = await fetch(`${CODER_URL}/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: allow ? 'allow' : 'deny', note }),
    }).catch(() => null)

    if (!response?.ok) return false

    this.remoteApprovals.delete(approvalId)
    this.transcripts.settleApproval(approvalId, allow ? 'allow' : 'deny', note)
    this.events(sessionId).emit('event', { kind: 'approval', approvalId } satisfies RunnerEvent)
    return true
  }

  private sessionOf(approvalId: string): string {
    return this.transcripts.readApproval(approvalId)?.sessionId ?? ''
  }

  /**
   * The SDK calls this before any tool that is not auto-approved. It records the request,
   * pushes it to the UI, and blocks — the run genuinely waits here, which is the point.
   */
  private askPermission(sessionId: string, to: AgentName) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string }
    > => {
      const approvalId = randomUUID()
      this.record(sessionId, {
        author: to,
        kind: 'approval',
        text: toolName,
        payload: { input },
        toolCallId: approvalId,
        status: 'started',
      })

      const decision = await new Promise<{ allow: boolean; note: string | null }>((resolve) => {
        const timer = setTimeout(() => {
          this.awaiting.delete(approvalId)
          this.transcripts.settleApproval(approvalId, 'deny', 'no answer')
          resolve({ allow: false, note: 'no answer' })
        }, APPROVAL_TIMEOUT_MS)

        this.awaiting.set(approvalId, { resolve, timer })
      })

      return decision.allow
        ? { behavior: 'allow', updatedInput: input }
        : {
            behavior: 'deny',
            message: decision.note
              ? `The human declined this: ${decision.note}`
              : 'The human declined this. Do not retry it; ask what they would prefer instead.',
          }
    }
  }
}

function shortName(toolName: string): string {
  return toolName.replace(/^mcp__blueprints__/, '')
}

/**
 * The sandbox's SSE stream, as events.
 *
 * Deliberately minimal: this consumes one stream from one service we wrote, which only ever
 * sends `data:` lines and keep-alive comments. A full SSE parser would handle event types,
 * ids and retry hints that nothing here emits.
 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) return

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    // The last piece may be half a line; keep it for the next chunk.
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        yield JSON.parse(line.slice(6)) as Record<string, unknown>
      } catch {
        // A malformed frame is the sandbox's bug, not a reason to drop the whole run.
      }
    }
  }
}
