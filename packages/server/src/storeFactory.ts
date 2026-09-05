/**
 * How the composition root picks a storage backend.
 *
 * Both backends satisfy {@link SpecStore} and both scope to one project — `FileSystemSpecStore(root,
 * projectId)` over `<root>/<projectId>/specs`, `SqlSpecStore(db, projectId)` over rows filtered by
 * `project_id`. This module is the one place that chooses between them from configuration, so the
 * rest of the server never knows which it got. It is deliberately two small pieces: `resolveStoreChoice`
 * is pure (env is a parameter) so the decision is testable, and `buildSpecStore` is the thin
 * constructor call that actually touches the world.
 *
 * `SPEC_STORE` selects the backend (`fs` default, or `sql`). The project a request is for is, for now,
 * a configured value — derived from the `SPECS_DIR` path (which is `<root>/<projectId>/specs`) or set
 * explicitly with `PROJECT_ID`. A hosted deployment resolves it per request from auth instead; the
 * store shapes are already ready for that.
 */
import path from 'node:path'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'
import type { SpecStore } from './specStore.js'
import { SqlSpecStore } from './sqlSpecStore.js'

export type Backend = 'fs' | 'sql'

export interface StoreChoice {
  backend: Backend
  /** FS: the dir that can hold many projects' glossaries (`<root>/<projectId>/specs`). */
  specsRoot: string
  projectId: string
  /** SQL: the SQLite file (one DB, many projects). */
  dbPath: string
}

/** Decide the store from env plus the resolved SPECS_DIR / DATA_DIR. Pure, so it is unit-tested. */
export function resolveStoreChoice(
  env: Record<string, string | undefined>,
  specsDir: string,
  dataDir: string,
): StoreChoice {
  // SPECS_DIR is `<root>/<projectId>/specs` — the same split FileSystemSpecStore takes.
  const projectDir = path.dirname(specsDir)
  return {
    backend: env.SPEC_STORE === 'sql' ? 'sql' : 'fs',
    specsRoot: path.dirname(projectDir),
    projectId: env.PROJECT_ID ?? path.basename(projectDir),
    dbPath: env.SPEC_DB ?? path.join(dataDir, 'spec.db'),
  }
}

/** Construct the chosen backend. The rest of the server sees only the {@link SpecStore} interface. */
export function buildSpecStore(choice: StoreChoice): SpecStore {
  return choice.backend === 'sql'
    ? new SqlSpecStore(choice.dbPath, choice.projectId)
    : new FileSystemSpecStore(choice.specsRoot, choice.projectId)
}
