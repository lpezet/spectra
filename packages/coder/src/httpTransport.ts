/**
 * The runtime as a standalone HTTP service the Server relays turns to.
 *
 * This is the original transport — an Express app the coordinator *reaches into*: `POST
 * /sessions/:id/turn` starts a turn, `GET /sessions/:id/stream` streams its events as SSE, and
 * `POST /approvals/:id` delivers a decision back. It works because the Server and this service sit
 * on the same network, so the Server can dial it. Each route is now a thin adapter over
 * {@link Engine} rather than owning the loop; the routes, status codes, and `/health` shape are
 * byte-identical to when they lived inline, so nothing that already talks to this service can tell
 * the difference.
 *
 * The other transport — a runtime that must dial *out* to a coordinator it cannot be reached from —
 * attaches to the same engine, which is the whole point of the split.
 */
import express from 'express'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import type { Engine } from './engine.js'

export interface HttpOptions {
  /** Names the busy message and the startup logs. */
  agent: string
  port: number
  /** @coder's mount — where the committed snapshot is read from for `/health`. */
  appDir: string
  /** The Server's per-project MCP endpoint, reported by `/health` and logged at boot. */
  glossaryUrl: string
}

/**
 * The specs version committed in the project, read from the file on this runtime's mount.
 *
 * This is why mark_implemented needs no version argument. An agent that supplied its own could
 * fetch a fresh one, never write it down, and pass the check on the second try. Only the process
 * holding the mount can say what is actually on disk, so it says it, and the spec tool asks rather
 * than being told.
 */
function snapshotVersion(appDir: string): string | null {
  try {
    const raw = readFileSync(path.join(appDir, 'specs.snapshot.json'), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

export function serveHttp(engine: Engine, opts: HttpOptions): Server {
  const app = express()
  app.use(express.json({ limit: '4mb' }))

  app.get('/health', async (_req, res) => {
    let tools: string[] | null = null
    let glossaryError: string | null = null
    try {
      tools = (await engine.profile()).tools
    } catch (cause) {
      glossaryError = (cause as Error).message
    }

    res.json({
      ok: true,
      appDir: opts.appDir,
      glossary: opts.glossaryUrl,
      // Read from the mount on every request, never cached — a cached copy would survive the
      // file being reverted underneath it, which is precisely the case this exists to catch.
      snapshotVersion: snapshotVersion(opts.appDir),
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
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
    if (!prompt) {
      res.status(400).json({ ok: false, error: 'Expected { prompt: string }.' })
      return
    }

    const unattended = req.body?.unattended === true
    const result = engine.submitTurn(req.params.id, prompt, unattended)
    if (!result.ok) {
      res.status(409).json(result)
      return
    }
    res.status(202).json({ ok: true })
  })

  app.post('/approvals/:approvalId', (req, res) => {
    const result = engine.submitDecision(
      req.params.approvalId,
      req.body?.decision === 'allow' ? 'allow' : 'deny',
      typeof req.body?.note === 'string' ? req.body.note : null,
    )
    if (!result.ok) {
      res.status(409).json(result)
      return
    }
    res.json({ ok: true })
  })

  app.get('/sessions/:id/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const unsubscribe = engine.subscribe(req.params.id, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`))
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
    req.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  })

  return app.listen(opts.port, () => {
    console.log(`[${opts.agent}] cwd: ${opts.appDir}`)
    console.log(`[${opts.agent}] glossary: ${opts.glossaryUrl} (tools, not a mount)`)
    console.log(`[${opts.agent}] listening on http://0.0.0.0:${opts.port}`)
  })
}
