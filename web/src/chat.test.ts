import { describe, expect, it } from 'vitest'
import { addresseeOf, groupRuns, isNarrative, isPendingApproval, mentionAt } from './chat.js'
import type { ChatEvent } from './chat.js'

const AGENTS = ['spec', 'coder']

describe('mentionAt', () => {
  it('reads @ as addressing someone and # as referring to something', () => {
    expect(mentionAt('ask @sp', 7)).toEqual({ sigil: 'agent', query: 'sp', from: 4 })
    expect(mentionAt('about #Ta', 9)).toEqual({ sigil: 'artifact', query: 'Ta', from: 6 })
  })

  it('opens the menu on a bare sigil', () => {
    expect(mentionAt('@', 1)).toEqual({ sigil: 'agent', query: '', from: 0 })
  })

  it('ignores a sigil mid-word, so an email is not a mention', () => {
    expect(mentionAt('me@example', 10)).toBeNull()
  })

  it('only looks at the caret, not the whole line', () => {
    expect(mentionAt('@spec and more', 14)).toBeNull()
  })
})

describe('addresseeOf', () => {
  it('finds the agent a message is addressed to', () => {
    expect(addresseeOf('@coder implement it', AGENTS)).toBe('coder')
    expect(addresseeOf('hey @spec what now', AGENTS)).toBe('spec')
  })

  it('takes the first agent named, so one message has one owner', () => {
    expect(addresseeOf('@spec then @coder', AGENTS)).toBe('spec')
  })

  it('ignores an @ that is not an agent', () => {
    // #Task is the artifact form now; @Task addresses nobody.
    expect(addresseeOf('what about @Task', AGENTS)).toBeNull()
  })

  it('returns null for an unaddressed message, which nobody acts on', () => {
    expect(addresseeOf('just thinking out loud', AGENTS)).toBeNull()
  })
})

describe('groupRuns', () => {
  let next = 0
  const event = (kind: ChatEvent['kind'], author: ChatEvent['author'], extra: Partial<ChatEvent> = {}): ChatEvent => ({
    id: (next += 1),
    sessionId: 's',
    author,
    kind,
    text: null,
    payload: null,
    toolCallId: null,
    status: null,
    createdAt: '',
    ...extra,
  })

  it('starts a new run at every human turn', () => {
    const runs = groupRuns([
      event('user', 'human'),
      event('assistant', 'coder'),
      event('user', 'human'),
      event('assistant', 'coder'),
    ])

    expect(runs).toHaveLength(2)
    expect(runs[0]!.steps).toHaveLength(1)
  })

  it('keeps tool calls and approvals inside the run they belong to', () => {
    const runs = groupRuns([
      event('user', 'human'),
      event('assistant', 'coder'),
      event('tool_call', 'coder'),
      event('approval', 'coder'),
      event('assistant', 'coder'),
    ])

    expect(runs).toHaveLength(1)
    expect(runs[0]!.steps.map((step) => step.kind)).toEqual([
      'assistant',
      'tool_call',
      'approval',
      'assistant',
    ])
  })

  it('names the agent that answered', () => {
    const runs = groupRuns([event('user', 'human'), event('assistant', 'spec')])
    expect(runs[0]!.author).toBe('spec')
  })

  /** A resumed session whose start was pruned — dropping these would lose transcript. */
  it('keeps events that precede any human turn', () => {
    const runs = groupRuns([event('assistant', 'coder'), event('user', 'human'), event('assistant', 'coder')])

    expect(runs).toHaveLength(2)
    expect(runs[0]!.prompt).toBeNull()
    expect(runs[0]!.steps).toHaveLength(1)
  })

  it('has nothing to group in an empty transcript', () => {
    expect(groupRuns([])).toEqual([])
  })

  it('separates prose from what the agent did', () => {
    expect(isNarrative(event('assistant', 'coder'))).toBe(true)
    expect(isNarrative(event('error', 'coder'))).toBe(true)
    expect(isNarrative(event('tool_call', 'coder'))).toBe(false)
    expect(isNarrative(event('approval', 'coder'))).toBe(false)
  })

  /** Hiding one would suspend the run with no visible reason. */
  it('marks an unanswered approval, and only an unanswered one', () => {
    expect(isPendingApproval(event('approval', 'coder', { status: 'started' }))).toBe(true)
    expect(isPendingApproval(event('approval', 'coder', { status: 'completed' }))).toBe(false)
    expect(isPendingApproval(event('tool_call', 'coder', { status: 'started' }))).toBe(false)
  })
})
