import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// store.ts resolves SPECS_DIR at module load, so the sandbox has to exist and be pointed
// at before anything imports it — hence the dynamic import below.
let specs: string
let raiseQuestion: typeof import('./raise.js').raiseQuestion

beforeAll(async () => {
  specs = await mkdtemp(path.join(tmpdir(), 'tb-raise-'))
  await mkdir(path.join(specs, 'terms'), { recursive: true })
  await mkdir(path.join(specs, 'questions'), { recursive: true })
  await writeFile(
    path.join(specs, 'terms', 'task.json'),
    JSON.stringify({ name: 'Task', type: 'entity', spec: 'A task.', parent: null, tags: [], attributes: [] }),
  )
  process.env.SPECS_DIR = specs
  ;({ raiseQuestion } = await import('./raise.js'))
})

const BASE = {
  asks: 'Can a Task move between Projects?',
  because: 'Task.project is declared as a single ref:Project and no function changes it.',
  pass: 'implementation',
  terms: ['Task'],
}

async function questionFiles(): Promise<string[]> {
  return (await readdir(path.join(specs, 'questions'))).sort()
}

describe('raiseQuestion', () => {
  it('writes a question with no options — some can only be answered in prose', async () => {
    const outcome = await raiseQuestion({ ...BASE, options: [] })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.id).toBe('q-001')

    const written = JSON.parse(await readFile(path.join(specs, 'questions', outcome.file), 'utf8'))
    expect(written.answer).toBeNull()
    expect(written.raisedBy).toEqual({ pass: 'implementation', terms: ['Task'] })
  })

  it('numbers the next question above the highest already there', async () => {
    const second = await raiseQuestion({ ...BASE, asks: 'Second question?', options: [] })
    expect(second.ok && second.id).toBe('q-002')
  })

  it('names the file from the id and the question', async () => {
    const outcome = await raiseQuestion({ ...BASE, asks: 'Should a Task have an owner?', options: [] })
    expect(outcome.ok && outcome.file).toMatch(/^q-003-should-a-task-have-an-owner\.json$/)
  })

  it('keeps a proposal on an option and defaults the others to null', async () => {
    const outcome = await raiseQuestion({
      ...BASE,
      asks: 'Add an owner?',
      options: [
        {
          label: 'Add it',
          proposal: {
            summary: 'Add Task.owner',
            ops: [{ op: 'add_attribute', term: 'Task', attribute: { name: 'owner', valueType: 'string' } }],
            tests: ['a Task can carry an owner'],
          },
        },
        { label: 'Leave it out' },
      ],
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.question.options[0]!.proposal!.ops).toHaveLength(1)
    expect(outcome.question.options[1]!.proposal).toBeNull()
  })

  it('refuses a proposal with an invalid valueType instead of writing it', async () => {
    const before = await questionFiles()
    const outcome = await raiseQuestion({
      ...BASE,
      asks: 'Bad op?',
      options: [
        {
          label: 'Broken',
          proposal: {
            summary: 'Bare term name where a ref belongs',
            ops: [{ op: 'add_attribute', term: 'Task', attribute: { name: 'x', valueType: 'Project' } }],
            tests: [],
          },
        },
      ],
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/ref:Project/)
    expect(await questionFiles()).toEqual(before)
  })

  it('never overwrites an existing file when two questions collide on a name', async () => {
    const first = await raiseQuestion({ ...BASE, asks: 'Same wording', options: [] })
    const second = await raiseQuestion({ ...BASE, asks: 'Same wording', options: [] })

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.file).not.toBe(first.file)
    expect(second.id).not.toBe(first.id)
  })
})
