/**
 * implements: Project, Task, RecurringTask, Priority, completeTask, reopenTask, deleteProject, endRecurrence, resumeRecurrence, createProject, createTask, deleteTask, moveTask, archiveProject, unarchiveProject
 *
 * Intentionally bare. The point is to exercise the spec'd behaviour, not to be a good
 * ToDo app — so every spec'd function reports what it did into the log at the bottom,
 * including the no-ops the specs require and the refusal deleteProject can return.
 */
import { useMemo, useState } from 'react'
import { archiveProject, recurrencesEndedByArchiving } from './domain/archiveProject.js'
import { completeTask } from './domain/completeTask.js'
import { deleteProject } from './domain/deleteProject.js'
import { unarchiveProject } from './domain/unarchiveProject.js'
import { deleteTask } from './domain/deleteTask.js'
import { moveTask } from './domain/moveTask.js'
import { endRecurrence } from './domain/endRecurrence.js'
import { resumeRecurrence } from './domain/resumeRecurrence.js'
import { reopenTask } from './domain/reopenTask.js'
import type { AnyTask, Project, Result, World } from './domain/types.js'
import { PRIORITIES, isRecurring } from './domain/types.js'
import { activeProjects, createProject, createTask, seedWorld, tasksOf } from './domain/world.js'
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
  /** Archived Projects are "hidden from default listings" — this is what opts out of the default. */
  const [showArchived, setShowArchived] = useState(false)
  /**
   * The Project whose Archive click is waiting to be confirmed, if any. Held as an id
   * rather than a boolean so selecting a different Project cannot leave a stale
   * confirmation armed against the wrong one.
   */
  const [confirmingArchive, setConfirmingArchive] = useState<string | null>(null)

  const [projectName, setProjectName] = useState('')
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [rule, setRule] = useState('')
  const [priority, setPriority] = useState('normal')

  const listed = useMemo(() => (showArchived ? world.projects : activeProjects(world)), [world, showArchived])
  const selected = world.projects.find((project) => project.id === openProject) ?? listed[0] ?? null
  const tasks = useMemo(() => (selected ? tasksOf(world, selected.id) : []), [world, selected])

  /**
   * archiveProject "ends every RecurringTask it holds that is not already ended", and since
   * q-009 unarchiveProject "resumes it (per resumeRecurrence)" for exactly those. So this is
   * no longer a warning about something irreversible — it is still said before the click,
   * because a repeating Task silently stopping is a surprise either way.
   */
  const willEnd = selected ? recurrencesEndedByArchiving(world, selected.id) : []
  const confirming = selected !== null && confirmingArchive === selected.id

  /**
   * Archiving with no live recurrence goes straight through. Archiving that would stop one
   * says which, and waits.
   */
  function askToArchive() {
    if (!selected) return
    if (willEnd.length > 0 && !confirming) {
      setConfirmingArchive(selected.id)
      return
    }
    setConfirmingArchive(null)
    run(archiveProject(world, selected.id))
  }

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

          {listed.length === 0 ? (
            <p className="muted">
              {world.projects.length === 0 ? 'No Projects. Create one to start.' : 'No active Projects.'}
            </p>
          ) : (
            <ul className="list">
              {listed.map((project) => {
                const held = tasksOf(world, project.id)
                const open = held.filter((task) => !task.done).length
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={`project ${project.id === selected?.id ? 'on' : ''} ${
                        project.archived ? 'archived' : ''
                      }`}
                      onClick={() => setOpenProject(project.id)}
                    >
                      <span>
                        {project.name}
                        {project.archived && <span className="badge badge-ended">archived</span>}
                      </span>
                      <span className="muted count">
                        {held.length === 0 ? 'empty' : `${open}/${held.length} open`}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {/* Archived Projects are not gone — deleteProject is what removes them for good. */}
          <label className="row muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Show archived
          </label>
        </section>

        <section className="pane">
          {selected ? (
            <>
              <div className="pane-header">
                <h2>
                  {selected.name}
                  {selected.archived && <span className="badge badge-ended">archived</span>}
                </h2>

                {selected.archived ? (
                  <button type="button" onClick={() => run(unarchiveProject(world, selected.id))}>
                    Restore
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={askToArchive}
                    aria-expanded={confirming}
                    title="Hide it from the list and stop its recurring Tasks — reversible"
                  >
                    Archive
                  </button>
                )}

                <button
                  type="button"
                  className="danger"
                  onClick={() => run(deleteProject(world, selected.id))}
                  title={
                    selected.archived
                      ? 'Deletes permanently, whatever state its Tasks are in'
                      : 'Blocked while it holds incomplete Tasks — archive it first'
                  }
                >
                  Delete project
                </button>
              </div>

              {/* Only once you have actually asked to archive. A warning that is always on
                  screen is describing a consequence of something you have not done, and it
                  is on every Project with a live recurrence — so it reads as decoration and
                  gets skipped, which is exactly what you cannot afford here. The recurring
                  Tasks carry a ↻ badge of their own; that is the standing signal. */}
              {confirming && (
                <div className="warning asking" role="alertdialog">
                  <p>
                    Archiving will also end {willEnd.length} recurring{' '}
                    {willEnd.length === 1 ? 'Task' : 'Tasks'} ({willEnd.join(', ')}). Restoring the Project starts{' '}
                    {willEnd.length === 1 ? 'it' : 'them'} repeating again — a recurrence you ended yourself stays
                    ended.
                  </p>

                  <p className="confirm">
                    <strong>Archive anyway?</strong>
                    <button type="button" onClick={askToArchive} autoFocus>
                      End {willEnd.length === 1 ? 'it' : 'them'} and archive
                    </button>
                    <button type="button" onClick={() => setConfirmingArchive(null)}>
                      Cancel
                    </button>
                  </p>
                </div>
              )}

              {selected.archived && (
                <div className="warning">
                  <p>
                    Archived: hidden from the default list, and any recurring Tasks it held have been ended —
                    Restore starts those repeating again. Deleting it now is permanent and takes its{' '}
                    {tasks.length} {tasks.length === 1 ? 'Task' : 'Tasks'} with it.
                  </p>
                </div>
              )}

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
                      onResume={() => run(resumeRecurrence(world, task.id))}
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
  onResume,
  onDelete,
  onMove,
  elsewhere,
}: {
  task: AnyTask
  onComplete: () => void
  onReopen: () => void
  onEnd: () => void
  onResume: () => void
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
        {/* The other direction, added by q-009. Offered on any ended RecurringTask, however
            it was ended: resumeRecurrence does not read endedByArchiving to decide whether
            to act, only unarchiveProject does, to decide which Tasks to put through it. */}
        {recurring && task.ended && (
          <button type="button" onClick={onResume} title="Start it repeating again from its rule">
            Resume
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
