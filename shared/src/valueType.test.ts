import { describe, expect, it } from 'vitest'
import { describeValueTypeError, formatValueType, parseValueType, refName } from './valueType.js'

describe('parseValueType', () => {
  it('parses primitives', () => {
    expect(parseValueType('string')).toEqual({ kind: 'primitive', name: 'string', array: false })
    expect(parseValueType('boolean')).toEqual({ kind: 'primitive', name: 'boolean', array: false })
    expect(parseValueType('date')).toEqual({ kind: 'primitive', name: 'date', array: false })
  })

  it('parses term references', () => {
    expect(parseValueType('ref:Task')).toEqual({ kind: 'ref', name: 'Task', array: false })
  })

  it('parses the [] cardinality suffix on both kinds', () => {
    expect(parseValueType('ref:Task[]')).toEqual({ kind: 'ref', name: 'Task', array: true })
    expect(parseValueType('string[]')).toEqual({ kind: 'primitive', name: 'string', array: true })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseValueType('  ref:Task[]  ')).toEqual({ kind: 'ref', name: 'Task', array: true })
  })

  it('rejects a bare term name missing its ref: prefix', () => {
    expect(parseValueType('Task')).toBeNull()
    expect(describeValueTypeError('Task')).toContain('ref:Task')
  })

  it('rejects unknown primitives and malformed input', () => {
    expect(parseValueType('int')).toBeNull()
    expect(parseValueType('')).toBeNull()
    expect(parseValueType('ref:')).toBeNull()
    expect(parseValueType('ref:Task[')).toBeNull()
    expect(parseValueType('ref:Task[][]')).toBeNull()
  })
})

describe('refName', () => {
  it('returns the target term for references only', () => {
    expect(refName('ref:Project')).toBe('Project')
    expect(refName('ref:Task[]')).toBe('Task')
    expect(refName('string')).toBeNull()
    expect(refName('nonsense!')).toBeNull()
  })
})

describe('formatValueType', () => {
  it('round-trips through parseValueType', () => {
    for (const raw of ['string', 'string[]', 'ref:Task', 'ref:Task[]']) {
      expect(formatValueType(parseValueType(raw)!)).toBe(raw)
    }
  })
})
