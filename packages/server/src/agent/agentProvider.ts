/**
 * One set of agents per project, built on demand and reused.
 *
 * `buildAgents(projectInfo)` bakes the project's identity into the shared system prompt — the
 * agents are told which glossary they are working on. With one project that was a boot-time
 * singleton; with a project resolved per turn it has to be per project, so this is the agents'
 * equivalent of {@link StoreProvider}: give it a projectId, get the agents whose prompt names that
 * project, built once and cached.
 *
 * Reading the identity is a store read (`projectInfo()`), so this is async where the store provider
 * is not. It is cached because the identity is config — a change to project.json takes effect on
 * restart, the same contract the boot-time build had — so building the agents once per project is
 * not a staleness risk, it is the same freshness the single build always had.
 */
import { buildAgents } from './agents.js'
import type { AgentDefinition, AgentName } from './agents.js'
import type { SpecStoreBackend } from '../backend.js'

export class AgentProvider {
  private readonly cache = new Map<string, Record<AgentName, AgentDefinition>>()

  constructor(private readonly provider: SpecStoreBackend) {}

  /** The agents for a project — prompt named for it, built once from its identity, then reused. */
  async agentsFor(projectId: string): Promise<Record<AgentName, AgentDefinition>> {
    let agents = this.cache.get(projectId)
    if (!agents) {
      agents = buildAgents(await this.provider.storeFor(projectId).projectInfo())
      this.cache.set(projectId, agents)
    }
    return agents
  }
}
