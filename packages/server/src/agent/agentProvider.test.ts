/**
 * The agent provider is a cache over buildAgents keyed by project. These pin what a per-turn run
 * depends on: the agents it hands back name *that* project in their prompt (so @spec is told which
 * glossary it works on), the same projectId returns the same instance (built once), and two projects
 * get two different agent sets — never one project's prompt leaking into another's turn.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { StoreProvider } from '../storeProvider.js'
import type { StoreChoice } from '../storeFactory.js'
import { AgentProvider } from './agentProvider.js'

function providerWith(projects: Record<string, { name: string; domain: string }>): AgentProvider {
  const root = mkdtempSync(path.join(os.tmpdir(), 'spectra-agents-'))
  for (const [id, info] of Object.entries(projects)) {
    const specs = path.join(root, id, 'specs')
    mkdirSync(specs, { recursive: true })
    writeFileSync(path.join(specs, 'project.json'), JSON.stringify(info))
  }
  const template: StoreChoice = { backend: 'fs', specsRoot: root, projectId: Object.keys(projects)[0]!, dbPath: ':memory:' }
  return new AgentProvider(new StoreProvider(template))
}

describe('AgentProvider', () => {
  it("names the project in the agents' prompt", async () => {
    const provider = providerWith({ alpha: { name: 'Alpha', domain: 'the alpha domain' } })
    const agents = await provider.agentsFor('alpha')
    expect(agents.spec.systemPrompt).toContain('Alpha')
    expect(agents.spec.systemPrompt).toContain('the alpha domain')
  })

  it('caches: the same projectId yields the very same agents instance', async () => {
    const provider = providerWith({ alpha: { name: 'Alpha', domain: 'a' } })
    expect(await provider.agentsFor('alpha')).toBe(await provider.agentsFor('alpha'))
  })

  it('builds a distinct, correctly-named set per project', async () => {
    const provider = providerWith({
      alpha: { name: 'Alpha', domain: 'a' },
      beta: { name: 'Beta', domain: 'b' },
    })
    const alpha = await provider.agentsFor('alpha')
    const beta = await provider.agentsFor('beta')
    expect(alpha).not.toBe(beta)
    expect(alpha.spec.systemPrompt).toContain('Alpha')
    expect(beta.spec.systemPrompt).toContain('Beta')
  })
})
