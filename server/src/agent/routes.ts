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
import { AGENTS, AGENT_NAMES } from './agents.js'
import type { AgentName } from './agents.js'
import { AgentRunner } from './runner.js'
import type { TranscriptStore } from '../transcripts.js'

export function chatRoutes(transcripts: TranscriptStore, runner: AgentRunner): express.Router {
  const router = express.Router()

  router.get('/agents', (_req, res) => {
    res.json({
      agents: AGENT_NAMES.map((name) => ({
        name,
        label: AGENTS[name].label,
        description: AGENTS[name].description,
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

  router.get('/sessions', (_req, res) => {
    res.json({ sessions: transcripts.listSessions() })
  })

  router.post('/sessions', (req, res) => {
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'New conversation'
    const session = transcripts.createSession(runner.newSessionId(), title, new Date().toISOString())
    res.status(201).json({ session })
  })

  router.delete('/sessions/:id', (req, res) => {
    transcripts.deleteSession(req.params.id)
    res.json({ ok: true })
  })

  router.get('/sessions/:id/events', (req, res) => {
    const session = transcripts.getSession(req.params.id)
    if (!session) {
      res.status(404).json({ error: `No conversation with id "${req.params.id}".` })
      return
    }

    const after = Number(req.query.after ?? 0)
    res.json({
      session,
      events: transcripts.read(req.params.id, Number.isFinite(after) ? after : 0),
      running: runner.isRunning(req.params.id),
    })
  })

  router.post('/sessions/:id/messages', (req, res) => {
    const session = transcripts.getSession(req.params.id)
    if (!session) {
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
      transcripts.renameSession(session.id, text.slice(0, 72), new Date().toISOString())
    }

    // Null addressee is a message to the channel that nobody acts on — recorded, not run.
    const requested = typeof req.body?.to === 'string' ? req.body.to : null
    if (requested !== null && !AGENT_NAMES.includes(requested as AgentName)) {
      res.status(400).json({ error: `No agent called "${requested}".` })
      return
    }

    const outcome = runner.send(session.id, text, requested as AgentName | null)
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

  router.get('/sessions/:id/stream', (req, res) => {
    const sessionId = req.params.id
    if (!transcripts.getSession(sessionId)) {
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

    const flush = () => {
      const pending = transcripts.read(sessionId, cursor)
      for (const event of pending) {
        cursor = Math.max(cursor, event.id)
        send('append', event)
      }
    }

    flush()
    send('ready', { cursor, running: runner.isRunning(sessionId) })

    const emitter = runner.events(sessionId)
    const onEvent = (event: { kind: string; text?: string; toolCallId?: string; approvalId?: string }) => {
      if (event.kind === 'delta') {
        send('delta', { text: event.text ?? '' })
      } else if (event.kind === 'append') {
        flush()
      } else if (event.kind === 'approval' && event.approvalId) {
        // A settled approval mutates a row the cursor has already passed.
        const settled = transcripts.readApproval(event.approvalId)
        if (settled) send('update', settled)
      } else if (event.kind === 'update' && event.toolCallId) {
        // Settling mutates a row the cursor has already passed, so fetch it by id and
        // re-send it rather than expecting the cursor read to surface it again.
        const settled = transcripts.readToolCall(event.toolCallId)
        if (settled) send('update', settled)
      } else if (event.kind === 'done') {
        send('done', { cursor })
      }
    }
    emitter.on('event', onEvent)

    // Proxies drop idle connections; a comment line keeps it warm without reaching the client.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)

    req.on('close', () => {
      clearInterval(keepAlive)
      emitter.off('event', onEvent)
    })
  })

  return router
}
