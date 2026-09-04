import { describe, expect, it } from 'vitest'
import { computeBacklinks, connectionsFor } from './backlinks.js'
import type { Term } from './types.js'

function term(partial: Partial<Term> & { name: string }): Term {
  return { type: 'entity', spec: '', parent: null, tags: [], attributes: [], ...partial }
}

const glossary: Term[] = [
  term({ name: 'Project', attributes: [{ name: 'tasks', valueType: 'ref:Task[]' }] }),
  term({ name: 'Task', attributes: [{ name: 'project', valueType: 'ref:Project' }] }),
  term({ name: 'RecurringTask', parent: 'Task' }),
  term({
    name: 'completeTask',
    type: 'function',
    attributes: [{ name: 'target', valueType: 'ref:Task' }],
  }),
]

describe('computeBacklinks', () => {
  it('collects subtypes under their supertype', () => {
    expect(computeBacklinks(glossary).children['Task']).toEqual(['RecurringTask'])
  })

  it('finds referrers through both plain and array attribute refs', () => {
    const referrers = computeBacklinks(glossary).byTarget['Task']!
    expect(referrers.map((reference) => reference.from).sort()).toEqual([
      'Project',
      'RecurringTask',
      'completeTask',
    ])
    const fromProject = referrers.find((reference) => reference.from === 'Project')!
    expect(fromProject).toMatchObject({ kind: 'attribute', via: 'tasks', array: true })
  })

  it('records the is-a edge as a parent reference, not an attribute one', () => {
    const edge = computeBacklinks(glossary).bySource['RecurringTask']!
    expect(edge).toEqual([
      { from: 'RecurringTask', to: 'Task', kind: 'parent', via: null, array: false },
    ])
  })

  it('reports references to terms that do not exist', () => {
    const withHole = [...glossary, term({ name: 'Orphan', attributes: [{ name: 'x', valueType: 'ref:Ghost' }] })]
    expect(computeBacklinks(withHole).dangling).toEqual([
      { from: 'Orphan', to: 'Ghost', kind: 'attribute', via: 'x', array: false },
    ])
  })

  it('ignores primitives entirely', () => {
    const primitivesOnly = [term({ name: 'A', attributes: [{ name: 'n', valueType: 'string[]' }] })]
    expect(computeBacklinks(primitivesOnly).references).toEqual([])
  })
})

describe('connectionsFor', () => {
  const backlinks = computeBacklinks(glossary)

  it('labels each connected term by how it connects', () => {
    expect(connectionsFor(backlinks, 'Task')).toEqual(
      new Map([
        ['Task', 'selected'],
        ['RecurringTask', 'child'],
        ['Project', 'referrer'],
        ['completeTask', 'referrer'],
      ]),
    )
  })

  it('prefers the is-a label when a term is both parent and referrer', () => {
    // Project references Task and Task references Project, so the pair is mutual;
    // RecurringTask's only edge to Task is is-a, and that is what should win.
    expect(connectionsFor(backlinks, 'Task').get('RecurringTask')).toBe('child')
  })

  it('always includes the term itself', () => {
    expect(connectionsFor(backlinks, 'completeTask').get('completeTask')).toBe('selected')
  })
})
