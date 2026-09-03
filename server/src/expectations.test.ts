import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import type { Author } from '@tb/shared'
import { publishExpectation, raiseExpectation, supersedeExpectation } from './expectations.js'

const BY: Author = { kind: 'human' }

// The store is constructor-injected now, so the temp glossary is just a directory we point a
// FileSystemSpecStore at.
let specs: string
let store: FileSystemSpecStore

beforeAll(async () => {
  specs = await mkdtemp(path.join(tmpdir(), 'tb-expect-'))
  await mkdir(path.join(specs, 'terms'), { recursive: true })
  await mkdir(path.join(specs, 'expectations'), { recursive: true })
  await writeFile(
    path.join(specs, 'terms', 'task.json'),
    JSON.stringify({ name: 'Task', type: 'entity', spec: 'A task.', parent: null, tags: [], attributes: [] }),
  )
  store = new FileSystemSpecStore(specs)
})

const BASE = {
  kind: 'functional' as const,
  terms: ['Task', 'completeTask'],
  expect: 'completing a done Task changes nothing',
  pass: 'implementation',
}

async function liveFiles(): Promise<string[]> {
  return (await readdir(path.join(specs, 'expectations'))).filter((file) => file.endsWith('.json')).sort()
}

describe('raiseExpectation', () => {
  it('writes a live expectation with no review step', async () => {
    const outcome = await raiseExpectation(store, BASE, BY)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.id).toBe('e-001')

    const written = JSON.parse(await readFile(path.join(specs, 'expectations', outcome.file), 'utf8'))
    expect(written.supersededBy).toBeNull()
    expect(written.raisedBy).toEqual({ pass: 'implementation' })
    // Identity is stamped by the caller and persisted alongside the origin.
    expect(written.author).toEqual({ kind: 'human' })
    // Published by default — a raise with no status is ready, not a draft.
    expect(written.status).toBe('ready')
  })

  it('numbers the next above the highest already there', async () => {
    const second = await raiseExpectation(store, { ...BASE, expect: 'a second thing holds' }, BY)
    expect(second.ok && second.id).toBe('e-002')
  })

  it('refuses a functional expectation naming no terms, since it could never be counted', async () => {
    const before = await liveFiles()
    const outcome = await raiseExpectation(store, { ...BASE, terms: [], expect: 'something vague' }, BY)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/at least one glossary term/)
    expect(await liveFiles(), 'nothing invalid should reach disk').toEqual(before)
  })

  it('allows a non-functional expectation to name no terms — it scopes to the build', async () => {
    const outcome = await raiseExpectation(store, {
      kind: 'non-functional',
      terms: [],
      expect: 'the app survives a refresh',
      pass: 'usage',
    }, BY)
    expect(outcome.ok).toBe(true)
  })
})

describe('supersedeExpectation', () => {
  it('moves the original to retired/, records why, and points at the replacement', async () => {
    const original = await raiseExpectation(store, { ...BASE, expect: 'the first wording' }, BY)
    expect(original.ok).toBe(true)
    if (!original.ok) return

    const outcome = await supersedeExpectation(store, original.id, {
      note: 'q-004 settled it the other way',
      replacement: { kind: 'functional', terms: ['Task', 'completeTask'], expect: 'the better wording' },
    }, BY)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.replacement?.expect).toBe('the better wording')
    // The replacement records what it came from, so the trail runs in both directions.
    expect(outcome.replacement?.raisedBy.from).toBe(original.id)

    const { expectations, retired } = await store.readExpectations()
    expect(expectations.map((entry) => entry.id)).not.toContain(original.id)

    const gone = retired.find((entry) => entry.id === original.id)!
    expect(gone.supersededBy).toBe(outcome.replacement!.id)
    expect(gone.retiredBecause).toBe('q-004 settled it the other way')
  })

  it('retires without a replacement, and the directory is what marks it retired', async () => {
    const original = await raiseExpectation(store, { ...BASE, expect: 'this turned out to be wrong' }, BY)
    expect(original.ok).toBe(true)
    if (!original.ok) return

    const outcome = await supersedeExpectation(store, original.id, { note: 'the feature was dropped' }, BY)
    expect(outcome.ok && outcome.replacement).toBeNull()

    const { expectations, retired } = await store.readExpectations()
    expect(expectations.map((entry) => entry.id)).not.toContain(original.id)
    // supersededBy stays null, so only its location says it no longer applies.
    expect(retired.find((entry) => entry.id === original.id)?.supersededBy).toBeNull()
  })

  it('never reuses a retired id', async () => {
    const before = await raiseExpectation(store, { ...BASE, expect: 'about to be retired' }, BY)
    expect(before.ok).toBe(true)
    if (!before.ok) return

    await supersedeExpectation(store, before.id, { note: 'no longer relevant' }, BY)
    const after = await raiseExpectation(store, { ...BASE, expect: 'raised after the retirement' }, BY)

    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.id).not.toBe(before.id)
    expect(Number(after.id.slice(2))).toBeGreaterThan(Number(before.id.slice(2)))
  })

  it('404s on an id that is not live', async () => {
    const outcome = await supersedeExpectation(store, 'e-999', { note: 'nothing there' }, BY)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.status).toBe(404)
  })
})

describe('draft expectations', () => {
  it('keeps a draft out of the published set and in its own, then publishing moves it', async () => {
    const draft = await raiseExpectation(store, { ...BASE, expect: 'still being worked out', status: 'draft' }, BY)
    expect(draft.ok).toBe(true)
    if (!draft.ok) return
    expect(draft.expectation.status).toBe('draft')

    // A draft counts toward nothing: it is absent from the published list and present only
    // among the drafts.
    const before = await store.readExpectations()
    expect(before.expectations.map((e) => e.id)).not.toContain(draft.id)
    expect(before.drafts.map((e) => e.id)).toContain(draft.id)

    const published = await publishExpectation(store, draft.id)
    expect(published.ok).toBe(true)
    if (!published.ok) return
    expect(published.expectation.status).toBe('ready')

    // Published: now in the live set, gone from drafts, same id and file.
    const after = await store.readExpectations()
    expect(after.expectations.map((e) => e.id)).toContain(draft.id)
    expect(after.drafts.map((e) => e.id)).not.toContain(draft.id)
    expect(published.file).toBe(draft.file)
  })

  it('publishing is idempotent and 404s on an unknown id', async () => {
    const ready = await raiseExpectation(store, { ...BASE, expect: 'already published' }, BY)
    expect(ready.ok).toBe(true)
    if (!ready.ok) return

    const again = await publishExpectation(store, ready.id)
    expect(again.ok && again.expectation.status).toBe('ready')

    const missing = await publishExpectation(store, 'e-999')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.status).toBe(404)
  })
})
