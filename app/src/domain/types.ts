/**
 * implements: Project, Task, RecurringTask
 *
 * Written from specs/terms/{project,task,recurring-task}.json. Two departures, both
 * implementation concerns the glossary deliberately does not speak to:
 *
 * - `id`. The specs are type-level and carry no identity attribute. Instances need one,
 *   so it lives here rather than being back-filled into the glossary.
 * - `Project.tasks`. The spec declares both `Project.tasks: ref:Task[]` and
 *   `Task.project: ref:Project` — the same edge described from both ends. Storing both
 *   invites them to disagree, so `Task.project` is the stored side and `Project.tasks` is
 *   derived (see `tasksOf`), mirroring how the glossary tool itself recomputes backlinks
 *   rather than persisting them.
 */

/** Project: "A named container for Tasks." */
export interface Project {
  id: string
  /** Project.name — string */
  name: string
}

/** Task: "either done or not done — there is no in-progress state." */
export interface Task {
  id: string
  /** Task.title — string */
  title: string
  /** Task.done — boolean, default false */
  done: boolean
  /** Task.dueDate — date, optional. ISO `yyyy-mm-dd`. */
  dueDate: string | null
  /** Task.project — ref:Project */
  project: string
}

/** RecurringTask: parent Task, adding its schedule. */
export interface RecurringTask extends Task {
  /** RecurringTask.recurrenceRule — ref:RecurrenceRule, an RFC 5545 RRULE. */
  recurrenceRule: string
  /** RecurringTask.ended — boolean, default false. Stops it repeating (q-004). */
  ended: boolean
}

export type AnyTask = Task | RecurringTask

/**
 * RecurringTask's only difference from Task is the attribute it adds, so carrying that
 * attribute is what makes an instance one — no separate discriminator to keep in sync.
 */
export function isRecurring(task: AnyTask): task is RecurringTask {
  return typeof (task as RecurringTask).recurrenceRule === 'string'
}

export interface World {
  projects: Project[]
  tasks: AnyTask[]
}

/**
 * What every spec'd function returns. `ok: false` means the operation was *refused* —
 * which `deleteProject` requires as a first-class outcome, not an exception. An
 * idempotent no-op is `ok: true` with a message saying nothing changed, because the
 * specs are explicit that a redundant call "does not error".
 */
export interface Result {
  world: World
  ok: boolean
  message: string
}
