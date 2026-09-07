import { describe, expect, it } from 'vitest'
import { SqliteTranscriptStore, resolveTranscriptStore } from './transcripts.js'

const NOW = '2026-08-05T10:00:00.000Z'
const PROJECT = 'todo'

async function store() {
  const db = new SqliteTranscriptStore(':memory:')
  await db.createSession('s1', PROJECT, null, 'Where should I start?', NOW)
  return db
}

describe('TranscriptStore', () => {
  it('replays a session in order from a cursor', async () => {
    const db = await store()
    const first = await db.append('s1', { author: 'human', kind: 'user', text: 'where do I start?' }, NOW)
    await db.append('s1', { author: 'spec', kind: 'assistant', text: 'decide cs-003 first' }, NOW)

    expect((await db.read('s1')).map((event) => event.kind)).toEqual(['user', 'assistant'])
    expect((await db.read('s1', first)).map((event) => event.text)).toEqual(['decide cs-003 first'])
  })

  it('keeps sessions apart', async () => {
    const db = await store()
    await db.createSession('s2', PROJECT, null, 'Other', NOW)
    await db.append('s1', { author: 'human', kind: 'user', text: 'one' }, NOW)
    await db.append('s2', { author: 'human', kind: 'user', text: 'two' }, NOW)

    expect((await db.read('s1')).map((event) => event.text)).toEqual(['one'])
    expect((await db.read('s2')).map((event) => event.text)).toEqual(['two'])
  })

  it('round-trips a structured payload', async () => {
    const db = await store()
    await db.append('s1', { author: 'spec', kind: 'tool_call', text: 'simulateOps', payload: { ops: [1, 2] } }, NOW)
    expect((await db.read('s1'))[0]!.payload).toEqual({ ops: [1, 2] })
  })

  it('settles a tool call without losing its input', async () => {
    const db = await store()
    await db.append(
      's1',
      { author: 'spec', kind: 'tool_call', text: 'raiseQuestion', payload: { input: { id: 'q-005' } }, toolCallId: 'call_1', status: 'started' },
      NOW,
    )
    await db.settleToolCall('call_1', 'completed', { file: 'q-005.json' })

    const [event] = await db.read('s1')
    expect(event!.status).toBe('completed')
    expect(event!.payload).toEqual({ input: { id: 'q-005' }, output: { file: 'q-005.json' } })
  })

  it('leaves an unsettled tool call marked started, so a resume can tell', async () => {
    const db = await store()
    await db.append('s1', { author: 'spec', kind: 'tool_call', text: 'Edit', toolCallId: 'call_2', status: 'started' }, NOW)
    expect((await db.read('s1'))[0]!.status).toBe('started')
  })

  it('searches message text across sessions and ignores tool noise', async () => {
    const db = await store()
    await db.createSession('s2', PROJECT, null, 'Other', NOW)
    await db.append('s1', { author: 'spec', kind: 'assistant', text: 'RecurringTask reopens at its next occurrence' }, NOW)
    await db.append('s2', { author: 'human', kind: 'user', text: 'why does deleteProject block?' }, NOW)
    await db.append('s2', { author: 'spec', kind: 'tool_call', text: 'readGlossary RecurringTask' }, NOW)

    const hits = await db.search('recurringtask')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.title).toBe('Where should I start?')
  })

  it('treats % and _ in a search as literal characters', async () => {
    const db = await store()
    await db.append('s1', { author: 'human', kind: 'user', text: 'literal 100% match' }, NOW)
    await db.append('s1', { author: 'human', kind: 'user', text: 'unrelated' }, NOW)

    expect((await db.search('100%')).map((event) => event.text)).toEqual(['literal 100% match'])
  })

  it('cascades events when a session is deleted', async () => {
    const db = await store()
    await db.append('s1', { author: 'human', kind: 'user', text: 'gone' }, NOW)
    await db.deleteSession('s1')

    expect(await db.getSession('s1')).toBeNull()
    expect(await db.read('s1')).toEqual([])
  })

  it('prunes stale sessions and reports how many went', async () => {
    const db = await store()
    await db.createSession('s2', PROJECT, null, 'Recent', '2026-08-05T12:00:00.000Z')

    expect(await db.pruneBefore('2026-08-05T11:00:00.000Z')).toBe(1)
    expect((await db.listSessions(PROJECT)).map((session) => session.id)).toEqual(['s2'])
  })

  it('records who produced each event', async () => {
    const db = await store()
    await db.append('s1', { author: 'human', kind: 'user', text: 'do it' }, NOW)
    await db.append('s1', { author: 'coder', kind: 'assistant', text: 'done' }, NOW)

    expect((await db.read('s1')).map((event) => event.author)).toEqual(['human', 'coder'])
  })

  it('bumps updatedAt on append, so recency ordering reflects activity', async () => {
    const db = await store()
    await db.createSession('s2', PROJECT, null, 'Newer', '2026-08-05T11:00:00.000Z')
    await db.append('s1', { author: 'human', kind: 'user', text: 'still going' }, '2026-08-05T12:00:00.000Z')

    expect((await db.listSessions(PROJECT)).map((session) => session.id)).toEqual(['s1', 's2'])
  })

  it('lists sessions per project — one DB, isolated by projectId', async () => {
    const db = await store()
    await db.createSession('s2', 'other-project', null, 'Elsewhere', NOW)

    expect((await db.listSessions(PROJECT)).map((session) => session.id)).toEqual(['s1'])
    expect((await db.listSessions('other-project')).map((session) => session.id)).toEqual(['s2'])
    expect((await db.getSession('s2'))?.projectId).toBe('other-project')
  })

  it('owns sessions per user and narrows a listing to one owner', async () => {
    const db = await store() // s1 is created with a null owner
    await db.createSession('a1', PROJECT, 'alice', 'Alice one', NOW)
    await db.createSession('a2', PROJECT, 'alice', 'Alice two', NOW)
    await db.createSession('b1', PROJECT, 'bob', 'Bob one', NOW)

    expect((await db.getSession('a1'))?.ownerId).toBe('alice')
    // No owner given → every session in the project, whoever owns it (the single-user path).
    expect((await db.listSessions(PROJECT)).map((s) => s.id).sort()).toEqual(['a1', 'a2', 'b1', 's1'])
    // An owner given → only that user's own (the hosted path).
    expect((await db.listSessions(PROJECT, 'alice')).map((s) => s.id).sort()).toEqual(['a1', 'a2'])
    expect((await db.listSessions(PROJECT, 'bob')).map((s) => s.id)).toEqual(['b1'])
    // The null-owned session is nobody's own, so a narrowed listing excludes it.
    expect(await db.listSessions(PROJECT, 'carol')).toEqual([])
  })
})

describe('resolveTranscriptStore', () => {
  const fixture = new URL('./transcript.fixture.ts', import.meta.url).href

  it('loads a plugin module and hands it the context', async () => {
    const store = await resolveTranscriptStore({ TRANSCRIPT_STORE: fixture }, '/data/dir')
    expect(store).not.toBeInstanceOf(SqliteTranscriptStore)
    expect((await store.listSessions('p'))[0]!.id).toBe('from-plugin:/data/dir')
  })

  it('fails clearly when the module cannot be imported', async () => {
    await expect(resolveTranscriptStore({ TRANSCRIPT_STORE: '/no/such/store.js' }, '/tmp')).rejects.toThrow(
      /could not be imported/,
    )
  })
})
