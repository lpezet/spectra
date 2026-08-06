/**
 * The domain tools, served over HTTP.
 *
 * Same tools `@spec` and `@coder` call in-process — one definition, in tools.ts — reachable
 * now by an agent in another container. That is what lets the sandbox stop carrying its own
 * copy of the glossary reader, which had already started to drift.
 *
 * The reason this is better than the read-only mount it replaces is not tidiness. A mount
 * gives the sandbox bytes and hopes it behaves; a tool call is a request to *this* process,
 * which owns `specs/` and can refuse. `mark_implemented` and `raise_question` are writes to
 * the glossary directory, and no mount could ever have offered them without also offering
 * the ability to rewrite a term. Over a tool they are exactly two capabilities, granted one
 * at a time.
 *
 * Which is why the tool list comes from the agent's own definition rather than the caller's
 * request. `@coder` gets the six tools agents.ts says it gets; asking for `propose_changeset`
 * gets "no such tool", not a refusal it could argue with. The client's `allowedTools` is a
 * second lock on the same door, not the only one.
 *
 * Stateless on purpose: a fresh server and transport per request, no session id, no
 * cross-request state. The tools are individually atomic and every read goes back to disk
 * anyway, so a session would buy nothing and would need cleaning up after a container that
 * went away without saying goodbye.
 */
import { Router } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AGENTS } from './agents.js'
import type { AgentName } from './agents.js'
import { toolsFor } from './tools.js'
import type { TranscriptStore } from '../transcripts.js'

/** The name the tools appear under, and so the `mcp__blueprints__` prefix on the far side. */
const SERVER_NAME = 'blueprints'

export function mcpRoutes(transcripts: TranscriptStore): Router {
  const router = Router()

  /**
   * Says what an agent would get without opening a session. Useful from the host, where
   * the sandbox itself is unreachable, to answer "which tools does @coder actually have?"
   * from the server that decides it rather than from the config that requests them.
   */
  router.get('/:agent/tools', (req, res) => {
    const agent = AGENTS[req.params.agent as AgentName]
    if (!agent) {
      res.status(404).json({ error: `No agent called "${req.params.agent}".` })
      return
    }
    res.json({
      agent: agent.name,
      tools: toolsFor(transcripts, agent.domainTools).map((entry) => ({
        name: entry.name,
        description: entry.description,
      })),
    })
  })

  /**
   * Who the agent is, for a container that runs its loop.
   *
   * The sandbox used to carry its own copy of the system prompt, which is the same mistake
   * as its own copy of the glossary reader and drifts the same way — two answers to "who is
   * @coder", and the one an attacker can edit is the one in the box. So agents.ts stays the
   * single definition and the container asks for it at the start of every run.
   *
   * `disallowedTools` goes over verbatim, including the `specs/` path rules whose paths only
   * exist on this side. They match nothing in the container, which is harmless — the mount
   * they guarded is gone, and the shell entries are the ones that still do work.
   */
  router.get('/:agent/profile', (req, res) => {
    const agent = AGENTS[req.params.agent as AgentName]
    if (!agent) {
      res.status(404).json({ error: `No agent called "${req.params.agent}".` })
      return
    }
    res.json({
      agent: agent.name,
      systemPrompt: agent.systemPrompt,
      builtins: agent.builtins,
      autoApprove: agent.autoApprove,
      disallowedTools: agent.disallowedTools ?? [],
      tools: toolsFor(transcripts, agent.domainTools).map((entry) => entry.name),
    })
  })

  router.post('/:agent', async (req, res) => {
    const agent = AGENTS[req.params.agent as AgentName]
    if (!agent) {
      res.status(404).json({ error: `No agent called "${req.params.agent}".` })
      return
    }

    const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' })

    /**
     * One cast, in one place, rather than sprinkled over the loop below.
     *
     * Two copies of zod are in play: this server's zod 4, and the one the MCP SDK resolves
     * to, whose `ZodRawShapeCompat` types to v3's `ZodType`. The mismatch is types-only —
     * the SDK's zod-compat shim detects v4 at runtime by the `_zod` marker and takes the v4
     * branch. That claim is checked by calling every tool over the wire, not by trusting
     * this paragraph.
     */
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      config: { description: string; inputSchema: unknown },
      handler: (args: Record<string, unknown>) => unknown,
    ) => void

    for (const entry of toolsFor(transcripts, agent.domainTools)) {
      register(
        entry.name,
        { description: entry.description, inputSchema: entry.inputSchema },
        // The handler's second argument is MCP's request context; the tools ignore it.
        (args) => entry.handler(args as never, undefined),
      )
    }

    // `sessionIdGenerator: undefined` is the documented stateless mode.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (cause) {
      console.error('[mcp] request failed', cause)
      if (!res.headersSent) res.status(500).json({ error: (cause as Error).message })
    }
  })

  /**
   * The transport allows GET for a server-initiated event stream. Nothing here initiates
   * anything, so saying so is more useful than a hanging connection.
   */
  router.get('/:agent', (_req, res) => {
    res.status(405).json({ error: 'This MCP server does not push; POST a JSON-RPC request.' })
  })

  return router
}
