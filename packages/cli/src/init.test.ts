/**
 * init's planning is pure (planInit) and its flag parsing is pure (parseInitArgs), so both are
 * tested here without touching the filesystem. What matters: the three files land in the three
 * right homes (repo link, server-side glossary, config override), the glossary is NOT in the repo,
 * and @coder's mount follows --dir.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type InitInput, parseInitArgs, planInit } from './init.js'

const base: InitInput = {
  repoDir: '/home/u/myrepo',
  name: 'Acme',
  domain: 'a billing system',
  configHome: '/home/u/.config',
  dataHome: '/home/u/.local/share',
  id: 'myrepo-abc123',
}

const fileAt = (plan: ReturnType<typeof planInit>, suffix: string) =>
  plan.files.find((f) => f.path.endsWith(suffix))

describe('planInit', () => {
  it('writes the link into the repo, the glossary + override outside it', () => {
    const plan = planInit(base)
    expect(fileAt(plan, '.spectra/config.json')?.path).toBe('/home/u/myrepo/.spectra/config.json')
    // The glossary is the server's, under the data home — never in the repo.
    expect(plan.glossaryDir).toBe('/home/u/.local/share/spectra/projects/myrepo-abc123/specs')
    expect(plan.glossaryDir.startsWith('/home/u/myrepo')).toBe(false)
    expect(plan.overridePath).toBe('/home/u/.config/spectra/projects/myrepo-abc123/compose.yaml')
  })

  it('plans the data dir so it is created (user-owned) before docker makes it root at up', () => {
    const plan = planInit(base)
    // The override mounts this into /stack/data; if it does not exist, docker creates it root-owned
    // and the non-root spec container cannot open its transcripts DB.
    expect(plan.dirs).toContain('/home/u/.local/share/spectra/projects/myrepo-abc123/data')
    const yaml = fileAt(plan, 'compose.yaml')!.content
    expect(yaml).toContain(`${plan.dirs[0]}:/stack/data`)
  })

  it('seeds identity into the glossary project.json and the link', () => {
    const plan = planInit(base)
    expect(JSON.parse(fileAt(plan, 'specs/project.json')!.content)).toEqual({
      name: 'Acme',
      domain: 'a billing system',
    })
    const link = JSON.parse(fileAt(plan, '.spectra/config.json')!.content)
    expect(link).toMatchObject({ id: 'myrepo-abc123', name: 'Acme', domain: 'a billing system', server: null })
  })

  it('mounts the repo root by default, or a subdir with coderDir', () => {
    expect(planInit(base).coderMount).toBe('/home/u/myrepo')
    expect(planInit({ ...base, coderDir: '.' }).coderMount).toBe('/home/u/myrepo')
    expect(planInit({ ...base, coderDir: 'services/api' }).coderMount).toBe('/home/u/myrepo/services/api')
  })

  it('templates the override with the project name, mounts, SPECS_DIR, and the coder project', () => {
    const yaml = fileAt(planInit(base), 'compose.yaml')!.content
    expect(yaml).toContain('name: spectra-myrepo-abc123')
    // Mounted and named under the project id so the server derives projectId `myrepo-abc123`.
    expect(yaml).toContain(`${path.join('/home/u/.local/share/spectra/projects/myrepo-abc123/specs')}:/stack/myrepo-abc123/specs`)
    expect(yaml).toContain('/home/u/myrepo:/work/project')
    expect(yaml).toContain('SPECS_DIR=/stack/myrepo-abc123/specs')
    // The coder carries the same id, so its per-project MCP URL matches the spec's project.
    expect(yaml).toContain('PROJECT_ID=myrepo-abc123')
  })
})

describe('parseInitArgs', () => {
  it('parses name + domain, with optional dir/server/force/dry-run', () => {
    expect(parseInitArgs(['--name', 'Acme', '--domain', 'billing'])).toEqual({
      kind: 'ok',
      options: { name: 'Acme', domain: 'billing', coderDir: undefined, server: undefined, force: false, dryRun: false },
    })
    expect(
      parseInitArgs(['--name', 'A', '--domain', 'b', '--dir', 'api', '--server', 'http://x', '--force', '--dry-run']),
    ).toMatchObject({ kind: 'ok', options: { coderDir: 'api', server: 'http://x', force: true, dryRun: true } })
  })

  it('leaves name and domain undefined when omitted (caller defaults to the folder name)', () => {
    expect(parseInitArgs([])).toEqual({
      kind: 'ok',
      options: { name: undefined, domain: undefined, coderDir: undefined, server: undefined, force: false, dryRun: false },
    })
    expect(parseInitArgs(['--name', 'A'])).toMatchObject({ kind: 'ok', options: { name: 'A', domain: undefined } })
  })

  it('help and unknown/valueless flags', () => {
    expect(parseInitArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseInitArgs(['--name'])).toMatchObject({ kind: 'error' })
    expect(parseInitArgs(['--wat', 'x'])).toMatchObject({ kind: 'error' })
  })
})
