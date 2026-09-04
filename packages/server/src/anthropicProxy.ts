/**
 * The model API, relayed on behalf of the sandbox.
 *
 * `@coder`'s container has no route out. It still needs to talk to the model, and this is
 * the only thing it can reach — so the agent SDK in there is pointed at this path with
 * `ANTHROPIC_BASE_URL`, and express makes the outbound call.
 *
 * That the override works is measured, not assumed: pointed at a local server, the SDK's
 * first outbound call (`HEAD /api/hello`) landed on it. Without that, none of this would be
 * anything but a hope.
 *
 * Two things follow that are worth more than the plumbing:
 *
 * The credential never enters the sandbox. Whatever the container sends as `x-api-key` or
 * `authorization` is dropped on the floor and replaced with what express holds. A container
 * that gets compromised cannot spend your quota anywhere except through this process, and
 * cannot read the token it is spending.
 *
 * Every model call for `@coder` now passes through code you own. Nothing here does anything
 * with that yet — no counting, no limits, no logging of prompts. It is where those would go.
 */
import { Router, raw } from 'express'
import { Readable } from 'node:stream'

const UPSTREAM = process.env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com'

/**
 * Headers that describe *this* hop and must not be forwarded. `content-length` goes because
 * the body is re-sent; `accept-encoding` goes because fetch decompresses for us and a
 * forwarded `content-encoding` would then describe a body that is no longer encoded.
 */
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  // Replaced below, never forwarded — the whole point of the exercise.
  'x-api-key',
  'authorization',
])

const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
])

/**
 * Express holds one of two credential forms and they are not interchangeable: a console key
 * goes in `x-api-key`, a `claude setup-token` token in `authorization: Bearer`. The sandbox
 * cannot know which it is talking to, and does not need to.
 */
function credential(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey) return { 'x-api-key': apiKey }

  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (oauth) return { authorization: `Bearer ${oauth}` }

  return {}
}

export function anthropicProxy(): Router {
  const router = Router()

  // Every content type, unparsed. This must be mounted before the app's express.json(),
  // which would otherwise consume the body and leave nothing to forward.
  router.use(raw({ type: () => true, limit: '32mb' }))

  router.all('*', async (req, res) => {
    const target = new URL(req.originalUrl.replace(/^\/anthropic/, ''), UPSTREAM)

    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (DROP_REQUEST.has(name.toLowerCase()) || value === undefined) continue
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    for (const [name, value] of Object.entries(credential())) headers.set(name, value)

    const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined

    try {
      const upstream = await fetch(target, { method: req.method, headers, body })

      res.status(upstream.status)
      upstream.headers.forEach((value, name) => {
        if (!DROP_RESPONSE.has(name.toLowerCase())) res.setHeader(name, value)
      })

      if (!upstream.body) {
        res.end()
        return
      }

      // Piped, not buffered: responses are server-sent events and the agent on the other
      // side is streaming them to a human. Buffering here would turn a live reply into a
      // long pause followed by a wall of text.
      Readable.fromWeb(upstream.body as never).pipe(res)
    } catch (cause) {
      console.error('[proxy] upstream failed', cause)
      if (!res.headersSent) {
        res.status(502).json({ error: `Could not reach the model API: ${(cause as Error).message}` })
      }
    }
  })

  return router
}
