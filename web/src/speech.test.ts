import { describe, expect, it } from 'vitest'
import { applySigils, firstSentence, speakableText } from './speech.js'

describe('speakableText', () => {
  it('keeps prose', () => {
    expect(speakableText('Tests and typecheck pass.')).toBe('Tests and typecheck pass.')
  })

  /** The whole reason this exists — a fenced block read aloud is half a minute of nothing. */
  it('drops fenced code entirely rather than announcing it', () => {
    const spoken = speakableText('Updated the domain:\n\n```ts\nconst x = 1\n```\n\nAll green.')
    expect(spoken).toBe('Updated the domain:. All green.')
    expect(spoken).not.toMatch(/const|code/)
  })

  it('drops inline code, which is almost always a path or an identifier', () => {
    expect(speakableText('Edited `app/src/domain/completeTask.ts` today.')).toBe('Edited today.')
  })

  it('says a mention as the bare name', () => {
    expect(speakableText('Ask @spec about it.')).toBe('Ask spec about it.')
  })

  it('reads emphasis as the words inside it', () => {
    expect(speakableText('This is **important** and *urgent*.')).toBe('This is important and urgent.')
  })

  it('turns a list into sentences, since bullets have no sound', () => {
    expect(speakableText('- raised q-009\n- e-011 stays contested')).toBe(
      'raised q-009. e-011 stays contested',
    )
  })

  it('reads a heading as a sentence rather than skipping it', () => {
    expect(speakableText('## What I did\n\nRenamed the tests.')).toBe('What I did. Renamed the tests.')
  })

  it('has nothing to say about a message that is only code', () => {
    expect(speakableText('```\nnpm test\n```')).toBe('')
  })

  it('leaves no double spaces or stranded punctuation behind', () => {
    expect(speakableText('Ran `npm test` , then `npm run typecheck` .')).toBe('Ran, then.')
  })
})

describe('firstSentence', () => {
  it('leaves a short message alone', () => {
    expect(firstSentence('Tests pass.')).toBe('Tests pass.')
  })

  it('cuts at a sentence end when there is one', () => {
    const long = `${'a'.repeat(100)}. ${'b'.repeat(300)}`
    expect(firstSentence(long)).toBe(`${'a'.repeat(100)}.`)
  })

  it('ellipsises when there is no sentence end to cut at', () => {
    const long = 'c'.repeat(400)
    expect(firstSentence(long, 100)).toBe(`${'c'.repeat(100)}…`)
  })
})

describe('applySigils', () => {
  it('turns a spoken address into one the composer understands', () => {
    expect(applySigils('at coder please run the tests')).toBe('@coder please run the tests')
  })

  it('handles the other agent too, whatever the casing', () => {
    expect(applySigils('At Spec what is contested')).toBe('@Spec what is contested')
  })

  it('turns a spoken reference into a term sigil', () => {
    expect(applySigils('tell me about hash RecurringTask')).toBe('tell me about #RecurringTask')
  })

  it('closes up the space speech engines leave before punctuation', () => {
    expect(applySigils('is it done ?')).toBe('is it done?')
  })

  /** "at" is an ordinary word; only the agent names should be rewritten. */
  it('leaves an unrelated "at" alone', () => {
    expect(applySigils('look at the glossary')).toBe('look at the glossary')
  })
})
