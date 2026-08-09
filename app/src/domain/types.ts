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

/**
 * Priority: "How urgent a Task is. Exactly one of low, normal or high — there is no
 * 'none', and priority is never absent."
 *
 * An attribute-type, so it is a value shape rather than a thing with its own file in
 * app/. The closed set is stated here because the spec states it.
 */
export const PRIORITIES = ['low', 'normal', 'high'] as const
export type Priority = (typeof PRIORITIES)[number]

/**
 * Nothing calls this yet, and that is the finding rather than an oversight: no function in
 * the glossary sets a Task's priority, so there is no point at which a bad value could
 * arrive. See q-007. Kept because it is the check the spec describes, ready for whichever
 * entry point gains one.
 */
export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
}

/** Project: "A named container for Tasks." */
export interface Project {
  id: string
  /** Project.name — string */
  name: string
  /**
   * Project.archived — boolean, default false. Set by archiveProject: "marks it archived so
   * it is hidden from default listings". Also the switch deleteProject reads — an archived
   * Project "is deleted unconditionally", an unarchived one is blocked by incomplete Tasks.
   */
  archived: boolean
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
  /** Task.priority — ref:Priority, default 'normal'. */
  priority: Priority
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
