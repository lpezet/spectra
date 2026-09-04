/**
 * projectInfo() is the store's answer to "who is this glossary" — read from specs/project.json by
 * the filesystem backend, and the source the agent prompt and the UI title both template from.
 *
 * Two things matter and are checked here: a valid file comes back verbatim, and anything the store
 * cannot read (missing, non-JSON, wrong shape) degrades to a neutral default rather than throwing —
 * a bad hand-edit must not take down the server or hand the agents a half-parsed identity. The
 * default is deliberately generic so an unconfigured glossary never borrows another project's name.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import { buildAgents } from './agent/agents.js'

let specs: string

beforeEach(async () => {
  specs = await mkdtemp(path.join(tmpdir(), 'tb-project-'))
})

describe('FileSystemSpecStore.projectInfo', () => {
  it('reads name and domain from specs/project.json', async () => {
    await writeFile(
      path.join(specs, 'project.json'),
      JSON.stringify({ name: 'Todo Blueprints', domain: 'a ToDo app' }),
    )
    const info = await new FileSystemSpecStore(specs).projectInfo()
    expect(info).toEqual({ name: 'Todo Blueprints', domain: 'a ToDo app' })
  })

  it('falls back to a neutral default when the file is absent', async () => {
    const info = await new FileSystemSpecStore(specs).projectInfo()
    expect(info.name).toBe('Untitled project')
    // The fallback must not smuggle a real project's identity back in.
    expect(info.name).not.toMatch(/todo/i)
  })

  it('falls back rather than throwing when the file is not valid JSON', async () => {
    await writeFile(path.join(specs, 'project.json'), '{ not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = await new FileSystemSpecStore(specs).projectInfo()
    expect(info.name).toBe('Untitled project')
  })

  it('falls back when the JSON is the wrong shape', async () => {
    await writeFile(path.join(specs, 'project.json'), JSON.stringify({ name: 'X' })) // no domain
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = await new FileSystemSpecStore(specs).projectInfo()
    expect(info.name).toBe('Untitled project')
  })
})

describe('buildAgents', () => {
  it('names the project and its domain in the shared prompt of both agents', () => {
    const agents = buildAgents({ name: 'Acme Specs', domain: 'a billing system' })
    for (const agent of [agents.spec, agents.coder]) {
      expect(agent.systemPrompt).toContain('Acme Specs')
      expect(agent.systemPrompt).toContain('a billing system')
      // The old hardcoded identity is gone.
      expect(agent.systemPrompt).not.toContain('todo-blueprints')
    }
  })
})
