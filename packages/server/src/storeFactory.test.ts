/**
 * The backend choice: `resolveStoreChoice` is pure (env in, a choice out) so every branch is tested
 * here without touching disk, and `buildSpecStore` is checked to construct the right class. The
 * default is the filesystem store — nothing changes for an existing install unless SPEC_STORE says so.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import { SqlSpecStore } from './sqlSpecStore.js'
import { buildSpecStore, resolveStoreChoice } from './storeFactory.js'

const SPECS = '/data/examples/todo/specs'
const DATA = '/data/.dev/data'

describe('resolveStoreChoice', () => {
  it('defaults to the filesystem backend, splitting SPECS_DIR into (root, projectId)', () => {
    expect(resolveStoreChoice({}, SPECS, DATA)).toEqual({
      backend: 'fs',
      specsRoot: '/data/examples',
      projectId: 'todo',
      dbPath: path.join(DATA, 'spec.db'),
    })
  })

  it('selects the SQL backend on SPEC_STORE=sql', () => {
    expect(resolveStoreChoice({ SPEC_STORE: 'sql' }, SPECS, DATA).backend).toBe('sql')
  })

  it('honours PROJECT_ID and SPEC_DB overrides', () => {
    const choice = resolveStoreChoice({ PROJECT_ID: 'acme', SPEC_DB: '/tmp/x.db' }, SPECS, DATA)
    expect(choice.projectId).toBe('acme')
    expect(choice.dbPath).toBe('/tmp/x.db')
  })

  it('treats any non-sql value as fs', () => {
    expect(resolveStoreChoice({ SPEC_STORE: 'nonsense' }, SPECS, DATA).backend).toBe('fs')
  })
})

describe('buildSpecStore', () => {
  it('builds a FileSystemSpecStore for fs', () => {
    const store = buildSpecStore({ backend: 'fs', specsRoot: '/tmp/root', projectId: 'p', dbPath: ':memory:' })
    expect(store).toBeInstanceOf(FileSystemSpecStore)
  })

  it('builds a SqlSpecStore for sql', () => {
    const store = buildSpecStore({ backend: 'sql', specsRoot: '/tmp/root', projectId: 'p', dbPath: ':memory:' })
    expect(store).toBeInstanceOf(SqlSpecStore)
  })
})
