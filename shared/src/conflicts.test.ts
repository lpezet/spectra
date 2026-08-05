import { describe, expect, it } from 'vitest'
import { analyzePending } from './conflicts.js'
import type { PendingItem } from './conflicts.js'
import type { Term } from './types.js'

const TERMS: Term[] = [
  {
    name: 'Project',
    type: 'entity',
    spec: 'A named container for Tasks.',
    parent: null,
    tags: [],
    attributes: [
      { name: 'name', valueType: 'string' },
      { name: 'tasks', valueType: 'ref:Task[]' },
    ],
  },
  {
    name: 'Task',
    type: 'entity',
    spec: 'A single actionable item.',
    parent: null,
    tags: [],
    attributes: [
      { name: 'title', valueType: 'string' },
      { name: 'project', valueType: 'ref:Project' },
    ],
  },
]

const dropProject: PendingItem = {
  id: 'cs-003',
  kind: 'changeset',
  label: 'Drop Project',
  ops: [{ op: 'remove_entity', term: 'Project' }],
}

const archiveProject: PendingItem = {
  id: 'cs-002',
  kind: 'changeset',
  label: 'Archive a Project',
  ops: [{ op: 'add_attribute', term: 'Project', attribute: { name: 'archived', valueType: 'boolean' } }],
}

const addPriority: PendingItem = {
  id: 'cs-001',
  kind: 'changeset',
  label: 'Add priority',
  ops: [
    { op: 'add_entity', term: 'Priority', termType: 'attribute-type', spec: 'How urgent.' },
    { op: 'add_attribute', term: 'Task', attribute: { name: 'priority', valueType: 'ref:Priority' } },
  ],
}

describe('analyzePending', () => {
  it('reports an item that is clean on its own', () => {
    const report = analyzePending(TERMS, [addPriority])
    expect(report.items[0]!.diagnostics).toEqual([])
    expect(report.independent).toEqual(['cs-001'])
  })

  it('finds the conflict when a removal runs before something that needs the term', () => {
    const report = analyzePending(TERMS, [dropProject, archiveProject])
    const forward = report.conflicts.find((c) => c.first === 'cs-003' && c.second === 'cs-002')

    expect(forward).toBeDefined()
    expect(forward!.diagnostics[0]!.message).toMatch(/"Project" does not exist/)
  })

  it('reports the order that works as clean — which is the actual advice', () => {
    const report = analyzePending(TERMS, [dropProject, archiveProject])
    expect(report.conflicts.find((c) => c.first === 'cs-002' && c.second === 'cs-003')).toBeUndefined()
  })

  it('does not blame a pair for a problem either one already had alone', () => {
    // cs-003 orphans Task.project on its own; pairing it with an unrelated item must not
    // re-report that as though the combination caused it.
    const report = analyzePending(TERMS, [dropProject, addPriority])
    expect(report.items.find((item) => item.id === 'cs-003')!.diagnostics).not.toEqual([])
    expect(report.conflicts).toEqual([])
  })

  it('leaves genuinely unrelated items independent even when they share a term', () => {
    const renameSpec: PendingItem = {
      id: 'cs-004',
      kind: 'changeset',
      label: 'Reword Task',
      ops: [{ op: 'modify_spec', term: 'Task', spec: 'Reworded.' }],
    }

    const report = analyzePending(TERMS, [addPriority, renameSpec])
    expect(report.conflicts).toEqual([])
    expect(report.independent.sort()).toEqual(['cs-001', 'cs-004'])
  })

  it('marks both sides of a conflict as entangled', () => {
    const report = analyzePending(TERMS, [dropProject, archiveProject, addPriority])
    expect(report.independent).toEqual(['cs-001'])
  })

  it('catches a question option that depends on a term another item removes', () => {
    const specCreation: PendingItem = {
      id: 'q-001:Spec them',
      kind: 'question-option',
      label: 'Spec them',
      ops: [
        {
          op: 'add_entity',
          term: 'createTask',
          termType: 'function',
          spec: 'Creates a Task.',
          attributes: [{ name: 'project', valueType: 'ref:Project' }],
        },
      ],
    }

    const report = analyzePending(TERMS, [dropProject, specCreation])
    const conflict = report.conflicts.find((c) => c.first === 'cs-003')

    expect(conflict).toBeDefined()
    expect(conflict!.diagnostics[0]!.message).toMatch(/createTask\.project references "Project"/)
  })

  it('does not pit two options of the same question against each other', () => {
    const options: PendingItem[] = ['Stays done', 'Reopens'].map((label) => ({
      id: `q-002:${label}`,
      kind: 'question-option' as const,
      label,
      ops: [{ op: 'modify_spec' as const, term: 'Task', spec: label }],
    }))

    const report = analyzePending(TERMS, options)
    expect(report.conflicts).toEqual([])
  })
})
