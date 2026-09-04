import { describe, expect, it } from 'vitest'
import { applyOps, hasErrors, summarizeOp } from './changeset.js'
import type { Op, Term } from './types.js'

function term(partial: Partial<Term> & { name: string }): Term {
  return { type: 'entity', spec: '', parent: null, tags: [], attributes: [], ...partial }
}

const glossary: Term[] = [
  term({ name: 'Project', attributes: [{ name: 'tasks', valueType: 'ref:Task[]' }] }),
  term({
    name: 'Task',
    spec: 'A single actionable item.',
    attributes: [
      { name: 'title', valueType: 'string' },
      { name: 'project', valueType: 'ref:Project' },
    ],
  }),
]

const byName = (terms: Term[], name: string) => terms.find((t) => t.name === name)

describe('applyOps — individual ops', () => {
  it('adds a term, defaulting its type to entity', () => {
    const { terms, diagnostics } = applyOps(glossary, [
      { op: 'add_entity', term: 'Label', spec: 'A colour-coded marker.' },
    ])
    expect(diagnostics).toEqual([])
    expect(byName(terms, 'Label')).toEqual(
      term({ name: 'Label', spec: 'A colour-coded marker.' }),
    )
  })

  it('adds a term of a non-entity kind when termType is given', () => {
    const { terms } = applyOps(glossary, [
      { op: 'add_entity', term: 'Priority', termType: 'attribute-type', spec: 'How urgent.' },
    ])
    expect(byName(terms, 'Priority')!.type).toBe('attribute-type')
  })

  it('refuses to add a term that already exists', () => {
    const { diagnostics } = applyOps(glossary, [{ op: 'add_entity', term: 'Task', spec: 'dup' }])
    expect(diagnostics).toEqual([
      { opIndex: 0, severity: 'error', message: '"Task" already exists.' },
    ])
  })

  it('adds and removes attributes', () => {
    const added = applyOps(glossary, [
      { op: 'add_attribute', term: 'Task', attribute: { name: 'done', valueType: 'boolean' } },
    ])
    expect(byName(added.terms, 'Task')!.attributes.map((a) => a.name)).toEqual([
      'title',
      'project',
      'done',
    ])

    const removed = applyOps(glossary, [
      { op: 'remove_attribute', term: 'Task', attribute: 'title' },
    ])
    expect(byName(removed.terms, 'Task')!.attributes.map((a) => a.name)).toEqual(['project'])
  })

  it('reports duplicate and missing attributes', () => {
    expect(
      applyOps(glossary, [
        { op: 'add_attribute', term: 'Task', attribute: { name: 'title', valueType: 'string' } },
      ]).diagnostics[0]!.message,
    ).toContain('already has an attribute named "title"')

    expect(
      applyOps(glossary, [{ op: 'remove_attribute', term: 'Task', attribute: 'nope' }])
        .diagnostics[0]!.message,
    ).toContain('has no attribute named "nope"')
  })

  it('reports ops targeting a term that does not exist', () => {
    const ops: Op[] = [
      { op: 'modify_spec', term: 'Ghost', spec: 'x' },
      { op: 'remove_entity', term: 'Ghost' },
      { op: 'add_attribute', term: 'Ghost', attribute: { name: 'a', valueType: 'string' } },
    ]
    const { diagnostics } = applyOps(glossary, ops)
    expect(diagnostics).toHaveLength(3)
    expect(diagnostics.every((d) => d.message === '"Ghost" does not exist.')).toBe(true)
  })

  it('rewrites a spec', () => {
    const { terms } = applyOps(glossary, [
      { op: 'modify_spec', term: 'Task', spec: 'Rewritten.' },
    ])
    expect(byName(terms, 'Task')!.spec).toBe('Rewritten.')
  })

  it('never mutates the input glossary', () => {
    applyOps(glossary, [
      { op: 'add_attribute', term: 'Task', attribute: { name: 'done', valueType: 'boolean' } },
      { op: 'remove_entity', term: 'Project' },
    ])
    expect(glossary.map((t) => t.name)).toEqual(['Project', 'Task'])
    expect(byName(glossary, 'Task')!.attributes).toHaveLength(2)
  })
})

