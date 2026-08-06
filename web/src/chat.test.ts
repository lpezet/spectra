import { describe, expect, it } from 'vitest'
import { addresseeOf, mentionAt } from './chat.js'

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
