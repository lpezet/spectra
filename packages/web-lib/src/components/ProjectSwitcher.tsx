/**
 * The org ▸ project picker, top-left — the Typeform/Postman shape: choose an org, then a project
 * within it. Purely presentational; the parent owns the lists, the current selection, and what
 * happens on change (fetch the org's projects, reconfigure the API base, reload the glossary).
 *
 * A single option is shown but not worth choosing, so its select is disabled — the local
 * single-project install reads as "here is where you are", never "pick the only thing there is".
 */
import type { Org, ProjectSummary } from '../glossaryTransport.js'

export function ProjectSwitcher(props: {
  orgs: Org[]
  projects: ProjectSummary[]
  org: string | null
  projectId: string | null
  onOrg: (org: string) => void
  onProject: (projectId: string) => void
}) {
  return (
    <div className="project-switcher">
      <select
        className="switcher-org"
        aria-label="Organization"
        value={props.org ?? ''}
        disabled={props.orgs.length <= 1}
        onChange={(event) => props.onOrg(event.target.value)}
      >
        {props.orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
      <span className="switcher-sep" aria-hidden="true">
        /
      </span>
      <select
        className="switcher-project"
        aria-label="Project"
        value={props.projectId ?? ''}
        disabled={props.projects.length <= 1}
        onChange={(event) => props.onProject(event.target.value)}
      >
        {props.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </div>
  )
}
