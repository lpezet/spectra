import { beforeEach, describe, expect, it } from 'vitest'
import {
  FORGIVEN,
  applySigils,
  disarmsImmediately,
  leadSentence,
  rearmRemoteVoice,
  remoteVoiceState,
  speakableText,
  withDefaultVoices,
} from './speech.js'

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

describe('leadSentence', () => {
  /** What the prompt now asks both agents to produce, and all that should be read. */
  it('reads the conclusion and stops', () => {
    expect(
      leadSentence(
        'The tests pass and q-009 is still open. I renamed eleven tests to cite their expectation ids and refreshed the snapshot.',
      ),
    ).toBe('The tests pass and q-009 is still open.')
  })

  /** Thirteen characters, and complete — this must not drag the next sentence in with it. */
  it('leaves a short but complete conclusion alone', () => {
    expect(leadSentence('Raised q-009. It is open and unanswered.')).toBe('Raised q-009.')
  })

  it('joins a very short opener to the sentence after it', () => {
    expect(leadSentence('Done. Eleven tests now cite their expectation ids.')).toBe(
      'Done. Eleven tests now cite their expectation ids.',
    )
  })

  it('leaves a single-sentence message alone', () => {
    expect(leadSentence('Tests pass and nothing is contested.')).toBe(
      'Tests pass and nothing is contested.',
    )
  })

  /** An id ending in a full stop is not the end of a sentence. */
  it('does not end a sentence at an id or an abbreviation', () => {
    expect(leadSentence('Raised q-009. e-011 stays contested until it is answered.')).toBe(
      'Raised q-009. e-011 stays contested until it is answered.',
    )
  })

  it('truncates a passage with no sentence break rather than reading it whole', () => {
    expect(leadSentence('c'.repeat(400), 100)).toBe(`${'c'.repeat(100)}…`)
  })

  it('has nothing to say about an empty message', () => {
    expect(leadSentence('   ')).toBe('')
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

/**
 * The fallback rules, which are the whole point of the remote voice being optional. Nothing
 * here touches the network: what is worth pinning is *which* failures are worth giving up on,
 * because getting that wrong is either a session of silent round trips before every sentence
 * or a voice that vanishes on one bad packet.
 */
describe('disarmsImmediately', () => {
  it('gives up on a spent quota — it will still be spent in thirty seconds', () => {
    expect(disarmsImmediately('quota')).toBe(true)
  })

  it('gives up when there is no key, rather than asking again every sentence', () => {
    expect(disarmsImmediately('no-credential')).toBe(true)
  })

  it('gives up on a rejected request, which a retry reproduces exactly', () => {
    expect(disarmsImmediately('rejected')).toBe(true)
  })

  /** Both of these can stop being true, so they cost one sentence rather than the session. */
  it('forgives a rate limit', () => {
    expect(disarmsImmediately('rate-limit')).toBe(false)
  })

  it('forgives an unreachable host', () => {
    expect(disarmsImmediately('unreachable')).toBe(false)
  })
})

describe('the remote voice arms and disarms', () => {
  beforeEach(() => rearmRemoteVoice())

  it('starts armed, with nothing to report', () => {
    expect(remoteVoiceState()).toEqual({ armed: true, error: null })
  })

  it('re-arming after a failure is what lets a new choice be tried', () => {
    rearmRemoteVoice()
    expect(remoteVoiceState().armed).toBe(true)
  })

  /** Forgiven is not forgotten: a host that stays down stops being asked. */
  it('forgives a fixed number of times, so a dead host is not paid for forever', () => {
    expect(FORGIVEN).toBe(3)
  })
})

/**
 * Seeding from the server's defaults. The whole subtlety is that "never chose" and "chose the
 * browser" are different states, and only the first one may be filled in.
 */
describe('withDefaultVoices', () => {
  const base = { uri: null, pitch: 1, rate: 1 }

  it('starts an agent on the voice the server named', () => {
    const next = withDefaultVoices({ spec: { ...base } }, { spec: 'voice-1' })
    expect(next.spec?.remoteId).toBe('voice-1')
  })

  /** An explicit null is a decision to stay local, and outranks the environment. */
  it('leaves a deliberate browser voice alone', () => {
    const chosen = { spec: { ...base, remoteId: null } }
    expect(withDefaultVoices(chosen, { spec: 'voice-1' })).toBe(chosen)
  })

  it('does not overwrite a remote voice already picked', () => {
    const chosen = { spec: { ...base, remoteId: 'mine' } }
    expect(withDefaultVoices(chosen, { spec: 'voice-1' })).toBe(chosen)
  })

  it('returns the same object when there is nothing to apply, so React sees no change', () => {
    const current = { spec: { ...base } }
    expect(withDefaultVoices(current, {})).toBe(current)
    expect(withDefaultVoices(current, { spec: null })).toBe(current)
  })

  it('ignores a default for an agent that is not there', () => {
    const current = { spec: { ...base } }
    expect(withDefaultVoices(current, { coder: 'voice-2' })).toBe(current)
  })
})
