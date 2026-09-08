/**
 * The one place that knows the project prefix. Every project-scoped call — glossary (api.ts) and
 * chat (chat.ts) alike — goes under /api/orgs/<org>/projects/<projectId>, and the browser does not
 * know those ids until it asks (the un-prefixed /api/context bootstrap). So the base starts unset
 * and {@link configureProject} fills it in before the first scoped call. A call made before then
 * hits a bare, unmounted path and 404s — the intended loud failure, not a silent wrong-project read.
 */
let base = '/api/orgs/local/projects/unconfigured'
let scope = { org: 'local', projectId: 'unconfigured' }

/** Point every subsequent project-scoped call at this org/project. Call before loading anything. */
export function configureProject(org: string, projectId: string): void {
  base = `/api/orgs/${encodeURIComponent(org)}/projects/${encodeURIComponent(projectId)}`
  scope = { org, projectId }
}

/** Prefix a project-scoped path (e.g. `/terms`, `/chat/sessions`) with the configured base. */
export function apiPath(path: string): string {
  return `${base}${path}`
}

/** The org/project the calls are currently pointed at — for an embedder that needs the raw ids. */
export function currentProject(): { org: string; projectId: string } {
  return scope
}
