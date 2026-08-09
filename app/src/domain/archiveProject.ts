/**
 * implements: archiveProject
 *
 * spec: "Archives a Project: marks it archived so it is hidden from default listings, and
 * ends every RecurringTask it holds (per endRecurrence) so none schedule a further
 * occurrence. Does not delete the Project or any of its Tasks, and is reversible via
 * unarchiveProject."
 *
 * "per endRecurrence" is taken literally: the recurring Tasks are put through
 * `endRecurrence` rather than having `ended` set here, so there is one definition of what
 * ending a recurrence means and it cannot drift. That function is idempotent and refuses
 * plain Tasks, so only the un-ended RecurringTasks are passed to it.
 *
 * The spec does not say what archiving an already-archived Project does. Read as a no-op
 * that does not error, matching every other redundant call in this vocabulary
 * (completeTask, reopenTask, endRecurrence all say so explicitly).
 */
import type { Result, World } from './types.js'
import { isRecurring } from './types.js'
import { endRecurrence } from './endRecurrence.js'
import { tasksOf } from './world.js'

export function archiveProject(world: World, projectId: string): Result {
  const project = world.projects.find((candidate) => candidate.id === projectId)
  if (!project) return { world, ok: false, message: `archiveProject: no Project with id "${projectId}".` }

  if (project.archived) {
    return { world, ok: true, message: `archiveProject: "${project.name}" was already archived — no change.` }
  }

  // "ends every RecurringTask it holds (per endRecurrence)".
  const repeating = tasksOf(world, projectId).filter((task) => isRecurring(task) && !task.ended)

  let next = world
  for (const task of repeating) {
    next = endRecurrence(next, task.id).world
  }

  // "marks it archived" — "Does not delete the Project or any of its Tasks."
  next = {
    ...next,
    projects: next.projects.map((candidate) =>
      candidate.id === projectId ? { ...candidate, archived: true } : candidate,
    ),
  }

  return {
    world: next,
    ok: true,
    message: `archiveProject: archived "${project.name}"${
      repeating.length > 0
        ? `, ending ${repeating.length} recurring ${repeating.length === 1 ? 'Task' : 'Tasks'}`
        : ''
    }.`,
  }
}

/**
 * What the caller should be warned about before archiving — the recurrences that will be
 * ended, which unarchiveProject cannot bring back. Not a spec'd function; it reads the
 * world so the UI can say what archiving is about to cost.
 */
export function recurrencesEndedByArchiving(world: World, projectId: string): string[] {
  return tasksOf(world, projectId)
    .filter((task) => isRecurring(task) && !task.ended)
    .map((task) => task.title)
}
