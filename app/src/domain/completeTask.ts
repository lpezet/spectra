/**
 * implements: completeTask
 *
 * spec: "Marks a Task as done. If the Task is already done, this is a no-op (idempotent)
 * — it does not error and does not un-complete it. For a RecurringTask, completing the
 * current occurrence advances dueDate to the next occurrence computed from recurrenceRule
 * and leaves the Task not done, so it is immediately open again for that next occurrence."
 *
 * This clause used to be ambiguous and this file took the opposite reading. q-002 settled
 * it — see specs/questions/q-002-recurring-completion.json for the reasoning.
 *
 * q-004 then added `ended`: an ended RecurringTask completes like a plain Task rather than
 * rescheduling, which is how a Project holding one becomes deletable again.
 */
import { nextOccurrence } from './recurrence.js'
import type { AnyTask, Result, World } from './types.js'
import { isRecurring } from './types.js'

export function completeTask(world: World, taskId: string, today: string): Result {
  const task = world.tasks.find((candidate) => candidate.id === taskId)
  if (!task) return { world, ok: false, message: `completeTask: no Task with id "${taskId}".` }

  // "If the Task is already done, this is a no-op — it does not error and does not
  // un-complete it." Note this returns ok: true; a redundant call is not a failure.
  // Under the current spec a RecurringTask never reaches this state on its own.
  if (task.done) {
    return { world, ok: true, message: `completeTask: "${task.title}" was already done — no change.` }
  }

  let updated: AnyTask
  let message: string

  // endRecurrence's spec: "completing an ended RecurringTask marks it done like any plain
  // Task." So an ended one deliberately falls through to the plain branch below — that is
  // what makes a Project holding one deletable again.
  if (isRecurring(task) && !task.ended) {
    // No dueDate to advance from means the schedule starts counting from now.
    const next = nextOccurrence(task.dueDate ?? today, task.recurrenceRule)

    // The spec defines completing a RecurringTask as advancing to the next occurrence.
    // With no next occurrence to advance to there is nothing to record, so rather than
    // half-apply it — done, or silently unchanged — the completion is refused and says why.
    if (!next.date) {
      return {
        world,
        ok: false,
        message: `completeTask: "${task.title}" cannot be completed — ${next.problem}`,
      }
    }

    updated = { ...task, done: false, dueDate: next.date }
    message = `completeTask: "${task.title}" occurrence done — open again for ${next.date}.`
  } else {
    updated = { ...task, done: true }
    message = `completeTask: "${task.title}" marked done.`
  }

  return {
    world: { ...world, tasks: world.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)) },
    ok: true,
    message,
  }
}
