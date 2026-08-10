/**
 * implements: resumeRecurrence
 *
 * spec: "Resumes a RecurringTask that was ended, so it schedules occurrences again per its
 * recurrenceRule, and clears endedByArchiving to false. Calling it on a RecurringTask that
 * is not ended is a no-op (idempotent) — it does not error."
 *
 * Added by q-009, which asked whether unarchiveProject should undo the recurrence-ending
 * that archiveProject performed. The answer was to "introduce something like a
 * resumeRecurrence function, and have unarchiveProject call it for RecurringTasks whose
 * ended state was caused by the archiveProject that is now being reversed" — so this is the
 * one definition of resuming, and unarchiveProject decides *which* Tasks to put through it.
 *
 * The inverse of endRecurrence in both attributes: `ended` goes false, and
 * `endedByArchiving` is cleared too, so a Task that is not ended never claims a reason for
 * having been.
 */
import type { Result, World } from './types.js'
import { isRecurring } from './types.js'

export function resumeRecurrence(world: World, taskId: string): Result {
  const task = world.tasks.find((candidate) => candidate.id === taskId)
  if (!task) return { world, ok: false, message: `resumeRecurrence: no Task with id "${taskId}".` }

  if (!isRecurring(task)) {
    return { world, ok: false, message: `resumeRecurrence: "${task.title}" is not a RecurringTask.` }
  }

  // "Calling it on a RecurringTask that is not ended is a no-op — it does not error."
  if (!task.ended) {
    return { world, ok: true, message: `resumeRecurrence: "${task.title}" was still repeating — no change.` }
  }

  // "so it schedules occurrences again per its recurrenceRule, and clears endedByArchiving
  // to false."
  const updated = { ...task, ended: false, endedByArchiving: false }

  return {
    world: { ...world, tasks: world.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)) },
    ok: true,
    message: `resumeRecurrence: "${task.title}" repeats again — completing it now schedules the next occurrence.`,
  }
}
