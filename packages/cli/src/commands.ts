/**
 * The CLI's whole grammar, as pure functions.
 *
 * `spectra` does not run the stack itself — it wraps `docker compose`, which is the actual
 * process supervisor. So the interesting logic here is a *translation*: a friendly command in,
 * the `docker compose` argv out. Keeping that translation pure (no spawning, no filesystem) is
 * what lets it be tested exhaustively without a docker daemon — the runner in cli.ts is the thin
 * part that actually shells out.
 *
 * Two command shapes, both gcloud/SAL-flavoured:
 *   - per-component:  `spectra <component> <verb>`   (control one piece)
 *   - whole-stack:    `spectra up | down | install`  (the lifecycle across all pieces)
 */

export const COMPONENTS = ['server', 'coder', 'web'] as const
export type Component = (typeof COMPONENTS)[number]

export const VERBS = ['start', 'stop', 'restart', 'status', 'logs'] as const
export type Verb = (typeof VERBS)[number]

/**
 * The friendly component name the CLI presents, mapped to the compose service it drives.
 * `server` is the `spec` service: the name predates the product rename and lives on in the
 * compose file, so the CLI translates rather than making a user learn the old one.
 */
const SERVICE: Record<Component, string> = { server: 'spec', coder: 'coder', web: 'web' }

/**
 * `web` is the one service behind a compose profile (so a plain `docker compose up` leaves it
 * out — see docker-compose.yml). Any command that touches it must enable the profile, so it
 * carries `--profile web`; whole-stack commands enable it too, so `up`/`install` cover web.
 */
const PROFILE_ARGS = ['--profile', 'web']
function profileFor(component: Component): string[] {
  return component === 'web' ? PROFILE_ARGS : []
}

/**
 * The `docker compose` argv for one component+verb — everything after `docker compose`, including
 * the `-f <file>` selector so the command does not depend on the current directory. `-f` and
 * `--profile` are top-level flags and precede the subcommand.
 */
export function composeArgv(component: Component, verb: Verb, composeFile: string): string[] {
  const service = SERVICE[component]
  const subcommand: Record<Verb, string[]> = {
    start: ['up', '-d', service],
    stop: ['stop', service],
    restart: ['restart', service],
    status: ['ps', service],
    logs: ['logs', '-f', service],
  }
  return ['-f', composeFile, ...profileFor(component), ...subcommand[verb]]
}

/** Whole-stack up/down. `up` enables the web profile so the full stack really is up. */
export function composeStackArgv(action: 'up' | 'down', composeFile: string): string[] {
  if (action === 'up') return ['-f', composeFile, ...PROFILE_ARGS, 'up', '-d']
  // `down` removes every container in the project regardless of profile, so it needs none.
  return ['-f', composeFile, 'down']
}

/**
 * `install` provisions images — `docker compose build`. Build-local v1 builds from the source in
 * the compose's build contexts; a later `pull` variant would fetch prebuilt images instead. With
 * no component it builds everything (web profile enabled); with one, just that service.
 */
export function composeInstallArgv(component: Component | undefined, composeFile: string): string[] {
  if (component === undefined) return ['-f', composeFile, ...PROFILE_ARGS, 'build']
  return ['-f', composeFile, ...profileFor(component), 'build', SERVICE[component]]
}

export type Parsed =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; component: Component; verb: Verb; dryRun: boolean; composeFile?: string }
  | { kind: 'stack'; action: 'up' | 'down'; dryRun: boolean; composeFile?: string }
  | { kind: 'install'; component?: Component; dryRun: boolean; composeFile?: string }
  | { kind: 'error'; message: string }

function isComponent(value: string): value is Component {
  return (COMPONENTS as readonly string[]).includes(value)
}
function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value)
}

/**
 * Parse an argv tail (everything after the program name) into an intent. Unknown input yields an
 * `error` carrying a message rather than throwing — cli.ts decides how to present it.
 */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = []
  let dryRun = false
  let composeFile: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') return { kind: 'help' }
    if (arg === '-v' || arg === '--version') return { kind: 'version' }
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--compose-file') {
      composeFile = argv[i + 1]
      if (!composeFile) return { kind: 'error', message: '--compose-file needs a path.' }
      i += 1
    } else if (arg.startsWith('-')) {
      return { kind: 'error', message: `Unknown option "${arg}".` }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) return { kind: 'help' }
  const [head, second, ...rest] = positional

  // Whole-stack lifecycle commands.
  if (head === 'up' || head === 'down') {
    if (second !== undefined) return { kind: 'error', message: `Unexpected argument "${second}".` }
    return { kind: 'stack', action: head, dryRun, composeFile }
  }
  if (head === 'install') {
    if (second !== undefined && second !== 'all' && !isComponent(second)) {
      return { kind: 'error', message: `Unknown component "${second}". Expected one of: ${COMPONENTS.join(', ')}, or all.` }
    }
    if (rest.length > 0) return { kind: 'error', message: `Unexpected argument "${rest[0]}".` }
    const component = second && second !== 'all' ? (second as Component) : undefined
    return { kind: 'install', component, dryRun, composeFile }
  }

  // Per-component command.
  if (!isComponent(head)) {
    return { kind: 'error', message: `Unknown command "${head}". Expected a component (${COMPONENTS.join(', ')}) or up/down/install.` }
  }
  if (second === undefined) {
    return { kind: 'error', message: `"${head}" needs a verb: ${VERBS.join(', ')}.` }
  }
  if (!isVerb(second)) {
    return { kind: 'error', message: `Unknown verb "${second}" for "${head}". Expected one of: ${VERBS.join(', ')}.` }
  }
  if (rest.length > 0) return { kind: 'error', message: `Unexpected argument "${rest[0]}".` }
  return { kind: 'run', component: head, verb: second, dryRun, composeFile }
}

export const USAGE = `spectra — control the Spectra stack (a thin wrapper over docker compose)

Usage:
  spectra <component> <verb> [options]
  spectra up | down | install [component] [options]

Components:
  server    the spec tool API + agents   (compose service: spec)
  coder     the sandboxed @coder         (compose service: coder)
  web        the web UI                  (compose service: web)

Verbs (per component):
  start     bring the piece up      (docker compose up -d)
  stop      stop it                 (docker compose stop)
  restart   restart it              (docker compose restart)
  status    show its state          (docker compose ps)
  logs      follow its logs         (docker compose logs -f)

Lifecycle (whole stack):
  install [component]   build images    (docker compose build); all pieces if none named
  up                    bring the whole stack up   (docker compose up -d)
  down                  tear it all down           (docker compose down)

Options:
  --dry-run             print the docker compose command instead of running it
  --compose-file <path> use a specific compose file
  -h, --help            show this help
  -v, --version         show the version

Examples:
  spectra install
  spectra up
  spectra server logs
  spectra web restart`
