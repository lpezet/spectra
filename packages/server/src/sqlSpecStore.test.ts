/**
 * SqlSpecStore slice 1: the reads, id allocation, and simple creates, against an in-memory DB.
 *
 * What is exercised is what has a create path in slice 1 — changesets (pending), questions, and
 * expectations (live, split into published vs drafts) — plus id allocation and projectInfo. Terms
 * and the resolved partitions (applied/rejected/retired) have no create path until slice 2's state
 * transitions, so here they are only asserted empty; they get populated tests when apply/reject/
 * retire land. The partitioning logic itself mirrors FileSystemSpecStore.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Changeset, Expectation, Question } from '@spectra/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqlSpecStore } from './sqlSpecStore.js'

let store: SqlSpecStore
beforeEach(() => {
  store = new SqlSpecStore(':memory:', 'proj-1')
})

const changeset = (id: string, over: Partial<Changeset> = {}): Changeset => ({
  id,
  summary: 'a change',
  ops: [],
  tests: [],
  ...over,
})
const question = (id: string, over: Partial<Question> = {}): Question => ({
  id,
  asks: 'Q?',
  because: 'the spec is silent',
  raisedBy: { pass: 'implementation', terms: ['Task'] },
  options: [],
  answer: null,
  ...over,
})
const expectation = (id: string, over: Partial<Expectation> = {}): Expectation => ({
  id,
  kind: 'functional',
  terms: ['Task'],
  given: '',
  expect: 'something holds',
  raisedBy: { pass: 'implementation' },
  supersededBy: null,
  contested: [],
  ...over,
})

describe('SqlSpecStore.projectInfo', () => {
  it('falls back to a neutral default when unset', async () => {
    const info = await store.projectInfo()
    expect(info.name).toBe('Untitled project')
    expect(info.name).not.toMatch(/todo/i)
  })
  it('returns the set identity', async () => {
    store.setProjectInfo({ name: 'Acme', domain: 'a billing system' })
    expect(await store.projectInfo()).toEqual({ name: 'Acme', domain: 'a billing system' })
  })
})

describe('SqlSpecStore reads (empty)', () => {
  it('returns the partitioned shapes empty', async () => {
    expect(await store.readTerms()).toEqual({ terms: [], problems: [] })
    expect(await store.readChangesets()).toEqual({ changesets: [], applied: [], rejected: [], problems: [] })
    expect(await store.readQuestions()).toEqual({ questions: [], problems: [] })
    expect(await store.readExpectations()).toEqual({ expectations: [], drafts: [], retired: [], problems: [] })
  })
})

describe('SqlSpecStore changesets', () => {
  it('adds a pending changeset, reads it back, finds it by id', async () => {
    await store.addChangeset(changeset('chat-001', { summary: 'first' }))
    const feed = await store.readChangesets()
    expect(feed.changesets.map((c) => c.id)).toEqual(['chat-001'])
    expect(feed.applied).toEqual([])
    expect(feed.rejected).toEqual([])
    expect((await store.findChangeset('chat-001'))?.summary).toBe('first')
    expect(await store.findChangeset('nope')).toBeNull()
  })
})

describe('SqlSpecStore questions', () => {
  it('adds and reads a question, finds it', async () => {
    await store.addQuestion(question('q-001'))
    expect((await store.readQuestions()).questions.map((q) => q.id)).toEqual(['q-001'])
    expect((await store.findQuestion('q-001'))?.asks).toBe('Q?')
    expect(await store.findQuestion('q-999')).toBeNull()
  })
})

describe('SqlSpecStore expectations', () => {
  it('splits live into published vs drafts; retired is empty', async () => {
    await store.addExpectation(expectation('e-001'))
    await store.addExpectation(expectation('e-002', { status: 'draft' }))
    const feed = await store.readExpectations()
    expect(feed.expectations.map((e) => e.id)).toEqual(['e-001'])
    expect(feed.drafts.map((e) => e.id)).toEqual(['e-002'])
    expect(feed.retired).toEqual([])
    expect((await store.findExpectation('e-002'))?.status).toBe('draft')
  })
})

describe('SqlSpecStore id allocation', () => {
  it('increments per collection over every row, tolerating gaps', async () => {
    expect(await store.nextChangesetId()).toBe('chat-001')
    await store.addChangeset(changeset('chat-003'))
    expect(await store.nextChangesetId()).toBe('chat-004')

    expect(await store.nextQuestionId()).toBe('q-001')
    await store.addQuestion(question('q-002'))
    expect(await store.nextQuestionId()).toBe('q-003')

    await store.addExpectation(expectation('e-005'))
    expect(await store.nextExpectationId()).toBe('e-006')
  })
})

describe('SqlSpecStore project scoping', () => {
  it('keeps two projects in one database isolated', async () => {
    // One shared database file (an in-memory DB is per-connection, so use a temp file).
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'tb-sql-')), 'specs.db')
    const one = new SqlSpecStore(file, 'proj-1')
    const two = new SqlSpecStore(file, 'proj-2')

    one.setProjectInfo({ name: 'One', domain: 'first' })
    two.setProjectInfo({ name: 'Two', domain: 'second' })
    await one.addChangeset(changeset('chat-001', { summary: 'only in one' }))

    expect((await one.projectInfo()).name).toBe('One')
    expect((await two.projectInfo()).name).toBe('Two')
    expect((await one.readChangesets()).changesets.map((c) => c.id)).toEqual(['chat-001'])
    expect((await two.readChangesets()).changesets).toEqual([])
    // The same id is free in the other project, and ids are allocated per project.
    expect(await two.nextChangesetId()).toBe('chat-001')
    expect(await one.nextChangesetId()).toBe('chat-002')

    one.close()
    two.close()
  })
})

describe('SqlSpecStore write stubs (slice 2)', () => {
  it('state transitions throw until implemented', async () => {
    await expect(store.rejectChangeset('chat-001')).rejects.toThrow(/slice 2/)
    await expect(store.markImplemented('chat-001', 'now')).rejects.toThrow(/slice 2/)
  })
})
