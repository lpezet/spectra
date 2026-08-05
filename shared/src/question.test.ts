import { describe, expect, it } from 'vitest'
import { parseQuestion } from './schema.js'

const MINIMAL = {
  id: 'q-001',
  asks: 'Should creation be spec’d?',
  because: 'The glossary defines no createProject.',
  raisedBy: { pass: 'implementation', terms: ['Project'] },
}

describe('parseQuestion', () => {
  it('accepts a question with no options — some can only be answered in prose', () => {
    const parsed = parseQuestion(MINIMAL)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.options).toEqual([])
      expect(parsed.value.answer).toBeNull()
    }
  })

  it('defaults an option with no proposal to null rather than dropping the field', () => {
    const parsed = parseQuestion({ ...MINIMAL, options: [{ label: 'Leave it out' }] })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.options[0]!.proposal).toBeNull()
  })

  it('validates the ops inside a proposal like any other changeset', () => {
    const parsed = parseQuestion({
      ...MINIMAL,
      options: [
        {
          label: 'Spec them',
          proposal: {
            summary: 'Add createProject',
            ops: [{ op: 'add_attribute', term: 'Task', attribute: { name: 'x', valueType: 'Project' } }],
            tests: [],
          },
        },
      ],
    })

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.join(' ')).toMatch(/ref:Project/)
  })

  it('rejects an answer naming an option that does not exist', () => {
    const parsed = parseQuestion({
      ...MINIMAL,
      options: [{ label: 'Spec them', proposal: null }],
      answer: { chose: 'Something else', note: '', answeredAt: '2026-08-04T00:00:00.000Z' },
    })

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.join(' ')).toMatch(/no option labelled "Something else"/)
  })

  it('accepts an answer that takes none of the options', () => {
    const parsed = parseQuestion({
      ...MINIMAL,
      options: [{ label: 'Spec them', proposal: null }],
      answer: { chose: null, note: 'Neither — split it in two.', answeredAt: '2026-08-04T00:00:00.000Z' },
    })

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.answer?.chose).toBeNull()
  })

  it('catches a mistyped key instead of silently ignoring it', () => {
    const parsed = parseQuestion({ ...MINIMAL, becuase: 'typo' })
    expect(parsed.ok).toBe(false)
  })
})
