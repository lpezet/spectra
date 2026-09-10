/**
 * Chat endpoints. The stream is SSE rather than WebSocket because the traffic is one
 * direction — the browser posts a message over plain HTTP and listens for the answer —
 * and SSE reconnects on its own.
 *
 * Every stream starts by replaying from a cursor, so a dropped connection, a page reload
 * or a tab closed mid-answer all recover the same way: ask for everything after the last
 * id you saw.
 */
import express from 'express'
import { AGENT_NAMES } from './agents.js'
import type { AgentDefinition, AgentName } from './agents.js'
import { AgentRunner } from './runner.js'
import type { Session, TranscriptStore } from '@abseed/spectra-core'
import type { Principal } from '../auth.js'

export function chatRoutes(
  transcripts: TranscriptStore,
  runner: AgentRunner,
  agents: Record<AgentName, AgentDefinition>,
): express.Router {
  const router = express.Router()

  // The project comes from the mount below the glossary prefix, set on res.locals by its middleware.
  const projectOf = (res: express.Response): string => res.locals.projectId as string

  // The acting user, for per-user session ownership. `undefined` on a single-user install (the local
  // authorizer stamps no user), which lists every session and owns new ones as null; a hosted
  // authorizer resolves a real id, so each user sees and creates only their own conversations.
  const ownerOf = (res: express.Response): string | undefined => (res.locals.principal as Principal | undefined)?.author.user

  // A session reached under a different project's prefix is treated as absent: isolation enforced at
  // the edge, so a session id learned from one project cannot be read or mutated through another.
  const owned = (res: express.Response, session: Session | null): session is Session =>
    session !== null && session.projectId === projectOf(res)

  router.get('/agents', (_req, res) => {
    res.json({
      agents: AGENT_NAMES.map((name) => ({
        name,
        label: agents[name].label,
        description: agents[name].description,
      })),
    })
  })

  router.get('/status', (_req, res) => {
    const problem = AgentRunner.misconfiguration
    res.json({
      configured: AgentRunner.configured && !problem,
      ...(problem ? { problem } : {}),
    })
  })

  router.get('/sessions', async (_req, res) => {
    res.json({ sessions: await transcripts.listSessions(projectOf(res), ownerOf(res)) })
  })

  router.post('/sessions', async (req, res) => {
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'New conversation'
    const session = await transcripts.createSession(runner.newSessionId(), projectOf(res), ownerOf(res) ?? null, title, new Date().toISOString())
    res.status(201).json({ session })
  })

  /**
   * Whether @coder may work without an approval card in this conversation.
   *
   * A POST rather than a client-side preference, because the answer depends on something
   * only this side knows: whether there is a sandbox and whether it is up. Enabling can be
   * refused; disabling never is.
   */
  router.post('/sessions/:id/unattended', async (req, res) => {
    const outcome = await runner.setUnattended(req.params.id, req.body?.enabled === true)
    res.status(outcome.ok ? 200 : 409).json({
      ...outcome,
      unattended: runner.isUnattended(req.params.id),
    })
  })

  router.delete('/sessions/:id', async (req, res) => {
    if (!owned(res, await transcripts.getSession(req.params.id))) {
      res.status(404).json({ error: `No conversation with id "${req.params.id}".` })
      return
    }
    await transcripts.deleteSession(req.params.id)
    res.json({ ok: true })
  })

  router.get('/sessions/:id/events', async (req, res) => {
    const session = await transcripts.getSession(req.params.id)
    if (!owned(res, session)) {
      res.status(404).json({ error: `No conversation with id "${req.params.id}".` })
      return
    }

    const after = Number(req.query.after ?? 0)
    res.json({
      session,
      events: await transcripts.read(req.params.id, Number.isFinite(after) ? after : 0),
      running: runner.isRunning(req.params.id),
      // In memory on the server, so the browser has to be told rather than remembering —
      // and a restart correctly shows it back off.
      unattended: runner.isUnattended(req.params.id),
    })
  })

  router.post('/sessions/:id/messages', async (req, res) => {
    const session = await transcripts.getSession(req.params.id)
    if (!owned(res, session)) {
      res.status(404).json({ error: `No conversation with id "${req.params.id}".` })
      return
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    if (!text) {
      res.status(400).json({ error: 'Expected { text: string }.' })
      return
    }

    // First real message names the conversation, so the session list is readable.
    if (session.title === 'New conversation') {
      await transcripts.renameSession(session.id, text.slice(0, 72), new Date().toISOString())
    }

    // Null addressee is a message to the channel that nobody acts on — recorded, not run.
    const requested = typeof req.body?.to === 'string' ? req.body.to : null
    if (requested !== null && !AGENT_NAMES.includes(requested as AgentName)) {
      res.status(400).json({ error: `No agent called "${requested}".` })
      return
    }

    const outcome = await runner.send(session.id, text, requested as AgentName | null)
    res.status(outcome.ok ? 202 : 409).json(outcome)
  })

  // Async because the run may be blocked in the sandbox rather than in this process, in
  // which case deciding means an HTTP call to it. The card looks the same either way.
  router.post('/sessions/:id/approvals/:approvalId', async (req, res) => {
    const allow = req.body?.decision === 'allow'
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : null

    if (!(await runner.decide(req.params.approvalId, allow, note))) {
      res.status(409).json({
        ok: false,
        error:
          'Nothing is waiting on that any more — the run ended, the server restarted, or the sandbox could not be told.',
      })
      return
    }

    res.json({ ok: true })
  })

  router.get('/sessions/:id/stream', async (req, res) => {
    const sessionId = req.params.id
    if (!owned(res, await transcripts.getSession(sessionId))) {
      res.status(404).json({ error: `No conversation with id "${sessionId}".` })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Vite's dev proxy will otherwise buffer the stream and nothing appears until it ends.
      'X-Accel-Buffering': 'no',
    })

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const requested = Number(req.query.after ?? 0)
    let cursor = Number.isFinite(requested) ? requested : 0

    // Transcript reads are async now, so the lookups an emitter event triggers can overlap — and
    // they all advance the shared `cursor`, so overlap would double-send or reorder rows. A
    // one-at-a-time queue serializes every read-and-send in emit order, restoring the ordering the
    // synchronous version got for free.
    let queue: Promise<void> = Promise.resolve()
    const serialize = (task: () => Promise<void>): void => {
      queue = queue.then(task).catch((cause) => console.error('[chat] stream task failed', cause))
    }

    const flush = async () => {
      const pending = await transcripts.read(sessionId, cursor)
      for (const event of pending) {
        cursor = Math.max(cursor, event.id)
        send('append', event)
      }
    }

    const emitter = runner.events(sessionId)
    const onEvent = (event: { kind: string; text?: string; toolCallId?: string; approvalId?: string }) => {
      serialize(async () => {
        if (event.kind === 'delta') {
          send('delta', { text: event.text ?? '' })
        } else if (event.kind === 'append') {
          await flush()
        } else if (event.kind === 'approval' && event.approvalId) {
          // A settled approval mutates a row the cursor has already passed.
          const settled = await transcripts.readApproval(event.approvalId)
          if (settled) send('update', settled)
        } else if (event.kind === 'update' && event.toolCallId) {
          // Settling mutates a row the cursor has already passed, so fetch it by id and
          // re-send it rather than expecting the cursor read to surface it again.
          const settled = await transcripts.readToolCall(event.toolCallId)
          if (settled) send('update', settled)
        } else if (event.kind === 'done') {
          send('done', { cursor })
        }
      })
    }
    // Attach before the initial replay so a row appended during that first async read still gets its
    // nudge — it queues behind the replay as an 'append' rather than being lost in the gap.
    emitter.on('event', onEvent)
    serialize(async () => {
      await flush()
      send('ready', { cursor, running: runner.isRunning(sessionId) })
    })

    // Proxies drop idle connections; a comment line keeps it warm without reaching the client.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)

    req.on('close', () => {
      clearInterval(keepAlive)
      emitter.off('event', onEvent)
    })
  })

  return router
}
