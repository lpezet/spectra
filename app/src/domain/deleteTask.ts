/**
 * implements: deleteTask
 *
 * spec: "Deletes a single Task, removing it from its Project."
 *
 * Added by q-005, which was raised because nothing in the glossary could delete a Task or
 * move it between Projects — a gap q-004's third option had already run into when looking
 * for a way out of an undeletable Project.
 *
 * Note this deletes unconditionally. deleteProject blocks on incomplete Tasks; deleting a
 * Task one at a time does not, so it is also the way round that rule.
 */
import type { Result, World } from './types.js'

export function deleteTask(world: World, taskId: string): Result {
  const task = world.tasks.find((candidate) => candidate.id === taskId)
  if (!task) return { world, ok: false, message: `deleteTask: no Task with id "${taskId}".` }

  return {
    // Project.tasks is derived from this list, so dropping the Task here is what removes it
    // from its Project — there is no second place to keep in step.
    world: { ...world, tasks: world.tasks.filter((candidate) => candidate.id !== taskId) },
    ok: true,
    message: `deleteTask: deleted "${task.title}".`,
  }
}
