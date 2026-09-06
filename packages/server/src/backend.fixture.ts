/**
 * A stand-in plugin backend for backend.test.ts — the shape a real out-of-repo backend (Postgres,
 * a networked store, …) would export. Not a test itself; loaded by specifier the way `resolveBackend`
 * loads a real one, so the test proves the plugin path end to end (import → factory → context).
 */
import type { BackendContext, SpecStoreBackend } from './backend.js'
import type { SpecStore } from './specStore.js'

export function createSpecStoreBackend(context: BackendContext): SpecStoreBackend {
  return {
    defaultProjectId: context.defaultProjectId,
    storeFor: (projectId: string) => ({ __fixtureProjectId: projectId }) as unknown as SpecStore,
    // Echoes the context back so the test can prove env + dataDir reached the plugin.
    listProjects: async () => [
      { id: 'from-plugin', name: `opt:${context.env.MY_PLUGIN_OPT ?? ''}`, domain: context.dataDir },
    ],
  }
}
