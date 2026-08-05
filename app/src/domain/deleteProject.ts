/**
 * implements: deleteProject
 *
 * spec: "Deletes a Project. Blocks rather than cascades: if the Project still holds any
 * Task that is not done, the deletion is refused and the caller is told how many
 * incomplete Tasks remain. A RecurringTask counts as done only once it has been ended and
 * then completed. A Project whose Tasks are all done is deleted together with those Tasks."
 *
 * The RecurringTask clause needs no code of its own: since q-004, ending one and then
 * completing it sets `done`, so the plain not-done check below already means exactly what
 * the sentence says. Worth stating because the absence of a special case looks like an
 * omission otherwise.
 */
import type { Result, World } from './types.js'
import { tasksOf } from './world.js'

export function deleteProject(world: World, projectId: string): Result {
  const project = world.projects.find((candidate) => candidate.id === projectId)
  if (!project) return { world, ok: false, message: `deleteProject: no Project with id "${projectId}".` }

  const tasks = tasksOf(world, projectId)
  const incomplete = tasks.filter((task) => !task.done)

  // "the deletion is refused and the caller is told how many incomplete Tasks remain"
  if (incomplete.length > 0) {
    return {
      world,
      ok: false,
      message: `deleteProject: refused — "${project.name}" still holds ${incomplete.length} incomplete ${
        incomplete.length === 1 ? 'Task' : 'Tasks'
      }.`,
    }
  }

  // "deleted together with those Tasks" — the completed ones go with it.
  return {
    world: {
      projects: world.projects.filter((candidate) => candidate.id !== projectId),
      tasks: world.tasks.filter((task) => task.project !== projectId),
    },
    ok: true,
    message: `deleteProject: deleted "${project.name}"${
      tasks.length > 0 ? ` and its ${tasks.length} completed ${tasks.length === 1 ? 'Task' : 'Tasks'}` : ''
    }.`,
  }
}
