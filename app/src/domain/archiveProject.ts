/**
 * implements: archiveProject
 *
 * spec: "Archives a Project: marks it archived so it is hidden from default listings, and
 * ends every RecurringTask it holds that is not already ended — setting ended to true and
 * endedByArchiving to true, so unarchiveProject can later tell it apart from a
 * RecurringTask ended directly via endRecurrence. A RecurringTask that was already ended
 * before archiving is left untouched, including its existing endedByArchiving value. Does
 * not delete the Project or any of its Tasks, and is reversible via unarchiveProject."
 *
 * This used to delegate to `endRecurrence`, and since q-009 it cannot: endRecurrence's spec
 * now says it sets `endedByArchiving` to *false* — that is exactly the distinction it is
 * there to record — so archiving through it would erase the mark unarchiveProject reads.
 * The two attributes are therefore set here, and the spec names both of them so this is not
 * a second definition of ending so much as the other of the two ways in.
 *
 * "already ended ... is left untouched, including its existing endedByArchiving value" is
 * why the filter is on `!ended` rather than on ended-ness being fixed up afterwards: a Task
 * the user ended by hand must stay marked as ended by hand, so unarchiving leaves it ended.
 *
 * The spec does not say what archiving an already-archived Project does. Read as a no-op
 * that does not error, matching every other redundant call in this vocabulary
 * (completeTask, reopenTask, endRecurrence all say so explicitly).
 */
import type { Result, World } from './types.js'
import { isRecurring } from './types.js'
import { tasksOf } from './world.js'

export function archiveProject(world: World, projectId: string): Result {
  const project = world.projects.find((candidate) => candidate.id === projectId)
  if (!project) return { world, ok: false, message: `archiveProject: no Project with id "${projectId}".` }

  if (project.archived) {
    return { world, ok: true, message: `archiveProject: "${project.name}" was already archived — no change.` }
  }

  // "ends every RecurringTask it holds that is not already ended".
  const repeating = tasksOf(world, projectId).filter((task) => isRecurring(task) && !task.ended)
  const ending = new Set(repeating.map((task) => task.id))

  // "setting ended to true and endedByArchiving to true" — and nothing else touched, so an
  // already-ended RecurringTask keeps whichever endedByArchiving it arrived with.
  const next: World = {
    tasks: world.tasks.map((task) => (ending.has(task.id) ? { ...task, ended: true, endedByArchiving: true } : task)),
    // "marks it archived" — "Does not delete the Project or any of its Tasks."
    projects: world.projects.map((candidate) =>
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
 * The recurrences archiving will pause — the Tasks that will come back with
 * `endedByArchiving` true, and so the ones unarchiveProject will resume. Not a spec'd
 * function; it reads the world so the UI can say what archiving is about to do. Since
 * q-009 that is no longer a one-way cost, so the caller is telling you rather than warning
 * you.
 */
export function recurrencesEndedByArchiving(world: World, projectId: string): string[] {
  return tasksOf(world, projectId)
    .filter((task) => isRecurring(task) && !task.ended)
    .map((task) => task.title)
}
