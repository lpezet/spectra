/**
 * One test per clause the specs actually commit to. These are the acceptance criteria
 * from M5 written down where they can be re-run, rather than only clicked through.
 */
import { describe, expect, it } from 'vitest'
import { archiveProject } from './archiveProject.js'
import { completeTask } from './completeTask.js'
import { deleteProject } from './deleteProject.js'
import { unarchiveProject } from './unarchiveProject.js'
import { reopenTask } from './reopenTask.js'
import { endRecurrence } from './endRecurrence.js'
import { deleteTask } from './deleteTask.js'
import { moveTask } from './moveTask.js'
import { PRIORITIES, isPriority, isRecurring } from './types.js'
import type { World } from './types.js'
import { activeProjects, archivedProjects, createProject, createTask, emptyWorld, tasksOf } from './world.js'

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

  return { world, projectId: project.project.id, taskId: task.task!.id }
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

  // The tests cs-001's changeset committed to. Its second — "setting a Task's priority to
  // a value outside low/normal/high is rejected" — cannot be written yet: nothing in the
  // glossary sets a priority, so there is no call that could reject one. q-007 asks about
  // that. The predicate the clause describes is pinned below regardless.
  it('defaults a new Task to normal priority', () => {
    const { world } = scenario()
    expect(world.tasks[0]!.priority).toBe('normal')
  })

  it('recognises exactly low, normal and high as priorities', () => {
    expect([...PRIORITIES]).toEqual(['low', 'normal', 'high'])
    expect(isPriority('urgent')).toBe(false)
    expect(isPriority('normal')).toBe(true)
  })

  it('gives a RecurringTask a priority too, and keeps it across occurrences', () => {
    const { world, taskId } = scenario({ recurrenceRule: 'FREQ=WEEKLY', dueDate: '2026-08-05' })
    expect(world.tasks[0]!.priority).toBe('normal')

    const once = completeTask(world, taskId, TODAY)
    const twice = completeTask(once.world, taskId, TODAY)
    expect(twice.world.tasks[0]!.priority).toBe('normal')
  })

  // The tests q-007's changeset committed to.
  it('creates a Task at the priority given', () => {
    let world = emptyWorld()
    const project = createProject(world, 'Home')
    const created = createTask(project.world, { title: 'Urgent', project: project.project.id, priority: 'high' })

    expect(created.ok).toBe(true)
    expect(created.task!.priority).toBe('high')
  })

  it('refuses a priority outside low/normal/high and creates nothing', () => {
    let world = emptyWorld()
    const project = createProject(world, 'Home')
    const created = createTask(project.world, { title: 'Bad', project: project.project.id, priority: 'urgent' })

    expect(created.ok).toBe(false)
    expect(created.task).toBeNull()
    expect(created.world.tasks).toEqual([])
    expect(created.message).toMatch(/is not a priority/)
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
    // "If the Project is not archived, deletion is blocked while it still holds any Task
    // that is not done, and the caller is told how many incomplete Tasks remain."
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
      world = completeTask(world, task.task!.id, TODAY).world
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

    world = endRecurrence(world, task.task!.id).world
    world = completeTask(world, task.task!.id, TODAY).world

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

  // "An archived Project is deleted unconditionally — regardless of any Task's done state —
  // taking all its Tasks with it. This deletion is permanent."
  it('deletes an archived Project even though its Tasks are incomplete', () => {
    const { world, projectId } = scenario()
    const archived = archiveProject(world, projectId)

    expect(archived.world.tasks[0]!.done).toBe(false)

    const result = deleteProject(archived.world, projectId)
    expect(result.ok).toBe(true)
    expect(result.world.projects).toEqual([])
    expect(result.world.tasks).toEqual([])
    expect(result.message).toMatch(/permanently deleted/)
  })

  it('deletes an archived Project holding a RecurringTask that was never completed', () => {
    const { world, projectId } = scenario({ recurrenceRule: 'FREQ=WEEKLY', dueDate: '2026-08-05' })
    const result = deleteProject(archiveProject(world, projectId).world, projectId)

    expect(result.ok).toBe(true)
    expect(result.world.projects).toEqual([])
  })

  // The two doors, back to back: the same Project, refused and then permitted.
  it('archiving is what turns a refusal into a deletion', () => {
    const { world, projectId } = scenario()

    expect(deleteProject(world, projectId).ok).toBe(false)
    expect(deleteProject(archiveProject(world, projectId).world, projectId).ok).toBe(true)
  })

  it('unarchiving puts the block back', () => {
    const { world, projectId } = scenario()
    const archived = archiveProject(world, projectId)
    const restored = unarchiveProject(archived.world, projectId)

    expect(deleteProject(restored.world, projectId).ok).toBe(false)
  })

  it('leaves other Projects alone when deleting an archived one', () => {
    let { world, projectId } = scenario()
    const other = createProject(world, 'Work')
    world = other.world
    world = createTask(world, { title: 'Untouched', project: other.project.id }).world

    const result = deleteProject(archiveProject(world, projectId).world, projectId)

    expect(result.world.projects.map((project) => project.name)).toEqual(['Work'])
    expect(result.world.tasks.map((task) => task.title)).toEqual(['Untouched'])
  })
})

