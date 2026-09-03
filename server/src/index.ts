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
import type { Author } from '@tb/shared'
import { checkExpectation } from './expectationCheck.js'
import { publishExpectation, raiseExpectation, recheckExpectation, supersedeExpectation } from './expectations.js'
import type { RaiseExpectationRequest, SupersedeRequest } from './expectations.js'
import { SPECS_DIR } from './config.js'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import { defaultVoiceIds, listVoices, speechKey, speechModel, synthesize } from './speech.js'

const PORT = Number(process.env.PORT ?? 5174)

// The composition root: one store, constructed here and threaded into everything that reads or
// writes the glossary. A hosted deployment resolves this per tenant instead — same seam.
const store = new FileSystemSpecStore(SPECS_DIR)
const transcripts = new TranscriptStore()
const runner = new AgentRunner(store, transcripts)

// Every write over the HTTP API is a person acting in the browser. Stamped here, server-side —
// never taken from the request body — the same reason the agent's identity comes from its route.
// `user` fills in once there is auth; until then the actor kind is what we can honestly record.
const HUMAN: Author = { kind: 'human' }

/** The revision the client last read, if it sent one — the opt-in for optimistic concurrency. */
const expectedRevOf = (body: unknown): number | undefined => {
  const value = (body as { expectedRev?: unknown } | null)?.expectedRev
  return typeof value === 'number' ? value : undefined
}

const app = express()

// Before express.json(), and that ordering is load-bearing: the proxy forwards the request
// body untouched, and a JSON parser upstream of it would consume the stream first.
app.use('/anthropic', anthropicProxy())

app.use(express.json())
app.use('/api/chat', chatRoutes(transcripts, runner))
// Deliberately outside /api: this is not the UI's surface, it is the sandbox's. Reached
// over the internal docker network by an agent in another container.
app.use('/mcp', mcpRoutes(store, transcripts))

app.get('/api/terms', async (_req, res, next) => {
  try {
    res.json(await store.readTerms())
  } catch (error) {
    next(error)
  }
})

