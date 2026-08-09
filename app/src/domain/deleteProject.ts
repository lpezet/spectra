/**
 * implements: deleteProject
 *
 * spec: "Deletes a Project. If the Project is not archived, deletion is blocked while it
 * still holds any Task that is not done, and the caller is told how many incomplete Tasks
 * remain; a RecurringTask counts as done only once it has been ended and then completed. An
 * archived Project is deleted unconditionally — regardless of any Task's done state —
 * taking all its Tasks with it. This deletion is permanent."
 *
 * So there are two doors, and which one you are at depends on `archived`. Archiving first
 * is what makes removal a two-step, undoable-until-the-second-step operation: archive (see
 * archiveProject, reversible), then delete (permanent).
 *
 * The RecurringTask clause needs no code of its own on the blocked path: since q-004,
 * ending one and then completing it sets `done`, so the plain not-done check below already
 * means exactly what the sentence says. Worth stating because the absence of a special case
 * looks like an omission otherwise.
 */
import type { Result, World } from './types.js'
import { tasksOf } from './world.js'

export function deleteProject(world: World, projectId: string): Result {
  const project = world.projects.find((candidate) => candidate.id === projectId)
  if (!project) return { world, ok: false, message: `deleteProject: no Project with id "${projectId}".` }

  const tasks = tasksOf(world, projectId)
  const incomplete = tasks.filter((task) => !task.done)

  // "If the Project is not archived, deletion is blocked while it still holds any Task that
  // is not done, and the caller is told how many incomplete Tasks remain."
  if (!project.archived && incomplete.length > 0) {
    return {
      world,
      ok: false,
      message: `deleteProject: refused — "${project.name}" still holds ${incomplete.length} incomplete ${
        incomplete.length === 1 ? 'Task' : 'Tasks'
      }. Archive it first to delete it anyway.`,
    }
  }

  // "taking all its Tasks with it. This deletion is permanent."
  return {
    world: {
      projects: world.projects.filter((candidate) => candidate.id !== projectId),
      tasks: world.tasks.filter((task) => task.project !== projectId),
    },
    ok: true,
    message: `deleteProject: permanently deleted "${project.name}"${
      tasks.length > 0 ? ` and its ${tasks.length} ${tasks.length === 1 ? 'Task' : 'Tasks'}` : ''
    }.`,
  }
}
