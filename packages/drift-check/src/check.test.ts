/**
 * The pure check across its cases, and the file-reading pair (`readMarkers`/`driftCheck`) against a
 * temp fixture tree — created and cleaned per test, so nothing depends on a real project.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDrift, driftCheck } from './check.js'
import { readMarkers, readVerifyMarkers } from './implements.js'
import type { Marker, Snapshot, VerifyMarker } from './implements.js'

const marker = (file: string, terms: string[], malformed: string[] = []): Marker => ({ file, line: 1, terms, malformed })
const vmarker = (file: string, ids: string[], malformed: string[] = []): VerifyMarker => ({ file, line: 1, ids, malformed })
const snapshot = (
  terms: Array<{ name: string; type: string }>,
  expectations: Array<{ id: string; kind: string }> = [],
): Snapshot => ({
  version: 'v1',
  terms: terms.map((t) => ({ ...t, hash: 'h' })),
  expectations: expectations.map((e) => ({ ...e, hash: 'h' })),
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

describe('checkDrift · expectations (verifies)', () => {
  const clean = { markers: [marker('task.ts', ['Task'])], snap: snapshot([{ name: 'Task', type: 'entity' }]) }

  it('is clean when every functional expectation has a verifies marker', () => {
    const snap = snapshot([{ name: 'Task', type: 'entity' }], [{ id: 'e-001', kind: 'functional' }])
    const findings = checkDrift(clean.markers, snap, [vmarker('task.test.ts', ['e-001'])])
    expect(findings).toEqual([])
  })

  it('flags a functional expectation nothing verifies', () => {
    const snap = snapshot([{ name: 'Task', type: 'entity' }], [{ id: 'e-001', kind: 'functional' }])
    const findings = checkDrift(clean.markers, snap, [])
    expect(findings.some((f) => f.kind === 'unverified-expectation' && f.message.includes('e-001'))).toBe(true)
  })

  it('does not flag a non-functional expectation (checked by driving a build, not a test)', () => {
    const snap = snapshot([{ name: 'Task', type: 'entity' }], [{ id: 'e-009', kind: 'non-functional' }])
    const findings = checkDrift(clean.markers, snap, [])
    expect(findings.some((f) => f.kind === 'unverified-expectation')).toBe(false)
  })

  it('flags a verifies marker naming an expectation the glossary does not have', () => {
    const snap = snapshot([{ name: 'Task', type: 'entity' }], [{ id: 'e-001', kind: 'functional' }])
    const findings = checkDrift(clean.markers, snap, [vmarker('task.test.ts', ['e-001', 'e-999'])])
    expect(findings.some((f) => f.kind === 'unknown-expectation' && f.message.includes('e-999'))).toBe(true)
    expect(findings.some((f) => f.kind === 'unverified-expectation')).toBe(false) // e-001 is verified
  })

  it('flags a malformed verifies marker', () => {
    const snap = snapshot([{ name: 'Task', type: 'entity' }], [{ id: 'e-001', kind: 'functional' }])
    const findings = checkDrift(clean.markers, snap, [vmarker('task.test.ts', ['e-001'], ['not an id'])])
    expect(findings.some((f) => f.kind === 'malformed-marker' && f.message.includes('not an id'))).toBe(true)
  })

  it('treats a snapshot exported before expectations existed as having none', () => {
    const snap: Snapshot = { version: 'v1', terms: [{ name: 'Task', type: 'entity', hash: 'h' }] } // no `expectations`
    // A verifies marker then names something unknown, and there is nothing to be unverified.
    const findings = checkDrift(clean.markers, snap, [vmarker('task.test.ts', ['e-001'])])
    expect(findings.map((f) => f.kind)).toEqual(['unknown-expectation'])
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

  it('reads verifies markers from test files (unlike implements), and passes them to the check', () => {
    const src = path.join(dir, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'task.test.ts'), '// verifies: e-001, e-002\nit("x", () => {})\n')
    writeFileSync(path.join(src, 'other.ts'), '// verifies: e-003\n')
    writeFileSync(path.join(src, 'bad.test.ts'), '// verifies: not an id\n')

    const ids = readVerifyMarkers(src).flatMap((m) => m.ids)
    expect(ids).toContain('e-001') // from a .test.ts — read, not skipped
    expect(ids).toContain('e-002')
    expect(ids).toContain('e-003')
    expect(readVerifyMarkers(src).some((m) => m.malformed.length > 0)).toBe(true)
  })

  it('driftCheck end-to-end: a functional expectation verified by a test in the tree is clean, unverified otherwise', () => {
    const src = path.join(dir, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'task.ts'), '// implements: Task\n')
    const snapPath = path.join(dir, 'specs.snapshot.json')
    writeFileSync(snapPath, JSON.stringify(snapshot([{ name: 'Task', type: 'entity' }], [{ id: 'e-001', kind: 'functional' }])))

    // No verifying test yet → the functional expectation is flagged.
    let result = driftCheck({ srcDir: src, snapshotPath: snapPath })
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.kind === 'unverified-expectation' && f.message.includes('e-001'))).toBe(true)

    // Add the verifying test → clean.
    writeFileSync(path.join(src, 'task.test.ts'), '// verifies: e-001\nit("completeTask …", () => {})\n')
    result = driftCheck({ srcDir: src, snapshotPath: snapPath })
    expect(result).toEqual({ ok: true, findings: [] })
  })
})
