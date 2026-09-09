/**
 * The pure check across its cases, and the file-reading pair (`readMarkers`/`driftCheck`) against a
 * temp fixture tree — created and cleaned per test, so nothing depends on a real project.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDrift, driftCheck } from './check.js'
import { readMarkers } from './implements.js'
import type { Marker, Snapshot } from './implements.js'

const marker = (file: string, terms: string[], malformed: string[] = []): Marker => ({ file, line: 1, terms, malformed })
const snapshot = (terms: Array<{ name: string; type: string }>): Snapshot => ({
  version: 'v1',
  terms: terms.map((t) => ({ ...t, hash: 'h' })),
})

describe('checkDrift', () => {
  it('is clean when every needed term is implemented and every marker is known', () => {
    const snap = snapshot([{ name: 'Task', type: 'entity' }, { name: 'createTask', type: 'function' }])
    const markers = [marker('task.ts', ['Task']), marker('create.ts', ['createTask'])]
    expect(checkDrift(markers, snap)).toEqual([])
  })

  it('reports a missing snapshot as the one finding (fails hard, does not skip)', () => {
    expect(checkDrift([marker('a.ts', ['Task'])], null)).toEqual([{ kind: 'no-snapshot', message: expect.stringContaining('export_specs') }])
  })

  it('flags no markers at all', () => {
    expect(checkDrift([], snapshot([{ name: 'X', type: 'attribute-type' }])).map((f) => f.kind)).toEqual(['no-markers'])
  })

  it('flags a malformed marker', () => {
    const findings = checkDrift([marker('a.ts', ['Task'], ['a task'])], snapshot([{ name: 'Task', type: 'entity' }]))
    expect(findings.map((f) => f.kind)).toContain('malformed-marker')
  })

  it('flags a marker naming a term the glossary does not have', () => {
    const findings = checkDrift([marker('a.ts', ['Ghost'])], snapshot([{ name: 'Task', type: 'entity' }]))
    expect(findings.some((f) => f.kind === 'unknown-term' && f.message.includes('Ghost'))).toBe(true)
  })

  it('flags an unimplemented entity/function/event, but not an attribute-type', () => {
    const snap = snapshot([
      { name: 'Task', type: 'entity' },
      { name: 'Priority', type: 'attribute-type' },
    ])
    const findings = checkDrift([], snap) // no markers → Task unimplemented; Priority exempt; plus no-markers
    const unimplemented = findings.filter((f) => f.kind === 'unimplemented-term').map((f) => f.message)
    expect(unimplemented.some((m) => m.includes('Task'))).toBe(true)
    expect(unimplemented.some((m) => m.includes('Priority'))).toBe(false)
  })
})

describe('readMarkers + driftCheck on files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'drift-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads markers from source files, recursing and skipping tests', () => {
    const src = path.join(dir, 'src')
    mkdirSync(path.join(src, 'domain'), { recursive: true })
    writeFileSync(path.join(src, 'domain', 'task.ts'), '// implements: Task, createTask\nexport const x = 1\n')
    writeFileSync(path.join(src, 'task.test.ts'), '// implements: ShouldBeIgnored\n')
    writeFileSync(path.join(src, 'bad.ts'), '// implements: not an identifier\n')

    const markers = readMarkers(src)
    const all = markers.flatMap((m) => m.terms)
    expect(all).toContain('Task')
    expect(all).toContain('createTask')
    expect(all).not.toContain('ShouldBeIgnored') // .test.ts excluded
    expect(markers.some((m) => m.malformed.length > 0)).toBe(true) // "not an identifier"
  })

  it('driftCheck: clean when snapshot + markers agree; no-snapshot when the file is absent', () => {
    const src = path.join(dir, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'task.ts'), '// implements: Task\n')
    const snapPath = path.join(dir, 'specs.snapshot.json')

    expect(driftCheck({ srcDir: src, snapshotPath: snapPath })).toEqual({ ok: false, findings: [{ kind: 'no-snapshot', message: expect.any(String) }] })

    writeFileSync(snapPath, JSON.stringify(snapshot([{ name: 'Task', type: 'entity' }])))
    expect(driftCheck({ srcDir: src, snapshotPath: snapPath })).toEqual({ ok: true, findings: [] })
  })
})
