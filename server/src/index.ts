import express from 'express'
import { anthropicProxy } from './anthropicProxy.js'
import { answerQuestion } from './answer.js'
import { applyChangeset, markImplemented, rejectChangeset } from './commit.js'
import { chatRoutes } from './agent/routes.js'
import { mcpRoutes } from './agent/mcpHttp.js'
import { AgentRunner } from './agent/runner.js'
import { TRANSCRIPTS_DB, TranscriptStore } from './transcripts.js'
import { CODER_URL, probeSandbox } from './sandbox.js'
import { currentSnapshot, deployedVersion, lastExport } from './specsExport.js'
import { computeCoverage } from '@tb/shared'
import { raiseExpectation, supersedeExpectation } from './expectations.js'
import type { RaiseExpectationRequest, SupersedeRequest } from './expectations.js'
import { SPECS_DIR, readChangesets, readExpectations, readQuestions, readTerms } from './store.js'

const PORT = Number(process.env.PORT ?? 5174)

const transcripts = new TranscriptStore()
const runner = new AgentRunner(transcripts)

const app = express()

// Before express.json(), and that ordering is load-bearing: the proxy forwards the request
// body untouched, and a JSON parser upstream of it would consume the stream first.
app.use('/anthropic', anthropicProxy())

app.use(express.json())
app.use('/api/chat', chatRoutes(transcripts, runner))
// Deliberately outside /api: this is not the UI's surface, it is the sandbox's. Reached
// over the internal docker network by an agent in another container.
app.use('/mcp', mcpRoutes(transcripts))

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

/**
 * The two versions, reported side by side. No verdict.
 *
 * `specsVersion` is what specs/ is at now; `snapshotVersion` is what the copy committed in
 * app/ is at, read from the artifact — directly when @coder runs here, or from the sandbox
 * reporting its own mount when it does not. Whoever needs to act compares them, the way you
 * would read `git status`.
 *
 * `lastExport` is a timestamp and nothing more. It records that the tool was called, which
 * is not the same as the file being written — the write still has to pass the approval card
 * — so it is here to answer "how long ago?" and never to decide anything.
 */
app.get('/api/specs/version', async (_req, res, next) => {
  try {
    res.json({
      specsVersion: (await currentSnapshot()).version,
      snapshotVersion: await deployedVersion(),
      lastExport: lastExport(),
    })
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

app.get('/api/expectations', async (_req, res, next) => {
  try {
    res.json(await readExpectations())
  } catch (error) {
    next(error)
  }
})

/**
 * Adding goes straight in, with no review step — see `expectations.ts` for why that is safe
 * and why superseding is not.
 */
app.post('/api/expectations', async (req, res, next) => {
  try {
    const body = req.body as Partial<RaiseExpectationRequest>
    if (body?.kind !== 'functional' && body?.kind !== 'non-functional') {
      res.status(400).json({ error: 'Expected { kind: "functional" | "non-functional" }.' })
      return
    }
    if (typeof body.expect !== 'string' || body.expect.trim() === '') {
      res.status(400).json({ error: 'Expected { expect: string }.' })
      return
    }

    const outcome = await raiseExpectation({
      kind: body.kind,
      terms: Array.isArray(body.terms) ? body.terms : [],
      given: typeof body.given === 'string' ? body.given : '',
      expect: body.expect,
      pass: typeof body.pass === 'string' && body.pass ? body.pass : 'usage',
      ...(typeof body.from === 'string' ? { from: body.from } : {}),
      ...(typeof body.file === 'string' ? { file: body.file } : {}),
    })

    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

app.post('/api/expectations/:id/supersede', async (req, res, next) => {
  try {
    const body = req.body as Partial<SupersedeRequest>
    if (typeof body?.note !== 'string' || body.note.trim() === '') {
      res.status(400).json({ error: 'Expected { note: string } saying why this no longer applies.' })
      return
    }

    const outcome = await supersedeExpectation(req.params.id, {
      note: body.note,
      ...(body.replacement ? { replacement: body.replacement } : {}),
    })

    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

/**
 * Which pairs of entity and action nobody has said anything about.
 *
 * Counts and lists, never a score — the same reason `/api/specs/version` reports two numbers
 * and offers no verdict. Expectations per term measure attention, not correctness, and a
 * percentage would invite reading them as the second thing.
 */
app.get('/api/coverage', async (req, res, next) => {
  try {
    const [{ terms }, { expectations }] = await Promise.all([readTerms(), readExpectations()])
    const distance = Number(req.query.distance ?? 2)
    res.json(
      computeCoverage(terms, expectations, {
        maxDistance: Number.isFinite(distance) ? Math.max(1, Math.min(4, distance)) : 2,
      }),
    )
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
