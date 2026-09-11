/**
 * `applyChangeset` optimistic concurrency (GH #93): the `expectedVersion` staleness surface and the
 * mapping of a store's compare-and-swap conflict onto a `staleVersion` 409. Uses a minimal stub store
 * — `applyChangeset` only touches `readTerms`, `findChangeset`, and `commitApplication` — so the logic
 * is tested without a filesystem or SQL backend.
 */
import { describe, expect, it } from 'vitest'
import { applyChangeset } from './commit.js'
import { glossaryVersion } from './version.js'
import type { Changeset, Op, Term } from './types.js'
import type { CommitApplication, CommitConflict, CommitResult, Glossary, SpecStore } from './specStore.js'

const addWidget: Op = { op: 'add_entity', term: 'Widget', spec: 'A widget.' }
const pending: Changeset = { id: 'chat-001', summary: 'add Widget', ops: [addWidget], tests: [] }
const someTerm: Term = { name: 'Other', type: 'entity', spec: 'x', parent: null, tags: [], attributes: [] }

function stubStore(opts: { terms?: Term[]; onCommit?: (a: CommitApplication) => CommitResult | CommitConflict }): {
  store: SpecStore
  commits: CommitApplication[]
} {
  const commits: CommitApplication[] = []
  const terms = opts.terms ?? []
  const store = {
    readTerms: async (): Promise<Glossary> => ({ terms, problems: [] }),
    findChangeset: async (id: string) => (id === pending.id ? pending : null),
    commitApplication: async (a: CommitApplication) => {
      commits.push(a)
      return opts.onCommit ? opts.onCommit(a) : { written: ['Widget'], deleted: [], resolvedTo: 'applied/chat-001.json' }
    },
  } as unknown as SpecStore
  return { store, commits }
}

describe('applyChangeset optimistic concurrency (GH #93)', () => {
  it('refuses with a staleVersion 409 — and commits nothing — when expectedVersion no longer matches', async () => {
    const { store, commits } = stubStore({ terms: [] })
    const result = await applyChangeset(store, 'chat-001', { opIndices: [0], expectedVersion: glossaryVersion([someTerm]) })
    expect(result).toMatchObject({ ok: false, status: 409, staleVersion: true, currentVersion: glossaryVersion([]) })
    expect(commits).toHaveLength(0) // refused before any write
  })

  it('applies when expectedVersion matches the live glossary, passing that version as baseVersion', async () => {
    const { store, commits } = stubStore({ terms: [] })
    const result = await applyChangeset(store, 'chat-001', { opIndices: [0], expectedVersion: glossaryVersion([]) })
    expect(result.ok).toBe(true)
    expect(commits[0]?.baseVersion).toBe(glossaryVersion([]))
  })

  it('applies with no expectedVersion (unchanged behaviour), still passing baseVersion to the store', async () => {
    const { store, commits } = stubStore({ terms: [] })
    const result = await applyChangeset(store, 'chat-001', { opIndices: [0] })
    expect(result.ok).toBe(true)
    expect(commits[0]?.baseVersion).toBe(glossaryVersion([]))
  })

  it('maps a commit-time CAS conflict onto a staleVersion 409 carrying the store’s currentVersion', async () => {
    const { store } = stubStore({ terms: [], onCommit: () => ({ conflict: true, currentVersion: 'ff00ff00ff00ff' }) })
    const result = await applyChangeset(store, 'chat-001', { opIndices: [0] })
    expect(result).toMatchObject({ ok: false, status: 409, staleVersion: true, currentVersion: 'ff00ff00ff00ff' })
  })
})
