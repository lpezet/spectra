/**
 * implements: endRecurrence
 *
 * spec: "Stops a RecurringTask from repeating. The Task is marked ended and is not
 * scheduled again; completing an ended RecurringTask marks it done like any plain Task.
 * Ending an already-ended RecurringTask is a no-op (idempotent) — it does not error."
 *
 * Added by q-004, which was raised because a Project holding a RecurringTask had become
 * undeletable: `deleteProject` blocks on any Task that is not done, and since q-002 a
 * RecurringTask never reaches done on its own. This is the escape hatch — and, as the
 * option that introduced it argued, a hole worth closing regardless of deletion, since
 * nothing could previously stop a repeating Task.
 */
import type { Result, World } from './types.js'
import { isRecurring } from './types.js'

export function endRecurrence(world: World, taskId: string): Result {
  const task = world.tasks.find((candidate) => candidate.id === taskId)
  if (!task) return { world, ok: false, message: `endRecurrence: no Task with id "${taskId}".` }

  if (!isRecurring(task)) {
    return { world, ok: false, message: `endRecurrence: "${task.title}" is not a RecurringTask.` }
  }

  // "Ending an already-ended RecurringTask is a no-op — it does not error."
  if (task.ended) {
    return { world, ok: true, message: `endRecurrence: "${task.title}" had already ended — no change.` }
  }

  const updated = { ...task, ended: true }

  return {
    world: { ...world, tasks: world.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)) },
    ok: true,
    message: `endRecurrence: "${task.title}" will not repeat again — completing it now finishes it.`,
  }
}