describe('applyOps — op ordering and dependencies', () => {
  const dependent: Op[] = [
    { op: 'add_entity', term: 'Priority', termType: 'attribute-type', spec: 'How urgent.' },
    {
      op: 'add_attribute',
      term: 'Task',
      attribute: { name: 'priority', valueType: 'ref:Priority' },
    },
  ]

  it('accepts the full changeset', () => {
    const { diagnostics, terms } = applyOps(glossary, dependent)
    expect(diagnostics).toEqual([])
    expect(byName(terms, 'Task')!.attributes.at(-1)!.valueType).toBe('ref:Priority')
  })

  it('blocks a cherry-pick that leaves its dependency behind', () => {
    const { diagnostics } = applyOps(glossary, [dependent[1]!])
    expect(hasErrors(diagnostics)).toBe(true)
    expect(diagnostics[0]).toMatchObject({ opIndex: 0, severity: 'error' })
    expect(diagnostics[0]!.message).toContain('Task.priority references "Priority"')
    expect(diagnostics[0]!.message).toContain('not part of this selection')
  })

  it('blocks an added term whose parent is not being created', () => {
    const { diagnostics } = applyOps(glossary, [
      { op: 'add_entity', term: 'Chore', parent: 'Habit', spec: 'x' },
    ])
    expect(diagnostics[0]).toMatchObject({ opIndex: 0, severity: 'error' })
    expect(diagnostics[0]!.message).toContain("Chore's parent references \"Habit\"")
  })
})

describe('applyOps — orphaned references', () => {
  it('warns rather than errors when a removal orphans an existing reference', () => {
    const { diagnostics } = applyOps(glossary, [{ op: 'remove_entity', term: 'Project' }])
    expect(hasErrors(diagnostics)).toBe(false)
    expect(diagnostics).toEqual([
      {
        opIndex: null,
        severity: 'warning',
        message: 'Task.project references "Project", which this change removes.',
      },
    ])
  })

  it('warns when removing an attribute is not enough to keep the glossary whole', () => {
    // Removing Task leaves Project.tasks pointing nowhere.
    const { diagnostics } = applyOps(glossary, [{ op: 'remove_entity', term: 'Task' }])
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Project.tasks references "Task", which this change removes.',
    ])
  })

  it('stays silent about references that were already dangling', () => {
    const alreadyBroken = [
      ...glossary,
      term({ name: 'Note', attributes: [{ name: 'author', valueType: 'ref:User' }] }),
    ]
    const { diagnostics } = applyOps(alreadyBroken, [
      { op: 'modify_spec', term: 'Task', spec: 'unrelated edit' },
    ])
    expect(diagnostics).toEqual([])
  })

  it('is clean when the removal takes the referrer with it', () => {
    const { diagnostics } = applyOps(glossary, [
      { op: 'remove_entity', term: 'Project' },
      { op: 'remove_attribute', term: 'Task', attribute: 'project' },
    ])
    expect(diagnostics).toEqual([])
  })
})

describe('applyOps — effects', () => {
  it('records the target term before and after each op', () => {
    const { effects } = applyOps(glossary, [
      { op: 'modify_spec', term: 'Task', spec: 'Rewritten.' },
      { op: 'remove_entity', term: 'Task' },
    ])
    expect(effects[0]).toMatchObject({ index: 0, kind: 'modify', term: 'Task', ok: true })
    expect(effects[0]!.before!.spec).toBe('A single actionable item.')
    expect(effects[0]!.after!.spec).toBe('Rewritten.')
    expect(effects[1]).toMatchObject({ kind: 'remove', ok: true, after: null })
  })

  it('leaves the state unchanged for a failed op', () => {
    const { effects } = applyOps(glossary, [{ op: 'modify_spec', term: 'Ghost', spec: 'x' }])
    expect(effects[0]).toMatchObject({ ok: false, before: null, after: null })
  })
})

describe('summarizeOp', () => {
  it('renders each op as one readable line', () => {
    expect(
      summarizeOp({ op: 'add_entity', term: 'Priority', termType: 'attribute-type', spec: '' }),
    ).toBe('add attribute-type Priority')
    expect(summarizeOp({ op: 'add_entity', term: 'Chore', parent: 'Task', spec: '' })).toBe(
      'add entity Chore (is-a Task)',
    )
    expect(
      summarizeOp({
        op: 'add_attribute',
        term: 'Task',
        attribute: { name: 'priority', valueType: 'ref:Priority' },
      }),
    ).toBe('add Task.priority: ref:Priority')
    expect(summarizeOp({ op: 'remove_attribute', term: 'Task', attribute: 'dueDate' })).toBe(
      'remove Task.dueDate',
    )
    expect(summarizeOp({ op: 'remove_entity', term: 'Project' })).toBe('remove Project')
    expect(summarizeOp({ op: 'modify_spec', term: 'Task', spec: '' })).toBe(
      'rewrite the spec of Task',
    )
  })
})
