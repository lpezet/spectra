/**
 * implements: moveTask
 *
 * spec: "Reassigns a Task from its current Project to a different Project."
 *
 * Added by q-005 alongside deleteTask.
 *
 * The spec says "a different Project" without saying what moving to the current one does.
 * Treated here as an idempotent no-op rather than an error, matching how completeTask,
 * reopenTask and endRecurrence all handle being asked for a state they are already in.
 * Small enough to decide rather than ask; flagged here in case the house style was not
 * what was meant.
 */
import type { Result, World } from './types.js'

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
  const updated = { ...task, project: destinationId }

  return {
    // Both Projects' task lists are derived from this edge, so reassigning it updates each
    // side at once — neither can be left holding a stale reference.
    world: { ...world, tasks: world.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)) },
    ok: true,
    message: `moveTask: moved "${task.title}"${from ? ` from "${from.name}"` : ''} to "${destination.name}".`,
  }
}
