/**
 * The backend boundary: built-ins resolve to the filesystem/SQLite provider; any other SPEC_STORE
 * value is a module the server does not ship, imported and asked for a backend. These pin the plugin
 * contract — the factory is called with the context, its backend is returned, and a malformed module
 * fails loudly (a clear error, not a later `undefined is not a function`).
 */
import { describe, expect, it } from 'vitest'
import { resolveBackend } from './backend.js'

const SPECS = '/data/acme/specs' // <root>/<projectId>/specs -> projectId "acme"
const DATA = '/data/.dev/data'
const fixture = new URL('./backend.fixture.ts', import.meta.url).href
const noFactory = new URL('./sqlSpecStore.js', import.meta.url).href // a real module with no factory export

describe('resolveBackend — built-ins', () => {
  it('defaults to the filesystem provider, with the configured default project', async () => {
    const backend = await resolveBackend({}, SPECS, DATA)
    expect(backend.defaultProjectId).toBe('acme')
    expect(typeof backend.storeFor).toBe('function')
    expect(typeof backend.listProjects).toBe('function')
  })

  it('honours SPEC_STORE=sql and PROJECT_ID', async () => {
    const backend = await resolveBackend({ SPEC_STORE: 'sql', PROJECT_ID: 'billing', SPEC_DB: ':memory:' }, SPECS, DATA)
    expect(backend.defaultProjectId).toBe('billing')
  })
})

describe('resolveBackend — plugin module', () => {
  it('loads the module and hands its factory the context (env, defaultProjectId, dataDir)', async () => {
    const backend = await resolveBackend({ SPEC_STORE: fixture, PROJECT_ID: 'plugged', MY_PLUGIN_OPT: 'xyz' }, SPECS, DATA)
    expect(backend.defaultProjectId).toBe('plugged')
    // The fixture echoes the context back through listProjects.
    const [project] = await backend.listProjects()
    expect(project).toEqual({ id: 'from-plugin', name: 'opt:xyz', domain: DATA })
    // And its store factory is the plugin's, not a built-in.
    expect(backend.storeFor('p')).toEqual({ __fixtureProjectId: 'p' })
  })

  it('falls back to the SPECS_DIR basename for the default project when PROJECT_ID is unset', async () => {
    const backend = await resolveBackend({ SPEC_STORE: fixture }, SPECS, DATA)
    expect(backend.defaultProjectId).toBe('acme')
  })

  it('fails clearly when the module cannot be imported', async () => {
    await expect(resolveBackend({ SPEC_STORE: '/no/such/backend/module.js' }, SPECS, DATA)).rejects.toThrow(
      /could not be imported/,
    )
  })

  it('fails clearly when the module exports no factory', async () => {
    await expect(resolveBackend({ SPEC_STORE: noFactory }, SPECS, DATA)).rejects.toThrow(/must export createSpecStoreBackend/)
  })
})
