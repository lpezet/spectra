/** A stand-in authorizer plugin for resolveAuthorizer's test — loaded by specifier. */
import type { Authorizer, AuthorizerContext, Principal } from './auth.js'

export function createAuthorizer(context: AuthorizerContext): Authorizer {
  const principal: Principal = {
    author: { kind: 'human', user: 'plugin-user' },
    orgs: () => [`from-plugin:${context.org}`],
    can: () => true,
  }
  return { authenticate: () => principal }
}
