/**
 * One test per clause the specs actually commit to. These are the acceptance criteria
 * from M5 written down where they can be re-run, rather than only clicked through.
 */
import { describe, expect, it } from 'vitest'
import { completeTask } from './completeTask.js'
import { deleteProject } from './deleteProject.js'
import { reopenTask } from './reopenTask.js'
import { endRecurrence } from './endRecurrence.js'
import { isRecurring } from './types.js'
import type { World } from './types.js'
import { createProject, createTask, emptyWorld, tasksOf } from './world.js'

const TODAY = '2026-08-04'

/** A Project with one plain Task, plus whatever else the test asks for. */
function scenario(options: { recurrenceRule?: string; dueDate?: string } = {}) {
  let world: World = emptyWorld()

  const project = createProject(world, 'Home')
  world = project.world

  const task = createTask(world, {
    title: 'Water the plants',
    project: project.project.id,
    dueDate: options.dueDate ?? null,
    recurrenceRule: options.recurrenceRule ?? null,
  })
  world = task.world

  return { world, projectId: project.project.id, taskId: task.task.id }
}

describe('Project / Task', () => {
  it('derives Project.tasks from the stored Task.project edge', () => {
    const { world, projectId, taskId } = scenario()
    expect(tasksOf(world, projectId).map((task) => task.id)).toEqual([taskId])
  })

  it('defaults Task.done to false', () => {
    const { world } = scenario()
    expect(world.tasks[0]!.done).toBe(false)
  })

  // The tests q-001's changeset committed to.
  it('gives a newly created Project no Tasks', () => {
    let world = emptyWorld()
    const project = createProject(world, 'Home')
    expect(tasksOf(project.world, project.project.id)).toEqual([])
  })

  it('keeps two Projects with the same name distinct', () => {
    let world = emptyWorld()
    const first = createProject(world, 'Home')
    const second = createProject(first.world, 'Home')

    expect(second.project.id).not.toBe(first.project.id)
    expect(second.world.projects).toHaveLength(2)
  })

  it('treats a Task carrying recurrenceRule as a RecurringTask', () => {
    const plain = scenario()
    const recurring = scenario({ recurrenceRule: 'FREQ=WEEKLY' })
    expect(isRecurring(plain.world.tasks[0]!)).toBe(false)
    expect(isRecurring(recurring.world.tasks[0]!)).toBe(true)
  })
})

describe('completeTask', () => {
  it('marks a Task done', () => {
    const { world, taskId } = scenario()
    const result = completeTask(world, taskId, TODAY)
    expect(result.ok).toBe(true)
    expect(result.world.tasks[0]!.done).toBe(true)
  })

  it('is idempotent: completing an already-done Task changes nothing and does not error', () => {
    const { world, taskId } = scenario()
    const once = completeTask(world, taskId, TODAY)
    const twice = completeTask(once.world, taskId, TODAY)

    expect(twice.ok).toBe(true)
    expect(twice.world).toBe(once.world)
    expect(twice.message).toMatch(/already done/)
  })

  it('does not un-complete a done Task', () => {
    const { world, taskId } = scenario()
    const twice = completeTask(completeTask(world, taskId, TODAY).world, taskId, TODAY)
    expect(twice.world.tasks[0]!.done).toBe(true)
  })

  // The three below are the tests q-002's changeset committed to, verbatim.
  it('leaves a RecurringTask not done', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=DAILY;INTERVAL=3', dueDate: '2026-08-05' })
    expect(completeTask(world, taskId, TODAY).world.tasks[0]!.done).toBe(false)
  })

  it('advances a RecurringTask due 2026-08-05 with FREQ=DAILY;INTERVAL=3 to 2026-08-08', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=DAILY;INTERVAL=3', dueDate: '2026-08-05' })
    expect(completeTask(world, taskId, TODAY).world.tasks[0]!.dueDate).toBe('2026-08-08')
  })

  it('advances from today when a RecurringTask has no dueDate', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=WEEKLY' })
    const result = completeTask(world, taskId, TODAY)

    expect(result.world.tasks[0]!.done).toBe(false)
    expect(result.world.tasks[0]!.dueDate).toBe('2026-08-11')
  })

  it('can be completed repeatedly, advancing the schedule each time', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=WEEKLY', dueDate: '2026-08-05' })
    const once = completeTask(world, taskId, TODAY)
    const twice = completeTask(once.world, taskId, TODAY)

    expect(twice.world.tasks[0]!.dueDate).toBe('2026-08-19')
    expect(twice.world.tasks[0]!.done).toBe(false)
  })

  it('refuses when the recurrenceRule cannot be parsed, leaving the Task untouched', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'every other Tuesday', dueDate: TODAY })
    const result = completeTask(world, taskId, TODAY)

    expect(result.ok).toBe(false)
    expect(result.world).toBe(world)
    expect(result.message).toMatch(/cannot be completed/)
  })

  it('leaves a plain Task with no dueDate alone', () => {
    const { world, taskId } = scenario()
    expect(completeTask(world, taskId, TODAY).world.tasks[0]!.dueDate).toBeNull()
  })
})

