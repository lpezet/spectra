/**
 * The local authorizer is the honest single-machine model: one human, every scope theirs. These
 * pin the two guarantees the rest of the server leans on — it stamps a bare human (exactly what
 * the write path used to hardcode), and `can` never refuses — so a later hosted implementation
 * that changes either is a deliberate, visible break.
 */
import { describe, expect, it } from 'vitest'
import { LocalAuthorizer } from './auth.js'

describe('LocalAuthorizer', () => {
  const authorizer = new LocalAuthorizer()

  it('stamps a bare human, with no account', () => {
    const principal = authorizer.authenticate()
    expect(principal.author).toEqual({ kind: 'human' })
    expect(principal.author.user).toBeUndefined()
  })

  it('allows every org and project', () => {
    const principal = authorizer.authenticate()
    expect(principal.can('any-org', 'any-project')).toBe(true)
    expect(principal.can('', '')).toBe(true)
  })
})