describe('archiveProject', () => {
  it('defaults a new Project to not archived', () => {
    const project = createProject(emptyWorld(), 'Home')
    expect(project.project.archived).toBe(false)
  })

  // "marks it archived so it is hidden from default listings"
  it('marks the Project archived and drops it from the default listing', () => {
    const { world, projectId } = scenario()
    const result = archiveProject(world, projectId)

    expect(result.ok).toBe(true)
    expect(result.world.projects[0]!.archived).toBe(true)
    expect(activeProjects(result.world)).toEqual([])
    expect(archivedProjects(result.world).map((project) => project.id)).toEqual([projectId])
  })

  // "ends every RecurringTask it holds (per endRecurrence) so none schedule a further occurrence"
  it('ends every RecurringTask it holds', () => {
    let world = emptyWorld()
    const project = createProject(world, 'Home')
    world = project.world
    world = createTask(world, { title: 'Plants', project: project.project.id, recurrenceRule: 'FREQ=WEEKLY' }).world
    world = createTask(world, { title: 'Bins', project: project.project.id, recurrenceRule: 'FREQ=DAILY' }).world
    world = createTask(world, { title: 'Plain', project: project.project.id }).world

    const result = archiveProject(world, project.project.id)
    const repeating = result.world.tasks.filter(isRecurring)

    expect(repeating).toHaveLength(2)
    expect(repeating.every((task) => task.ended)).toBe(true)
    expect(result.message).toMatch(/ending 2 recurring Tasks/)
  })

  it('makes those ended Tasks stay done when completed, like any plain Task', () => {
    const { world, taskId, projectId } = scenario({ recurrenceRule: 'FREQ=WEEKLY', dueDate: '2026-08-05' })
    const archived = archiveProject(world, projectId)
    const done = completeTask(archived.world, taskId, TODAY)

    expect(done.world.tasks[0]!.done).toBe(true)
    expect(done.world.tasks[0]!.dueDate).toBe('2026-08-05')
  })

  it('leaves plain Tasks untouched', () => {
    const { world, projectId } = scenario()
    const result = archiveProject(world, projectId)

    expect(result.world.tasks[0]!.done).toBe(false)
    expect(isRecurring(result.world.tasks[0]!)).toBe(false)
  })

  // "Does not delete the Project or any of its Tasks"
  it('deletes nothing', () => {
    const { world, projectId } = scenario()
    const result = archiveProject(world, projectId)

    expect(result.world.projects).toHaveLength(1)
    expect(tasksOf(result.world, projectId)).toHaveLength(1)
  })

  it('does not touch other Projects or their recurring Tasks', () => {
    let { world, projectId } = scenario()
    const other = createProject(world, 'Work')
    world = other.world
    const elsewhere = createTask(world, {
      title: 'Standup',
      project: other.project.id,
      recurrenceRule: 'FREQ=WEEKLY',
    })
    world = elsewhere.world

    const result = archiveProject(world, projectId)
    const untouched = result.world.tasks.find((task) => task.id === elsewhere.task!.id)!

    expect(result.world.projects.find((project) => project.id === other.project.id)!.archived).toBe(false)
    expect(isRecurring(untouched) && untouched.ended).toBe(false)
  })

  it('is a no-op on an already-archived Project and does not error', () => {
    const { world, projectId } = scenario()
    const once = archiveProject(world, projectId)
    const twice = archiveProject(once.world, projectId)

    expect(twice.ok).toBe(true)
    expect(twice.world).toBe(once.world)
    expect(twice.message).toMatch(/was already archived/)
  })

  it('refuses a Project that does not exist', () => {
    const { world } = scenario()
    const result = archiveProject(world, 'project-999')

    expect(result.ok).toBe(false)
    expect(result.world).toBe(world)
  })
})