app.get('/api/changesets', async (_req, res, next) => {
  try {
    res.json(await store.readChangesets())
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

    const outcome = await applyChangeset(store, req.params.id, {
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
    const outcome = await rejectChangeset(store, req.params.id)
    res.status(outcome.ok ? 200 : outcome.status).json(outcome)
  } catch (error) {
    next(error)
  }
})

app.post('/api/changesets/:id/implemented', async (req, res, next) => {
  try {
    const outcome = await markImplemented(store, req.params.id, new Date().toISOString())
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
      specsVersion: (await currentSnapshot(store)).version,
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

/**
 * Which remote voices exist, if any — and never a verdict about whether to use one.
 *
 * `configured` is only "is there a key", not "does it work": finding that out costs a call to
 * the vendor, and a UI that cannot paint its voice picker until a third party answers is a UI
 * that hangs for a feature nobody switched on yet. The browser asks, and treats an empty list
 * exactly as it treats a machine with one system voice.
 */
app.get('/api/speech', async (_req, res, next) => {
  try {
    if (!speechKey()) {
      res.json({ configured: false, voices: [], defaults: {}, model: speechModel })
      return
    }
    const outcome = await listVoices()
    res.json({
      configured: true,
      model: speechModel,
      defaults: defaultVoiceIds(),
      voices: 'voices' in outcome ? outcome.voices : [],
      ...('error' in outcome ? { error: outcome.error } : {}),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * One utterance of audio.
 *
 * A failure comes back as JSON naming the shape of it, not as a bare status, because the
 * caller has a real decision to make and the two interesting cases look identical from the
 * outside: a spent quota should send the browser back to its local voice for good, while a
 * rate limit should cost it one sentence. 200 is audio; anything else is a reason.
 */
app.post('/api/speech', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    const voiceId = typeof req.body?.voiceId === 'string' ? req.body.voiceId : ''
    if (!text || !voiceId) {
      res.status(400).json({ error: 'Expected { text: string, voiceId: string }.' })
      return
    }

    const outcome = await synthesize(text, voiceId)
    if ('error' in outcome) {
      res.status(outcome.error.reason === 'no-credential' ? 501 : 502).json(outcome.error)
      return
    }

    res.setHeader('Content-Type', outcome.type)
    res.setHeader('Cache-Control', 'no-store')
    res.send(outcome.audio)
  } catch (error) {
    next(error)
  }
})

app.get('/api/expectations', async (_req, res, next) => {
  try {
    res.json(await store.readExpectations())
  } catch (error) {
    next(error)
  }
})

/**
 * Read a draft against the glossary without writing it.
 *
 * Nothing here touches disk, which is the point: a draft that turns out to contradict a spec
 * should be killable before it exists, not superseded afterwards. The mechanical findings
 * always come back; the semantic ones need a credential and say so when they are missing.
 */
app.post('/api/expectations/check', async (req, res, next) => {
  try {
    const body = req.body as Partial<RaiseExpectationRequest>
    if (typeof body?.expect !== 'string' || body.expect.trim() === '') {
      res.status(400).json({ error: 'Expected { expect: string }.' })
      return
    }

    const [{ terms }, { expectations }] = await Promise.all([store.readTerms(), store.readExpectations()])

    // A replacement is prefilled from the expectation it replaces, so comparing it against
    // that expectation reports a duplicate of the very thing being retired. Excluded rather
    // than tolerated: a finding everybody learns to ignore devalues the ones that matter.
    const superseding = (req.body as { superseding?: unknown }).superseding
    const against =
      typeof superseding === 'string'
        ? expectations.filter((entry) => entry.id !== superseding)
        : expectations

    res.json(
      await checkExpectation(
        {
          kind: body.kind === 'non-functional' ? 'non-functional' : 'functional',
          terms: Array.isArray(body.terms) ? body.terms : [],
          given: typeof body.given === 'string' ? body.given : '',
          expect: body.expect,
        },
        terms,
        against,
      ),
    )
  } catch (error) {
    next(error)
  }
})

/**
 * The write itself. The check above is a separate call rather than a step inside this one —
 * the UI gates on it, but a caller that has already decided is not made to pay for a model
 * round trip, and a check that could not run must not become a write that cannot happen.
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

    const outcome = await raiseExpectation(store, {
      kind: body.kind,
      terms: Array.isArray(body.terms) ? body.terms : [],
      given: typeof body.given === 'string' ? body.given : '',
      expect: body.expect,
      pass: typeof body.pass === 'string' && body.pass ? body.pass : 'usage',
      ...(typeof body.from === 'string' ? { from: body.from } : {}),
      ...(typeof body.file === 'string' ? { file: body.file } : {}),
      ...(Array.isArray(body.contested) ? { contested: body.contested } : {}),
      // A person may save a draft; anything else publishes. Agents never reach here.
      ...(body.status === 'draft' ? { status: 'draft' as const } : {}),
    }, HUMAN)

    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

/** Publish a draft expectation. draft → ready, and only then does it count. */
app.post('/api/expectations/:id/publish', async (req, res, next) => {
  try {
    const outcome = await publishExpectation(store, req.params.id, expectedRevOf(req.body))
    res.status(outcome.ok ? 200 : (outcome.status ?? 500)).json(outcome)
  } catch (error) {
    next(error)
  }
})

/**
 * Reads a live expectation against the specs as they are now.
 *
 * Answering a question rewrites term text, which can leave a `contested` marker quoting a
 * sentence that no longer exists — flagged for a reason nobody can check. This refreshes it:
 * a clash that has gone disappears, one that changed says what it clashes with now, and one
 * that survives keeps the expectation out of coverage exactly as before.
 */
app.post('/api/expectations/:id/recheck', async (req, res, next) => {
  try {
    const [{ terms }] = await Promise.all([store.readTerms()])
    const outcome = await recheckExpectation(store, req.params.id, async (expectation, others) => {
      const report = await checkExpectation(
        {
          kind: expectation.kind,
          terms: expectation.terms,
          given: expectation.given,
          expect: expectation.expect,
        },
        terms,
        others,
      )
      return report.findings
    }, expectedRevOf(req.body))

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

    const outcome = await supersedeExpectation(store, req.params.id, {
      note: body.note,
      ...(body.replacement ? { replacement: body.replacement } : {}),
    }, HUMAN, expectedRevOf(req.body))

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
    const [{ terms }, { expectations }] = await Promise.all([store.readTerms(), store.readExpectations()])
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
    res.json(await store.readQuestions())
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

    const outcome = await answerQuestion(store, req.params.id, {
      chose,
      note: typeof body?.note === 'string' ? body.note : '',
      answeredAt: new Date().toISOString(),
    }, HUMAN)
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
