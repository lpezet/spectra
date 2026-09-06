/**
 * The storage backend as a plugin boundary.
 *
 * A `SpecStoreBackend` is everything the server needs from storage that spans projects: turn a
 * projectId into a {@link SpecStore} (per request), list the projects it holds (for the picker), and
 * name the default project. The built-in {@link StoreProvider} (filesystem / SQLite) already has
 * exactly this shape, so it *is* a backend — nothing special about the ones we ship.
 *
 * That is the point: `SPEC_STORE` selects `fs` or `sql` as before, but any other value is treated as
 * a **module specifier** — dynamically imported and asked for a backend. So the server can compose a
 * store it does not ship (Postgres, Redis, S3, a networked store for a multi-instance deploy) with no
 * change here and no fork. The plugin implements this interface and owns its own config, connections,
 * and caching; the server only ever sees {@link SpecStoreBackend} and {@link SpecStore}.
 */
import path from 'node:path'
import { resolveStoreChoice } from './storeFactory.js'
import { StoreProvider } from './storeProvider.js'
import type { ProjectSummary } from './storeProvider.js'
import type { SpecStore } from './specStore.js'

export interface SpecStoreBackend {
  /** The store for one project. Called per request; a backend caches connections as it sees fit. */
  storeFor(projectId: string): SpecStore
  /** Every project this deployment holds — the cross-project read behind the project picker. */
  listProjects(): Promise<ProjectSummary[]>
  /** The configured default project, until a request names one. */
  readonly defaultProjectId: string
}

/** What a plugin backend is handed to configure itself. It reads its own settings from `env`. */
export interface BackendContext {
  env: Record<string, string | undefined>
  /** The configured default project (PROJECT_ID, else the SPECS_DIR basename) — use it or override. */
  defaultProjectId: string
  /** The XDG data dir, for a backend that wants to put a file beside the built-ins'. */
  dataDir: string
}

/** A plugin module exports one of these (named `createSpecStoreBackend`, or as its default). */
export type SpecStoreBackendFactory = (context: BackendContext) => SpecStoreBackend | Promise<SpecStoreBackend>

/** The reserved built-in names; anything else in `SPEC_STORE` is a module specifier. */
function isBuiltin(spec: string | undefined): boolean {
  return spec === undefined || spec === 'fs' || spec === 'sql'
}

/** Everything a backend must expose is present — a clearer failure than a later `undefined is not a function`. */
function assertBackend(value: unknown, spec: string): asserts value is SpecStoreBackend {
  const backend = value as Partial<SpecStoreBackend> | null
  if (
    !backend ||
    typeof backend.storeFor !== 'function' ||
    typeof backend.listProjects !== 'function' ||
    typeof backend.defaultProjectId !== 'string'
  ) {
    throw new Error(
      `SPEC_STORE module "${spec}" returned something that is not a SpecStoreBackend ` +
        '(needs storeFor(projectId), listProjects(), and a defaultProjectId string).',
    )
  }
}

/**
 * Resolve the storage backend from configuration. Built-ins (`fs`/`sql`) construct the
 * {@link StoreProvider} directly; any other `SPEC_STORE` value is imported as a module and asked for a
 * backend via `createSpecStoreBackend` (or its default export). Async because a plugin — and its
 * import — may be.
 */
export async function resolveBackend(
  env: Record<string, string | undefined>,
  specsDir: string,
  dataDir: string,
): Promise<SpecStoreBackend> {
  const spec = env.SPEC_STORE
  if (isBuiltin(spec)) {
    return new StoreProvider(resolveStoreChoice(env, specsDir, dataDir))
  }

  const context: BackendContext = {
    env,
    defaultProjectId: env.PROJECT_ID ?? path.basename(path.dirname(specsDir)),
    dataDir,
  }
  let module: Record<string, unknown>
  try {
    module = (await import(spec!)) as Record<string, unknown>
  } catch (cause) {
    throw new Error(`SPEC_STORE="${spec}" could not be imported as a backend module: ${(cause as Error).message}`)
  }
  const factory = (module.createSpecStoreBackend ?? module.default) as SpecStoreBackendFactory | undefined
  if (typeof factory !== 'function') {
    throw new Error(`SPEC_STORE module "${spec}" must export createSpecStoreBackend (or a default factory function).`)
  }
  const backend = await factory(context)
  assertBackend(backend, spec!)
  return backend
}
