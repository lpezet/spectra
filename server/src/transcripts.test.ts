import { describe, expect, it } from 'vitest'
import { TranscriptStore } from './transcripts.js'

const NOW = '2026-08-05T10:00:00.000Z'

function store() {
  const db = new TranscriptStore(':memory:')
  db.createSession('s1', 'Where should I start?', NOW)
  return db
}

describe('TranscriptStore', () => {
  it('replays a session in order from a cursor', () => {
    const db = store()
    const first = db.append('s1', { author: 'human', kind: 'user', text: 'where do I start?' }, NOW)
    db.append('s1', { author: 'spec', kind: 'assistant', text: 'decide cs-003 first' }, NOW)

    expect(db.read('s1').map((event) => event.kind)).toEqual(['user', 'assistant'])
    expect(db.read('s1', first).map((event) => event.text)).toEqual(['decide cs-003 first'])
  })

  it('keeps sessions apart', () => {
    const db = store()
    db.createSession('s2', 'Other', NOW)
    db.append('s1', { author: 'human', kind: 'user', text: 'one' }, NOW)
    db.append('s2', { author: 'human', kind: 'user', text: 'two' }, NOW)

    expect(db.read('s1').map((event) => event.text)).toEqual(['one'])
    expect(db.read('s2').map((event) => event.text)).toEqual(['two'])
  })

  it('round-trips a structured payload', () => {
    const db = store()
    db.append('s1', { author: 'spec', kind: 'tool_call', text: 'simulateOps', payload: { ops: [1, 2] } }, NOW)
    expect(db.read('s1')[0]!.payload).toEqual({ ops: [1, 2] })
  })

  it('settles a tool call without losing its input', () => {
    const db = store()
    db.append(
      's1',
      { author: 'spec', kind: 'tool_call', text: 'raiseQuestion', payload: { input: { id: 'q-005' } }, toolCallId: 'call_1', status: 'started' },
      NOW,
    )
    db.settleToolCall('call_1', 'completed', { file: 'q-005.json' })

    const [event] = db.read('s1')
    expect(event!.status).toBe('completed')
    expect(event!.payload).toEqual({ input: { id: 'q-005' }, output: { file: 'q-005.json' } })
  })

  it('leaves an unsettled tool call marked started, so a resume can tell', () => {
    const db = store()
    db.append('s1', { author: 'spec', kind: 'tool_call', text: 'Edit', toolCallId: 'call_2', status: 'started' }, NOW)
    expect(db.read('s1')[0]!.status).toBe('started')
  })

  it('searches message text across sessions and ignores tool noise', () => {
    const db = store()
    db.createSession('s2', 'Other', NOW)
    db.append('s1', { author: 'spec', kind: 'assistant', text: 'RecurringTask reopens at its next occurrence' }, NOW)
    db.append('s2', { author: 'human', kind: 'user', text: 'why does deleteProject block?' }, NOW)
    db.append('s2', { author: 'spec', kind: 'tool_call', text: 'readGlossary RecurringTask' }, NOW)

    const hits = db.search('recurringtask')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.title).toBe('Where should I start?')
  })

  it('treats % and _ in a search as literal characters', () => {
    const db = store()
    db.append('s1', { author: 'human', kind: 'user', text: 'literal 100% match' }, NOW)
    db.append('s1', { author: 'human', kind: 'user', text: 'unrelated' }, NOW)

    expect(db.search('100%').map((event) => event.text)).toEqual(['literal 100% match'])
  })

  it('cascades events when a session is deleted', () => {
    const db = store()
    db.append('s1', { author: 'human', kind: 'user', text: 'gone' }, NOW)
    db.deleteSession('s1')

    expect(db.getSession('s1')).toBeNull()
    expect(db.read('s1')).toEqual([])
  })

  it('prunes stale sessions and reports how many went', () => {
    const db = store()
    db.createSession('s2', 'Recent', '2026-08-05T12:00:00.000Z')

    expect(db.pruneBefore('2026-08-05T11:00:00.000Z')).toBe(1)
    expect(db.listSessions().map((session) => session.id)).toEqual(['s2'])
  })

  it('records who produced each event', () => {
    const db = store()
    db.append('s1', { author: 'human', kind: 'user', text: 'do it' }, NOW)
    db.append('s1', { author: 'coder', kind: 'assistant', text: 'done' }, NOW)

    expect(db.read('s1').map((event) => event.author)).toEqual(['human', 'coder'])
  })

  it('bumps updatedAt on append, so recency ordering reflects activity', () => {
    const db = store()
    db.createSession('s2', 'Newer', '2026-08-05T11:00:00.000Z')
    db.append('s1', { author: 'human', kind: 'user', text: 'still going' }, '2026-08-05T12:00:00.000Z')

    expect(db.listSessions().map((session) => session.id)).toEqual(['s1', 's2'])
  })
})
