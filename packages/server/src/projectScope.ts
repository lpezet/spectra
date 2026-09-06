/**
 * The per-request project gate, shared by every surface that is about one project: the glossary
 * routes and the MCP surface the sandbox reaches. Given a mount path carrying `:org`/`:projectId`,
 * it validates the ids, asks the principal whether it may act on them, and resolves the store —
 * landing projectId and store on res.locals for the handlers under it.
 *
 * One module so the two mounts cannot drift: the same validation (a crafted projectId reaches the
 * filesystem backend as a path component, so it must not escape the root) and the same auth call
 * site guard both the UI's writes and the agent's tool calls.
 */
import type { RequestHandler } from 'express'
import type { StoreProvider } from './storeProvider.js'
import type { Principal } from './auth.js'

const SEGMENT = /^[A-Za-z0-9._-]+$/

/** A URL segment safe to use as an org or project id — no traversal, no path separators. */
export const isSafeSegment = (value: string): boolean =>
  SEGMENT.test(value) && value !== '.' && value !== '..'

/** Middleware for a mount under `/…/orgs/:org/projects/:projectId`: validate, authorize, resolve. */
export function projectScope(provider: StoreProvider): RequestHandler {
  return (req, res, next) => {
    const { org, projectId } = req.params as { org?: string; projectId?: string }
    if (!org || !projectId || !isSafeSegment(org) || !isSafeSegment(projectId)) {
      res.status(400).json({ error: 'Invalid org or project id.' })
      return
    }
    const principal = res.locals.principal as Principal
    if (!principal.can(org, projectId)) {
      res.status(403).json({ error: `Not authorized for project "${projectId}".` })
      return
    }
    res.locals.projectId = projectId
    res.locals.store = provider.storeFor(projectId)
    next()
  }
}
