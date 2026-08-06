/**
 * implements: Project, Task, RecurringTask, Priority, completeTask, reopenTask, deleteProject, endRecurrence, createProject, createTask, deleteTask, moveTask
 *
 * Intentionally bare. The point is to exercise the spec'd behaviour, not to be a good
 * ToDo app — so every spec'd function reports what it did into the log at the bottom,
 * including the no-ops the specs require and the refusal deleteProject can return.
 */
import { useMemo, useState } from 'react'
import { completeTask } from './domain/completeTask.js'
import { deleteProject } from './domain/deleteProject.js'
import { deleteTask } from './domain/deleteTask.js'
import { moveTask } from './domain/moveTask.js'
import { endRecurrence } from './domain/endRecurrence.js'
import { reopenTask } from './domain/reopenTask.js'
import type { AnyTask, Project, Result, World } from './domain/types.js'
import { PRIORITIES, isRecurring } from './domain/types.js'
import { createProject, createTask, seedWorld, tasksOf } from './domain/world.js'
import { describeRule } from './describeRule.js'

interface LogEntry {
  id: number
  ok: boolean
  message: string
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** An unreadable rule shows as written, so a bad rule looks wrong rather than missing. */
function phrase(rule: string): string {
  const described = describeRule(rule)
  return 'text' in described ? described.text : rule
}

export function App() {
  const [world, setWorld] = useState<World>(seedWorld)
  const [log, setLog] = useState<LogEntry[]>([])
  const [openProject, setOpenProject] = useState<string | null>(null)

  const [projectName, setProjectName] = useState('')
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [rule, setRule] = useState('')
  const [priority, setPriority] = useState('normal')

  const selected = world.projects.find((project) => project.id === openProject) ?? world.projects[0] ?? null
  const tasks = useMemo(() => (selected ? tasksOf(world, selected.id) : []), [world, selected])

  /** Runs a spec'd function and records what it said. */
  function run(result: Result) {
    setWorld(result.world)
    setLog((entries) => [{ id: entries.length, ok: result.ok, message: result.message }, ...entries])
  }

  function addProject(event: React.FormEvent) {
    event.preventDefault()
    if (!projectName.trim()) return
    const created = createProject(world, projectName.trim())
    setWorld(created.world)
    setOpenProject(created.project.id)
    setProjectName('')
  }

  function addTask(event: React.FormEvent) {
    event.preventDefault()
    if (!title.trim() || !selected) return

    const created = createTask(world, {
      title: title.trim(),
      project: selected.id,
      dueDate: dueDate || null,
      recurrenceRule: rule.trim() || null,
      priority,
    })

    // createTask can refuse since q-007, so it reports like every other spec'd function.
    run(created)
    if (!created.ok) return

    setTitle('')
    setDueDate('')
    setRule('')
    setPriority('normal')
  }

  return (
    <div className="app">
      <header>
        <h1>ToDo</h1>
        <span className="muted">implemented from specs/terms — the spec tool runs separately on :5173</span>
      </header>

      <div className="panes">
        <section className="pane">
          <h2>Projects</h2>

          <form className="row" onSubmit={addProject}>
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="New project"
              aria-label="New project name"
            />
            <button type="submit">Add</button>
          </form>

          {world.projects.length === 0 ? (
            <p className="muted">No Projects. Create one to start.</p>
          ) : (
            <ul className="list">
              {world.projects.map((project) => {
                const held = tasksOf(world, project.id)
                const open = held.filter((task) => !task.done).length
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={`project ${project.id === selected?.id ? 'on' : ''}`}
                      onClick={() => setOpenProject(project.id)}
                    >
                      <span>{project.name}</span>
                      <span className="muted count">
                        {held.length === 0 ? 'empty' : `${open}/${held.length} open`}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="pane">
          {selected ? (
            <>
              <div className="pane-header">
                <h2>{selected.name}</h2>
                <button type="button" className="danger" onClick={() => run(deleteProject(world, selected.id))}>
                  Delete project
                </button>
              </div>

              <form className="row wrap" onSubmit={addTask}>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="New task"
                  aria-label="New task title"
                />
                <input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  aria-label="Due date"
                />
                <input
                  value={rule}
                  onChange={(event) => setRule(event.target.value)}
                  placeholder="RRULE, e.g. FREQ=WEEKLY"
                  aria-label="Recurrence rule — leave blank for a plain Task"
                />
                <select
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  aria-label="Priority"
                >
                  {PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <button type="submit">Add</button>
              </form>

              {tasks.length === 0 ? (
                <p className="muted">No Tasks in this Project.</p>
              ) : (
                <ul className="list">
                  {tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onComplete={() => run(completeTask(world, task.id, today()))}
                      onReopen={() => run(reopenTask(world, task.id))}
                      onEnd={() => run(endRecurrence(world, task.id))}
                      onDelete={() => run(deleteTask(world, task.id))}
                      onMove={(destination) => run(moveTask(world, task.id, destination))}
                      elsewhere={world.projects.filter((project) => project.id !== task.project)}
                    />
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">Nothing selected.</p>
          )}
        </section>
      </div>

      <section className="log">
        <h2>What the spec'd functions said</h2>
        {log.length === 0 ? (
          <p className="muted">Nothing yet — complete a Task, or try deleting a Project that still has open ones.</p>
        ) : (
          <ul className="list">
            {log.map((entry) => (
              <li key={entry.id} className={entry.ok ? 'said' : 'said refused'}>
                {entry.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function TaskRow({
  task,
  onComplete,
  onReopen,
  onEnd,
  onDelete,
  onMove,
  elsewhere,
}: {
  task: AnyTask
  onComplete: () => void
  onReopen: () => void
  onEnd: () => void
  onDelete: () => void
  onMove: (destination: string) => void
  /** Projects this Task is not already in — nothing to offer when there are none. */
  elsewhere: Project[]
}) {
  const recurring = isRecurring(task)

  return (
    <li className={`task ${task.done ? 'done' : ''}`}>
      <span className="title">{task.title}</span>

      {/* Shown on every row because Task.priority is never absent — and because seeing
          "normal" everywhere with no way to change it is the honest picture (q-007). */}
      <span className={`priority priority-${task.priority}`}>{task.priority}</span>

      {recurring && (
        // The raw RRULE stays as the tooltip — the phrasing is for reading, the rule is
        // what the app actually runs, and you should be able to see both.
        <span className={`badge ${task.ended ? 'badge-ended' : ''}`} title={task.recurrenceRule}>
          {task.ended ? '⊘ ended' : `↻ ${phrase(task.recurrenceRule)}`}
        </span>
      )}
      {task.dueDate && <span className="muted due">due {task.dueDate}</span>}

      <span className="actions">
        <button type="button" onClick={onComplete}>
          Complete
        </button>
        <button type="button" onClick={onReopen}>
          Reopen
        </button>
        {/* Only a RecurringTask has recurrence to end, and ending twice is a no-op anyway. */}
        {recurring && !task.ended && (
          <button type="button" onClick={onEnd} title="Stop it repeating — completing it then finishes it">
            End
          </button>
        )}
        {elsewhere.length > 0 && (
          <select
            value=""
            aria-label={`Move "${task.title}" to another Project`}
            onChange={(event) => event.target.value && onMove(event.target.value)}
          >
            <option value="">Move to…</option>
            {elsewhere.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="danger" onClick={onDelete} title="Delete this Task outright">
          Delete
        </button>
      </span>
    </li>
  )
}
