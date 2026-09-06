/**
 * The local authorizer is the honest single-machine model: one human, every scope theirs. These
 * pin the two guarantees the rest of the server leans on — it stamps a bare human (exactly what
 * the write path used to hardcode), and `can` never refuses — so a later hosted implementation
 * that changes either is a deliberate, visible break.
 */
import { describe, expect, it } from 'vitest'
import { LocalAuthorizer, resolveAuthorizer } from './auth.js'

describe('LocalAuthorizer', () => {
  const authorizer = new LocalAuthorizer('local')

  it('stamps a bare human, with no account', () => {
    const principal = authorizer.authenticate()
    expect(principal.author).toEqual({ kind: 'human' })
    expect(principal.author.user).toBeUndefined()
  })

  it('offers the one configured org', () => {
    expect(authorizer.authenticate().orgs()).toEqual(['local'])
  })

  it('allows every org and project', () => {
    const principal = authorizer.authenticate()
    expect(principal.can('any-org', 'any-project')).toBe(true)
    expect(principal.can('', '')).toBe(true)
  })
})

describe('resolveAuthorizer', () => {
  const fixture = new URL('./authorizer.fixture.ts', import.meta.url).href

  it('defaults to the local authorizer, offering the configured org', async () => {
    const authorizer = await resolveAuthorizer({}, 'acme')
    expect(authorizer).toBeInstanceOf(LocalAuthorizer)
    expect(authorizer.authenticate({} as never).orgs()).toEqual(['acme'])
  })

  it('loads a plugin authorizer and hands it the context', async () => {
    const authorizer = await resolveAuthorizer({ AUTHORIZER: fixture }, 'acme')
    expect(authorizer).not.toBeInstanceOf(LocalAuthorizer)
    expect(authorizer.authenticate({} as never).orgs()).toEqual(['from-plugin:acme'])
  })

  it('fails clearly when the module cannot be imported', async () => {
    await expect(resolveAuthorizer({ AUTHORIZER: '/no/such/auth.js' }, 'x')).rejects.toThrow(/could not be imported/)
  })
})
