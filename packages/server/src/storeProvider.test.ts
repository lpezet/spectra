/**
 * The provider is a cache with a backend template: same projectId hands back the same instance
 * (a store is a connection, reused), different projectId a different one, and the default projectId
 * is the one the template carries. These pin the caching contract the request chain relies on —
 * one SQL handle per project, not per request — without needing a real request.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import { SqlSpecStore } from './sqlSpecStore.js'
import { StoreProvider } from './storeProvider.js'
import type { StoreChoice } from './storeFactory.js'

const fsTemplate: StoreChoice = {
  backend: 'fs',
  specsRoot: '/tmp/root',
  projectId: 'todo',
  dbPath: ':memory:',
}

describe('StoreProvider', () => {
  it('exposes the template projectId as the default', () => {
    expect(new StoreProvider(fsTemplate).defaultProjectId).toBe('todo')
  })

  it('caches: the same projectId yields the very same store instance', () => {
    const provider = new StoreProvider(fsTemplate)
    expect(provider.storeFor('todo')).toBe(provider.storeFor('todo'))
  })

  it('builds a distinct store per projectId', () => {
    const provider = new StoreProvider(fsTemplate)
    expect(provider.storeFor('todo')).not.toBe(provider.storeFor('acme'))
  })

  it('builds the backend the template names', () => {
    expect(new StoreProvider(fsTemplate).storeFor('p')).toBeInstanceOf(FileSystemSpecStore)
    expect(new StoreProvider({ ...fsTemplate, backend: 'sql' }).storeFor('p')).toBeInstanceOf(SqlSpecStore)
  })
})

describe('StoreProvider.listProjects', () => {
  it('lists the filesystem projects (dirs with a specs/), with their identity', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'spectra-catalog-'))
    for (const [id, info] of [
      ['alpha', { name: 'Alpha', domain: 'the alpha domain' }],
      ['beta', { name: 'Beta', domain: 'b' }],
    ] as const) {
      mkdirSync(path.join(root, id, 'specs'), { recursive: true })
      writeFileSync(path.join(root, id, 'specs', 'project.json'), JSON.stringify(info))
    }
    // A stray non-project dir (no specs/) must not appear.
    mkdirSync(path.join(root, 'not-a-project'), { recursive: true })

    const projects = await new StoreProvider({ ...fsTemplate, specsRoot: root }).listProjects()
    expect(projects).toEqual([
      { id: 'alpha', name: 'Alpha', domain: 'the alpha domain' },
      { id: 'beta', name: 'Beta', domain: 'b' },
    ])
  })

  it('lists the SQL projects registered in the database', async () => {
    const db = path.join(mkdtempSync(path.join(os.tmpdir(), 'spectra-catalog-')), 'spec.db')
    // Building a store registers its project (neutral identity) — two projects, one DB.
    new SqlSpecStore(db, 'alpha')
    new SqlSpecStore(db, 'beta')

    const ids = (await new StoreProvider({ ...fsTemplate, backend: 'sql', dbPath: db }).listProjects()).map((p) => p.id)
    expect(ids).toEqual(['alpha', 'beta'])
  })

  it('is empty for a root that does not exist yet', async () => {
    const projects = await new StoreProvider({ ...fsTemplate, specsRoot: '/no/such/root' }).listProjects()
    expect(projects).toEqual([])
  })
})
