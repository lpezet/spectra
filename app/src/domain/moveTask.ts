/**
 * implements: moveTask
 *
 * spec: "Reassigns a Task from its current Project to a different Project. If the Task is a
 * RecurringTask whose endedByArchiving is true, moveTask sets endedByArchiving to false,
 * since the archiving that caused it no longer applies once the Task belongs to a different
 * Project, while leaving its ended state unchanged. This applies when the destination
 * Project is not archived; what moveTask does when the destination Project is itself
 * archived is not yet specified."
 *
 * Added by q-005 alongside deleteTask; the endedByArchiving clause came from q-029 as
 * changeset chat-003.
 *
 * The spec says "a different Project" without saying what moving to the current one does.
 * Treated here as an idempotent no-op rather than an error, matching how completeTask,
 * reopenTask and endRecurrence all handle being asked for a state they are already in.
 * Small enough to decide rather than ask; flagged here in case the house style was not
 * what was meant.
 *
 * The archived-destination case is explicitly "not yet specified", so this code does the
 * narrowest thing that cannot contradict a later decision: it moves the Task and leaves
 * endedByArchiving as it found it. Clearing the flag there would be inventing the rule; the
 * spec only mandates clearing it when the destination is not archived.
 */
import type { Result, World } from './types.js'
import { isRecurring } from './types.js'

export function moveTask(world: World, taskId: string, destinationId: string): Result {
  const task = world.tasks.find((candidate) => candidate.id === taskId)
  if (!task) return { world, ok: false, message: `moveTask: no Task with id "${taskId}".` }

  const destination = world.projects.find((project) => project.id === destinationId)
  if (!destination) {
    return { world, ok: false, message: `moveTask: no Project with id "${destinationId}".` }
  }

  if (task.project === destinationId) {
    return { world, ok: true, message: `moveTask: "${task.title}" is already in "${destination.name}" — no change.` }
  }

  const from = world.projects.find((project) => project.id === task.project)

  // "If the Task is a RecurringTask whose endedByArchiving is true, moveTask sets
  // endedByArchiving to false ... while leaving its ended state unchanged." `ended` is
  // copied through untouched, so a Task archiving ended stays ended — it just stops being
  // attributed to archiving, and so is no longer resumed by unarchiveProject of the Project
  // it left.
  const detaching = isRecurring(task) && task.endedByArchiving && !destination.archived
  const updated = detaching
    ? { ...task, project: destinationId, endedByArchiving: false }
    : { ...task, project: destinationId }

  return {
    // Both Projects' task lists are derived from this edge, so reassigning it updates each
    // side at once — neither can be left holding a stale reference.
    world: { ...world, tasks: world.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)) },
    ok: true,
    message: `moveTask: moved "${task.title}"${from ? ` from "${from.name}"` : ''} to "${destination.name}".${
      detaching ? ' It stays ended, but is no longer ended by archiving.' : ''
    }`,
  }
}
