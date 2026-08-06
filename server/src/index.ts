import express from 'express'
import { answerQuestion } from './answer.js'
import { applyChangeset, markImplemented, rejectChangeset } from './commit.js'
import { chatRoutes } from './agent/routes.js'
import { AgentRunner } from './agent/runner.js'
import { TRANSCRIPTS_DB, TranscriptStore } from './transcripts.js'
import { CODER_URL, probeSandbox } from './sandbox.js'
import { SPECS_DIR, readChangesets, readQuestions, readTerms } from './store.js'

const PORT = Number(process.env.PORT ?? 5174)

const transcripts = new TranscriptStore()
const runner = new AgentRunner(transcripts)

const app = express()
app.use(express.json())
app.use('/api/chat', chatRoutes(transcripts, runner))

app.get('/api/terms', async (_req, res, next) => {
  try {
    res.json(await readTerms())
  } catch (error) {
    next(error)
  }
})

app.get('/api/changesets', async (_req, res, next) => {
  try {
    res.json(await readChangesets())
  } catch (error) {
    next(error)
  }
})

app.post('/api/changesets/:id/apply', async (req, res, next) => {
  try {
    const body = req.body as { opIndices?: unknown; acknowledgeWarnings?: unknown }
    if (!Array.isArray(body?.opIndices)) {
      res.status(400).json({ error: 'Expected { opIndices: number[] }.' })
      return
    }

    const outcome = await applyChangeset(req.params.id, {
      opIndices: body.opIndices as number[],
      acknowledgeWarnings: body.acknowledgeWarnings === true,
    })
    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

app.post('/api/changesets/:id/reject', async (req, res, next) => {
  try {
    const outcome = await rejectChangeset(req.params.id)
    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

app.post('/api/changesets/:id/implemented', async (req, res, next) => {
  try {
    const outcome = await markImplemented(req.params.id, new Date().toISOString())
    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

app.get('/api/sandbox', async (_req, res, next) => {
  try {
    res.json(await probeSandbox())
  } catch (error) {
    next(error)
  }
})

app.get('/api/questions', async (_req, res, next) => {
  try {
    res.json(await readQuestions())
  } catch (error) {
    next(error)
  }
})

app.post('/api/questions/:id/answer', async (req, res, next) => {
  try {
    const body = req.body as { chose?: unknown; note?: unknown }
    const chose = body?.chose === null || body?.chose === undefined ? null : body.chose
    if (chose !== null && typeof chose !== 'string') {
      res.status(400).json({ error: 'Expected { chose: string | null, note?: string }.' })
      return
    }

    const outcome = await answerQuestion(req.params.id, {
      chose,
      note: typeof body?.note === 'string' ? body.note : '',
      answeredAt: new Date().toISOString(),
    })
    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error)
  res.status(500).json({ error: error.message })
})

app.listen(PORT, () => {
  console.log(`[server] specs: ${SPECS_DIR}`)
  console.log(`[server] transcripts: ${TRANSCRIPTS_DB}`)
  const misconfigured = AgentRunner.misconfiguration
  console.log(
    misconfigured
      ? `[server] chat: ${misconfigured}`
      : AgentRunner.configured
        ? '[server] chat: agent ready'
        : '[server] chat: no credential — set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN and restart',
  )
  console.log(
    CODER_URL
      ? `[server] sandbox: ${CODER_URL} — GET /api/sandbox for whether it is actually up`
      : '[server] sandbox: none (CODER_URL unset) — @coder runs in-process, unsandboxed',
  )
  console.log(`[server] listening on http://localhost:${PORT}`)
})
