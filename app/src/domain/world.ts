/**
 * implements: Project, Task, RecurringTask, createProject, createTask
 *
 * Storage and derived relationships, plus the two creation functions.
 *
 * Those two used to be invented by this implementation, which is what q-001 was raised
 * about. Answering it put them in the glossary, so they are now spec'd like anything else
 * — see specs/terms/create-project.json and create-task.json.
 */
import type { AnyTask, Project, Result, World } from './types.js'
import { isPriority } from './types.js'

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

/**
 * createProject: "Creates a Project with the given name. The new Project holds no Tasks.
 * The name is not required to be unique — two Projects may share a name and remain
 * distinct." Identity comes from `id`, never the name, which is what makes that last
 * clause hold without any extra work.
 */
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
  /** Omitted leaves the Task at normal. Anything outside low/normal/high is refused. */
  priority?: string | null
}

/**
 * createTask gained a way to fail when q-007 let it take a priority, so it now answers in
 * the same shape as every other spec'd function. `task` is null exactly when `ok` is false.
 */
export interface CreateTaskResult extends Result {
  task: AnyTask | null
}

/**
 * createTask: "Creates a Task inside the given Project. The new Task is not done.
 * Supplying a recurrenceRule creates a RecurringTask instead of a plain Task; omitting it
 * creates a plain Task."
 */
export function createTask(world: World, input: NewTask): CreateTaskResult {
  // "Supplying a priority sets it; omitting it leaves the Task at normal." Priority's own
  // spec closes the set, so anything outside it is refused rather than coerced.
  if (input.priority != null && !isPriority(input.priority)) {
    return {
      world,
      task: null,
      ok: false,
      message: `createTask: "${input.priority}" is not a priority — expected low, normal or high.`,
    }
  }

  const base = {
    id: nextId('task'),
    title: input.title,
    // Task.done carries `"default": false` in the spec.
    done: false,
    dueDate: input.dueDate ?? null,
    project: input.project,
    // Task.priority carries `"default": "normal"`.
    priority: input.priority ?? 'normal',
  }
  const task: AnyTask = input.recurrenceRule
    ? { ...base, recurrenceRule: input.recurrenceRule, ended: false }
    : base

  return {
    world: { ...world, tasks: [...world.tasks, task] },
    task,
    ok: true,
    message: `createTask: added "${task.title}".`,
  }
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

  world = createTask(world, { title: 'Water the plants', project: home.project.id, recurrenceRule: 'FREQ=DAILY;INTERVAL=3', dueDate: '2026-08-05' }).world
  world = createTask(world, { title: 'Replace the smoke alarm battery', project: home.project.id, dueDate: '2026-08-20' }).world
  world = createTask(world, { title: 'Write the Phase 2 brief', project: work.project.id }).world

  return world
}
