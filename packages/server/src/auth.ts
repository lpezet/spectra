/**
 * The authorization seam — who a request is, and what they may touch.
 *
 * Two things travel together, and both are policy the *server* decides, never the client:
 * the {@link Author} to stamp on any write the request makes (the same reason `@spec`'s and
 * `@coder`'s identities come from their routes, not their payloads), and a `can(org, project)`
 * gate for whether this principal may act on a given scope at all.
 *
 * Locally there is no account and nothing to lock: {@link LocalAuthorizer} is allow-all and
 * stamps a bare human. It exists now, before there are orgs or projects to gate, so the hook is
 * already in the request chain — a hosted deployment swaps in an {@link Authorizer} backed by
 * OAuth/SSO/SAML/API keys without the routes learning anything new. Until then `can` is never
 * consulted (nothing calls it yet) and `author` is exactly the `{ kind: 'human' }` the server
 * used to stamp from a boot-time constant.
 *
 * The seam is deliberately request-in, principal-out and total for the local case: `authenticate`
 * always yields a principal. A real implementation that wants to reject an unauthenticated caller
 * does it by returning a principal whose `can` is false (a 403 at the gate), keeping the
 * middleware that calls this free of auth-scheme specifics.
 */
import type { Request } from 'express'
import type { Author } from '@spectra/core'

/** A resolved caller: the identity to stamp, what it may reach, and what it may pick from. */
export interface Principal {
  /** The author stamped on writes this principal makes. Server-decided, never from the body. */
  readonly author: Author
  /** The orgs this principal may see — what the org picker offers. Local: the one configured org. */
  orgs(): string[]
  /** Whether this principal may act on a given org + project. Allow-all locally. */
  can(org: string, projectId: string): boolean
}

/** Resolves the {@link Principal} for a request from whatever the deployment authenticates with. */
export interface Authorizer {
  authenticate(req: Request): Principal
}

/**
 * The local, hosted-nothing implementation: every request is the one human at the keyboard, and
 * every scope is theirs. This is the honest model for a single-machine install — there is no one
 * else to be, and no project on this box they are not allowed to open.
 */
export class LocalAuthorizer implements Authorizer {
  private readonly principal: Principal

  /** `org` is the single org this install serves — the only one the picker will offer. */
  constructor(org: string) {
    this.principal = {
      author: { kind: 'human' },
      orgs: () => [org],
      can: () => true,
    }
  }

  authenticate(): Principal {
    return this.principal
  }
}