describe('unarchiveProject', () => {
  // "Restores an archived Project to active status, making it visible in default listings again."
  it('clears archived and returns the Project to the default listing', () => {
    const { world, projectId } = scenario()
    const restored = unarchiveProject(archiveProject(world, projectId).world, projectId)

    expect(restored.ok).toBe(true)
    expect(restored.world.projects[0]!.archived).toBe(false)
    expect(activeProjects(restored.world).map((project) => project.id)).toEqual([projectId])
  })

  // "Does not re-enable any RecurringTask that archiving ended — there is no function in
  // this vocabulary that resumes a recurrence once ended."
  it('leaves a recurrence archiving ended still ended', () => {
    const { world, projectId, taskId } = scenario({ recurrenceRule: 'FREQ=WEEKLY', dueDate: '2026-08-05' })
    const restored = unarchiveProject(archiveProject(world, projectId).world, projectId)
    const task = restored.world.tasks[0]!

    expect(isRecurring(task) && task.ended).toBe(true)

    // And so completing it finishes it, rather than scheduling another occurrence.
    const done = completeTask(restored.world, taskId, TODAY)
    expect(done.world.tasks[0]!.done).toBe(true)
    expect(done.world.tasks[0]!.dueDate).toBe('2026-08-05')
  })

  it('keeps the Project and its Tasks intact across archive and restore', () => {
    const { world, projectId } = scenario()
    const restored = unarchiveProject(archiveProject(world, projectId).world, projectId)

    expect(restored.world.projects).toHaveLength(1)
    expect(tasksOf(restored.world, projectId)).toHaveLength(1)
  })

  it('is a no-op on a Project that is not archived and does not error', () => {
    const { world, projectId } = scenario()
    const result = unarchiveProject(world, projectId)

    expect(result.ok).toBe(true)
    expect(result.world).toBe(world)
    expect(result.message).toMatch(/was not archived/)
  })

  it('refuses a Project that does not exist', () => {
    const { world } = scenario()
    expect(unarchiveProject(world, 'project-999').ok).toBe(false)
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

describe('deleteTask', () => {
  // The test q-005's changeset committed to.
  it('removes the target Task from its Project', () => {
    const { world, projectId, taskId } = scenario()
    const result = deleteTask(world, taskId)

    expect(result.ok).toBe(true)
    expect(tasksOf(result.world, projectId)).toEqual([])
  })

  it('refuses a Task that does not exist', () => {
    const { world } = scenario()
    const result = deleteTask(world, 'task-999')

    expect(result.ok).toBe(false)
    expect(result.world).toBe(world)
  })

  it('leaves other Tasks alone', () => {
    let { world, projectId, taskId } = scenario()
    world = createTask(world, { title: 'Survivor', project: projectId }).world

    const result = deleteTask(world, taskId)
    expect(result.world.tasks.map((task) => task.title)).toEqual(['Survivor'])
  })

  // deleteProject blocks on incomplete Tasks; this does not, so it is the way round it.
  it('deletes an incomplete Task, unlike deleteProject', () => {
    const { world, taskId } = scenario()
    expect(world.tasks[0]!.done).toBe(false)
    expect(deleteTask(world, taskId).ok).toBe(true)
  })
})

describe('moveTask', () => {
  /** Two Projects, with the Task in the first. */
  function twoProjects() {
    let world = emptyWorld()
    const home = createProject(world, 'Home')
    world = home.world
    const work = createProject(world, 'Work')
    world = work.world
    const task = createTask(world, { title: 'Water the plants', project: home.project.id })
    world = task.world

    return { world, homeId: home.project.id, workId: work.project.id, taskId: task.task!.id }
  }

  // The test q-005's changeset committed to.
  it('reassigns the Task and updates both Projects', () => {
    const { world, homeId, workId, taskId } = twoProjects()
    const result = moveTask(world, taskId, workId)

    expect(result.ok).toBe(true)
    expect(result.world.tasks[0]!.project).toBe(workId)
    expect(tasksOf(result.world, homeId)).toEqual([])
    expect(tasksOf(result.world, workId).map((task) => task.id)).toEqual([taskId])
  })

  it('refuses a destination that does not exist, leaving the Task where it was', () => {
    const { world, homeId, taskId } = twoProjects()
    const result = moveTask(world, taskId, 'project-999')

    expect(result.ok).toBe(false)
    expect(result.world).toBe(world)
    expect(tasksOf(world, homeId)).toHaveLength(1)
  })

  it('refuses a Task that does not exist', () => {
    const { world, workId } = twoProjects()
    expect(moveTask(world, 'task-999', workId).ok).toBe(false)
  })

  // The spec says "to a different Project" without saying what the same one does.
  it('is a no-op when the destination is the Project it is already in', () => {
    const { world, homeId, taskId } = twoProjects()
    const result = moveTask(world, taskId, homeId)

    expect(result.ok).toBe(true)
    expect(result.world).toBe(world)
    expect(result.message).toMatch(/already in/)
  })

  it('carries everything but the Project across', () => {
    let world = emptyWorld()
    const home = createProject(world, 'Home')
    world = home.world
    const work = createProject(world, 'Work')
    world = work.world
    const task = createTask(world, {
      title: 'Water the plants',
      project: home.project.id,
      priority: 'high',
      recurrenceRule: 'FREQ=WEEKLY',
      dueDate: '2026-08-05',
    })

    const moved = moveTask(task.world, task.task!.id, work.project.id)
    const after = moved.world.tasks[0]!

    expect(after.priority).toBe('high')
    expect(after.dueDate).toBe('2026-08-05')
    expect(isRecurring(after) && after.recurrenceRule).toBe('FREQ=WEEKLY')
  })
})
