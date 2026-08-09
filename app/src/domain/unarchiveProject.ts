/**
 * implements: unarchiveProject
 *
 * spec: "Restores an archived Project to active status, making it visible in default
 * listings again. Does not re-enable any RecurringTask that archiving ended — there is no
 * function in this vocabulary that resumes a recurrence once ended."
 *
 * So this is deliberately not the inverse of archiveProject. It clears `archived` and
 * nothing else: the `ended` flags archiveProject set stay set, and no code here touches
 * them. The absence of that code is the spec being honoured, not an omission — hence the
 * message, which says so where a caller will see it.
 *
 * As with archiveProject, unarchiving a Project that is not archived is read as a no-op
 * that does not error.
 */
import type { Result, World } from './types.js'

export function unarchiveProject(world: World, projectId: string): Result {
  const project = world.projects.find((candidate) => candidate.id === projectId)
  if (!project) return { world, ok: false, message: `unarchiveProject: no Project with id "${projectId}".` }

  if (!project.archived) {
    return { world, ok: true, message: `unarchiveProject: "${project.name}" was not archived — no change.` }
  }

  return {
    world: {
      ...world,
      projects: world.projects.map((candidate) =>
        candidate.id === projectId ? { ...candidate, archived: false } : candidate,
      ),
    },
    ok: true,
    message: `unarchiveProject: restored "${project.name}" — any recurrence archiving ended stays ended.`,
  }
}
