/**
 * implements: reopenTask
 *
 * spec: "Clears the done flag on a Task. If the Task was never completed, this is a no-op
 * (idempotent) — it does not error. Reopening a RecurringTask affects only the current
 * occurrence and leaves the recurrence schedule untouched."
 *
 * Since q-002 the RecurringTask clause is dead weight in practice: completing one already
 * leaves it not done, so reopening a RecurringTask always takes the no-op path. Kept as
 * written because the spec still says it, and the spec is what this file implements.
 */
import type { Result, World } from './types.js'

export function reopenTask(world: World, taskId: string): Result {
  const task = world.tasks.find((candidate) => candidate.id === taskId)
  if (!task) return { world, ok: false, message: `reopenTask: no Task with id "${taskId}".` }

  // "If the Task was never completed, this is a no-op — it does not error."
  if (!task.done) {
    return { world, ok: true, message: `reopenTask: "${task.title}" was not done — no change.` }
  }

  // Only `done` changes: "leaves the recurrence schedule untouched" means dueDate and
  // recurrenceRule are deliberately left exactly as completeTask left them.
  const updated = { ...task, done: false }

  return {
    world: { ...world, tasks: world.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)) },
    ok: true,
    message: `reopenTask: "${task.title}" reopened.`,
  }
}
