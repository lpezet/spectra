/**
 * One store per project, built on demand and reused.
 *
 * The composition root used to build a single {@link SpecStore} at boot and thread it into every
 * route. That is exactly right for one project and wrong for a server that resolves the project
 * *per request* — a hosted deployment, or a solo dev with several projects in one running server.
 * The provider is the seam between the two: the backend (filesystem root, or SQL db path) is fixed
 * for the deployment; only the `projectId` varies per request, and this hands back the store for it.
 *
 * Cached in a `Map<projectId, SpecStore>` because a store is a *connection*, not a request: a SQL
 * backend opens its handle once per project and reuses it across every request for that project;
 * the filesystem backend is cheap either way. The cache is unbounded on purpose — the set of
 * projects a deployment serves is small and long-lived, not per-request churn — and lives for the
 * life of the process, the same lifetime the single boot-time store had.
 *
 * Who decides *which* project a request is for lives above this (the resolver in the request
 * chain); the provider only turns a decided `projectId` into the store for it. For now that
 * resolver yields the one configured project ({@link StoreProvider.defaultProjectId}); the URL
 * org/project prefix replaces the source without the provider changing.
 */
import { buildSpecStore } from './storeFactory.js'
import type { StoreChoice } from './storeFactory.js'
import type { SpecStore } from './specStore.js'

export class StoreProvider {
  private readonly cache = new Map<string, SpecStore>()

  /** `template` fixes the backend and its location; its `projectId` is the default project. */
  constructor(private readonly template: StoreChoice) {}

  /** The store for a project — built once, then reused for the life of the process. */
  storeFor(projectId: string): SpecStore {
    let store = this.cache.get(projectId)
    if (!store) {
      store = buildSpecStore({ ...this.template, projectId })
      this.cache.set(projectId, store)
    }
    return store
  }

  /** The single project this deployment is configured for, until the resolver reads it per request. */
  get defaultProjectId(): string {
    return this.template.projectId
  }
}
