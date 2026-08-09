import { describe, expect, it } from 'vitest'
import { checkDraft, materialFor } from './expectationCheck.js'
import type { ExpectationDraft } from './expectationCheck.js'
import type { Expectation, Term } from './types.js'

const TERMS: Term[] = [
  {
    name: 'unarchiveProject',
    type: 'function',
    spec: 'Restores an archived Project to active status. Does not re-enable any RecurringTask that archiving ended.',
    parent: null,
    tags: [],
    attributes: [],
  },
  { name: 'Project', type: 'entity', spec: 'A named container for Tasks.', parent: null, tags: [], attributes: [] },
]

function existing(id: string, terms: string[], expectText: string): Expectation {
  return {
    id,
    kind: 'functional',
    terms,
    given: '',
    expect: expectText,
    raisedBy: { pass: 'test' },
    supersededBy: null,
  }
}

const DRAFT: ExpectationDraft = {
  kind: 'functional',
  terms: ['Project', 'unarchiveProject'],
  given: '',
  expect: 're-enabled any recurring tasks present in project',
}

describe('checkDraft', () => {
  it('finds nothing wrong with a clean draft', () => {
    expect(checkDraft(DRAFT, TERMS, [])).toEqual([])
  })

  it('flags a term the glossary does not have', () => {
    const findings = checkDraft({ ...DRAFT, terms: ['Project', 'Sprint'] }, TERMS, [])
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'unknown-term', subject: 'Sprint' }),
    ])
  })

  it('flags a near-duplicate of a live expectation, quoting it', () => {
    const findings = checkDraft(DRAFT, TERMS, [
      existing('e-011', ['Project', 'unarchiveProject'], 're-enable the recurring tasks present in a project'),
    ])

    expect(findings).toEqual([
      expect.objectContaining({ kind: 'duplicate', subject: 'e-011', quote: expect.any(String) }),
    ])
  })

  it('calls it an overlap, not a duplicate, when the terms match but the words do not', () => {
    const findings = checkDraft(DRAFT, TERMS, [
      existing('e-012', ['Project', 'unarchiveProject'], 'the Project becomes visible in default listings again'),
    ])

    expect(findings).toEqual([expect.objectContaining({ kind: 'overlaps', subject: 'e-012' })])
  })

  it('ignores a retired expectation — it no longer says anything', () => {
    const retired = { ...existing('e-011', ['Project', 'unarchiveProject'], 're-enable the recurring tasks present in a project'), supersededBy: 'e-020' }
    expect(checkDraft(DRAFT, TERMS, [retired])).toEqual([])
  })

  it('does not flag an expectation about different terms', () => {
    const findings = checkDraft(DRAFT, TERMS, [existing('e-013', ['Project'], 'something else entirely')])
    expect(findings).toEqual([])
  })

  /**
   * A real false positive from the first run against the live glossary. Idempotence clauses
   * are near-identical across every function that has one, so wording alone scored these as
   * the same statement when they are about different functions entirely.
   */
  it('does not call two functions duplicates just because both are idempotent', () => {
    const terms: Term[] = [
      ...TERMS,
      { name: 'Task', type: 'entity', spec: 'An item.', parent: null, tags: [], attributes: [] },
      { name: 'reopenTask', type: 'function', spec: 'Reopens a Task.', parent: null, tags: [], attributes: [] },
      { name: 'completeTask', type: 'function', spec: 'Completes a Task.', parent: null, tags: [], attributes: [] },
    ]
    const findings = checkDraft(
      { kind: 'functional', terms: ['Task', 'reopenTask'], given: 'a Task that is not done', expect: 'reopenTask changes nothing and does not error' },
      terms,
      [
        {
          ...existing('e-003', ['Task', 'completeTask'], 'completeTask changes nothing and does not error'),
          given: 'a Task that is already done',
        },
      ],
    )

    expect(findings).toEqual([])
  })

  it('still calls it a duplicate when one term set contains the other', () => {
    const findings = checkDraft(DRAFT, TERMS, [
      existing('e-011', ['Project'], 're-enable the recurring tasks present in a project'),
    ])
    expect(findings).toEqual([expect.objectContaining({ kind: 'duplicate', subject: 'e-011' })])
  })

  /**
   * The case that motivated the whole gate, and the case this file deliberately cannot solve.
   * The draft and the spec are lexically almost the same sentence and mean opposite things,
   * so no token measure separates them — which is why `contradicts` is @spec's job and why
   * this returns clean here rather than pretending otherwise.
   */
  it('cannot see a contradiction, and does not pretend to', () => {
    expect(checkDraft(DRAFT, TERMS, []), 'the draft contradicts unarchiveProject, lexically').toEqual([])
  })
})

describe('materialFor', () => {
  it('hands over the spec text of every term named, and skips ones that do not exist', () => {
    expect(materialFor({ ...DRAFT, terms: ['Project', 'Sprint'] }, TERMS)).toEqual([
      { name: 'Project', spec: 'A named container for Tasks.' },
    ])
  })
})
