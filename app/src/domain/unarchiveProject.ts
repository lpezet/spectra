/**
 * implements: unarchiveProject
 *
 * spec: "Restores an archived Project to active status, making it visible in default
 * listings again. For every RecurringTask in the Project whose endedByArchiving is true,
 * resumes it (per resumeRecurrence), reversing exactly the ending that this Project's
 * archiveProject performed. A RecurringTask ended directly via endRecurrence
 * (endedByArchiving false) is left ended — unarchiveProject does not resume it."
 *
 * q-009 turned this around: it used to clear `archived` and nothing else. It is now the
 * inverse of archiveProject, but only over the Tasks archiveProject actually changed —
 * which is what `endedByArchiving` is for. A recurrence the user ended by hand stays ended
 * through an archive/restore round trip.
 *
 * "per resumeRecurrence" is taken literally, as archiveProject once took "per
 * endRecurrence": the Tasks go through `resumeRecurrence` rather than having their flags
 * set here, so there is one definition of resuming. That function is idempotent and refuses
 * plain Tasks, and the filter below only selects ended RecurringTasks anyway.
 *
 * As with archiveProject, unarchiving a Project that is not archived is read as a no-op
 * that does not error.
 */
import type { Result, World } from './types.js'
import { isRecurring } from './types.js'
import { resumeRecurrence } from './resumeRecurrence.js'
import { tasksOf } from './world.js'

export function unarchiveProject(world: World, projectId: string): Result {
  const project = world.projects.find((candidate) => candidate.id === projectId)
  if (!project) return { world, ok: false, message: `unarchiveProject: no Project with id "${projectId}".` }

  if (!project.archived) {
    return { world, ok: true, message: `unarchiveProject: "${project.name}" was not archived — no change.` }
  }

  // "For every RecurringTask in the Project whose endedByArchiving is true, resumes it".
  const toResume = tasksOf(world, projectId).filter((task) => isRecurring(task) && task.ended && task.endedByArchiving)

  let next = world
  for (const task of toResume) {
    next = resumeRecurrence(next, task.id).world
  }

  next = {
    ...next,
    projects: next.projects.map((candidate) =>
      candidate.id === projectId ? { ...candidate, archived: false } : candidate,
    ),
  }

  return {
    world: next,
    ok: true,
    message: `unarchiveProject: restored "${project.name}"${
      toResume.length > 0
        ? `, resuming ${toResume.length} recurring ${toResume.length === 1 ? 'Task' : 'Tasks'}`
        : ''
    } — any recurrence ended directly stays ended.`,
  }
}