describe('reopenTask', () => {
  it('clears the done flag', () => {
    const { world, taskId } = scenario()
    const reopened = reopenTask(completeTask(world, taskId, TODAY).world, taskId)

    expect(reopened.ok).toBe(true)
    expect(reopened.world.tasks[0]!.done).toBe(false)
  })

  it('is idempotent: reopening a Task that was never completed does not error', () => {
    const { world, taskId } = scenario()
    const result = reopenTask(world, taskId)

    expect(result.ok).toBe(true)
    expect(result.world).toBe(world)
    expect(result.message).toMatch(/was not done/)
  })

  it('leaves the recurrence schedule untouched', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=DAILY;INTERVAL=3', dueDate: '2026-08-05' })
    const completed = completeTask(world, taskId, TODAY)
    const reopened = reopenTask(completed.world, taskId)

    expect(reopened.world.tasks[0]!.done).toBe(false)
    expect(reopened.world.tasks[0]!.dueDate).toBe('2026-08-08')
    expect(isRecurring(reopened.world.tasks[0]!) && reopened.world.tasks[0]!.recurrenceRule).toBe('FREQ=DAILY;INTERVAL=3')
  })

  // Since q-002, completing a RecurringTask already leaves it open, so this path is the
  // only one a RecurringTask can take through reopenTask.
  it('is always a no-op on a RecurringTask, because completing one never leaves it done', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=WEEKLY', dueDate: '2026-08-05' })
    const completed = completeTask(world, taskId, TODAY)
    const reopened = reopenTask(completed.world, taskId)

    expect(reopened.world).toBe(completed.world)
    expect(reopened.message).toMatch(/was not done/)
  })
})

describe('deleteProject', () => {
  it('refuses while incomplete Tasks remain, and reports how many', () => {
    let { world, projectId } = scenario()
    world = createTask(world, { title: 'Second', project: projectId }).world

    const result = deleteProject(world, projectId)

    expect(result.ok).toBe(false)
    expect(result.world).toBe(world)
    expect(result.message).toMatch(/2 incomplete Tasks/)
  })

  it('singularises the refusal when exactly one Task remains', () => {
    const { world, projectId } = scenario()
    expect(deleteProject(world, projectId).message).toMatch(/1 incomplete Task\./)
  })

  it('deletes the Project together with its Tasks once they are all done', () => {
    const { world, projectId, taskId } = scenario()
    const completed = completeTask(world, taskId, TODAY)
    const result = deleteProject(completed.world, projectId)

    expect(result.ok).toBe(true)
    expect(result.world.projects).toEqual([])
    expect(result.world.tasks).toEqual([])
  })

  // q-002 made this unsatisfiable; q-004 gave it a way out. Both halves are pinned here.
  it('still refuses while a RecurringTask has not ended, however often it is completed', () => {
    let world = emptyWorld()
    const project = createProject(world, 'Home')
    world = project.world
    const task = createTask(world, {
      title: 'Water the plants',
      project: project.project.id,
      recurrenceRule: 'FREQ=WEEKLY',
    })
    world = task.world

    // Complete it as many times as you like — it is open again every time.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      world = completeTask(world, task.task.id, TODAY).world
    }

    const result = deleteProject(world, project.project.id)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/1 incomplete Task/)
  })

  // The test q-004's changeset committed to.
  it('deletes a Project once its RecurringTasks are ended and completed', () => {
    let world = emptyWorld()
    const project = createProject(world, 'Home')
    world = project.world
    const task = createTask(world, {
      title: 'Water the plants',
      project: project.project.id,
      recurrenceRule: 'FREQ=WEEKLY',
    })
    world = task.world

    world = endRecurrence(world, task.task.id).world
    world = completeTask(world, task.task.id, TODAY).world

    const result = deleteProject(world, project.project.id)
    expect(result.ok).toBe(true)
    expect(result.world.projects).toEqual([])
  })

  it('deletes an empty Project', () => {
    let world = emptyWorld()
    const project = createProject(world, 'Empty')
    world = project.world

    const result = deleteProject(world, project.project.id)
    expect(result.ok).toBe(true)
    expect(result.world.projects).toEqual([])
  })

  it('leaves other Projects and their Tasks alone', () => {
    let { world, projectId, taskId } = scenario()
    const other = createProject(world, 'Work')
    world = other.world
    world = createTask(world, { title: 'Untouched', project: other.project.id }).world

    const result = deleteProject(completeTask(world, taskId, TODAY).world, projectId)

    expect(result.ok).toBe(true)
    expect(result.world.projects.map((project) => project.name)).toEqual(['Work'])
    expect(result.world.tasks.map((task) => task.title)).toEqual(['Untouched'])
  })
})

describe('endRecurrence', () => {
  // The tests q-004's changeset committed to.
  it('makes an ended RecurringTask stay done when completed, rather than reopening', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=WEEKLY', dueDate: '2026-08-05' })
    const ended = endRecurrence(world, taskId)
    const done = completeTask(ended.world, taskId, TODAY)

    expect(done.world.tasks[0]!.done).toBe(true)
    expect(done.world.tasks[0]!.dueDate).toBe('2026-08-05')
  })

  it('is idempotent: ending an already-ended RecurringTask changes nothing and does not error', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=WEEKLY' })
    const once = endRecurrence(world, taskId)
    const twice = endRecurrence(once.world, taskId)

    expect(twice.ok).toBe(true)
    expect(twice.world).toBe(once.world)
    expect(twice.message).toMatch(/had already ended/)
  })

  it('refuses on a plain Task, which has no recurrence to end', () => {
    const { world, taskId } = scenario()
    const result = endRecurrence(world, taskId)

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/is not a RecurringTask/)
  })

  it('leaves the rule and dueDate alone — it stops repetition, it does not reschedule', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=WEEKLY', dueDate: '2026-08-05' })
    const ended = endRecurrence(world, taskId)
    const task = ended.world.tasks[0]!

    expect(task.dueDate).toBe('2026-08-05')
    expect(isRecurring(task) && task.recurrenceRule).toBe('FREQ=WEEKLY')
  })

  it('starts a new RecurringTask un-ended', () => {
    const { world } = scenario({ recurrenceRule: 'FREQ=WEEKLY' })
    const task = world.tasks[0]!
    expect(isRecurring(task) && task.ended).toBe(false)
  })
})
