/**
 * implements: Project, Task, RecurringTask (storage and derived relationships)
 *
 * Note what is *not* here: the glossary defines `completeTask`, `reopenTask` and
 * `deleteProject`, but no creation function. `createProject` and `createTask` below are
 * therefore invented by this implementation, not derived from a spec — a real gap in the
 * glossary rather than something to paper over silently.
 */
import type { AnyTask, Project, World } from './types.js'

let sequence = 0

function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

/**
 * Project.tasks — `ref:Task[]`. Derived from the stored `Task.project` edge rather than
 * held as a second list, so the two ends of the relationship cannot drift apart.
 */
export function tasksOf(world: World, projectId: string): AnyTask[] {
  return world.tasks.filter((task) => task.project === projectId)
}

export function projectOf(world: World, task: AnyTask): Project | undefined {
  return world.projects.find((project) => project.id === task.project)
}

/** NOT spec-derived — see the file header. */
export function createProject(world: World, name: string): { world: World; project: Project } {
  const project: Project = { id: nextId('project'), name }
  return { world: { ...world, projects: [...world.projects, project] }, project }
}

export interface NewTask {
  title: string
  project: string
  dueDate?: string | null
  /** Supplying one makes the instance a RecurringTask instead of a plain Task. */
  recurrenceRule?: string | null
}

/** NOT spec-derived — see the file header. */
export function createTask(world: World, input: NewTask): { world: World; task: AnyTask } {
  const base = {
    id: nextId('task'),
    title: input.title,
    // Task.done carries `"default": false` in the spec.
    done: false,
    dueDate: input.dueDate ?? null,
    project: input.project,
  }
  const task: AnyTask = input.recurrenceRule
    ? { ...base, recurrenceRule: input.recurrenceRule }
    : base

  return { world: { ...world, tasks: [...world.tasks, task] }, task }
}

export function emptyWorld(): World {
  return { projects: [], tasks: [] }
}

/**
 * A little content so the app is clickable on load — including one RecurringTask and one
 * incomplete Task, which is what makes `deleteProject`'s refusal path reachable
 * immediately.
 */
export function seedWorld(): World {
  let world = emptyWorld()

  const home = createProject(world, 'Home')
  world = home.world
  const work = createProject(world, 'Work')
  world = work.world

  world = createTask(world, { title: 'Water the plants', project: home.project.id, recurrenceRule: 'every 3 days', dueDate: '2026-08-05' }).world
  world = createTask(world, { title: 'Replace the smoke alarm battery', project: home.project.id, dueDate: '2026-08-20' }).world
  world = createTask(world, { title: 'Write the Phase 2 brief', project: work.project.id }).world

  return world
}
