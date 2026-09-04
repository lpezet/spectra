/**
 * The CLI's whole grammar, as pure functions.
 *
 * `spectra` does not run the stack itself — it wraps `docker compose`, which is the actual
 * process supervisor. So the interesting logic here is a *translation*: a friendly noun-verb
 * command in, the `docker compose` argv out. Keeping that translation pure (no spawning, no
 * filesystem) is what lets it be tested exhaustively without a docker daemon — the runner in
 * cli.ts is the thin part that actually shells out.
 *
 * The command shape is gcloud/SAL-style: `spectra <component> <verb>`. Components are the three
 * pieces of the stack; verbs map one-to-one onto compose subcommands.
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
 * out — see docker-compose.yml). Targeting it by name still requires the profile to be enabled,
 * so every command that drives it carries `--profile web`.
 */
const PROFILE: Partial<Record<Component, string>> = { web: 'web' }

/**
 * The full `docker compose` argv for a component+verb — everything after `docker compose`,
 * including the `-f <file>` selector so the command does not depend on the current directory.
 * `-f` and `--profile` are top-level flags and precede the subcommand.
 */
export function composeArgv(component: Component, verb: Verb, composeFile: string): string[] {
  const service = SERVICE[component]
  const profile = PROFILE[component] ? ['--profile', PROFILE[component] as string] : []
  const subcommand: Record<Verb, string[]> = {
    start: ['up', '-d', service],
    stop: ['stop', service],
    restart: ['restart', service],
    status: ['ps', service],
    logs: ['logs', '-f', service],
  }
  return ['-f', composeFile, ...profile, ...subcommand[verb]]
}

export type Parsed =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; component: Component; verb: Verb; dryRun: boolean; composeFile?: string }
  | { kind: 'error'; message: string }

function isComponent(value: string): value is Component {
  return (COMPONENTS as readonly string[]).includes(value)
}
function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value)
}

/**
 * Parse an argv tail (everything after the program name) into an intent. Unknown input yields
 * an `error` carrying a message rather than throwing — cli.ts decides how to present it.
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
  const [component, verb, ...extra] = positional
  if (!isComponent(component)) {
    return { kind: 'error', message: `Unknown component "${component}". Expected one of: ${COMPONENTS.join(', ')}.` }
  }
  if (verb === undefined) {
    return { kind: 'error', message: `"${component}" needs a verb: ${VERBS.join(', ')}.` }
  }
  if (!isVerb(verb)) {
    return { kind: 'error', message: `Unknown verb "${verb}" for "${component}". Expected one of: ${VERBS.join(', ')}.` }
  }
  if (extra.length > 0) {
    return { kind: 'error', message: `Unexpected argument "${extra[0]}".` }
  }
  return { kind: 'run', component, verb, dryRun, composeFile }
}

export const USAGE = `spectra — control the Spectra stack (a thin wrapper over docker compose)

Usage:
  spectra <component> <verb> [options]

Components:
  server    the spec tool API + agents   (compose service: spec)
  coder     the sandboxed @coder         (compose service: coder)
  web       the web UI                   (compose service: web)

Verbs:
  start     bring the piece up      (docker compose up -d)
  stop      stop it                 (docker compose stop)
  restart   restart it              (docker compose restart)
  status    show its state          (docker compose ps)
  logs      follow its logs         (docker compose logs -f)

Options:
  --dry-run             print the docker compose command instead of running it
  --compose-file <path> use a specific compose file
  -h, --help            show this help
  -v, --version         show the version

Examples:
  spectra server start
  spectra web logs
  spectra coder stop`
