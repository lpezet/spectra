/**
 * The provider is a cache with a backend template: same projectId hands back the same instance
 * (a store is a connection, reused), different projectId a different one, and the default projectId
 * is the one the template carries. These pin the caching contract the request chain relies on —
 * one SQL handle per project, not per request — without needing a real request.
 */
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
