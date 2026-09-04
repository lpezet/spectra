/**
 * The entry point: read argv, translate it (commands.ts), and shell out to `docker compose`.
 *
 * This file owns everything impure — resolving the compose file, spawning docker, exit codes —
 * and nothing else. The translation it drives is pure and tested separately, so the only things
 * that can go wrong here are the ones that need a real machine: docker missing, or a non-zero
 * exit from compose itself, both of which are reported plainly.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeArgv, composeBuildArgv, composeStackArgv, parseArgs, USAGE } from './commands.js'
import { INIT_USAGE, applyInitPlan, parseInitArgs, planInit } from './init.js'

/**
 * The compose files to drive when none are given on the command line. Default is the repo's
 * `docker-compose.yml`, resolved relative to this package (packages/cli/src -> repo root) — the
 * contributors' file. SPECTRA_COMPOSE_FILE overrides it, and `--compose-file` (repeatable) takes
 * precedence entirely. Once `spectra init` exists it will point this at `default.yaml` plus a
 * per-project override.
 */
function defaultComposeFiles(): string[] {
  if (process.env.SPECTRA_COMPOSE_FILE) return [process.env.SPECTRA_COMPOSE_FILE]
  return [path.resolve(import.meta.dirname, '../../..', 'docker-compose.yml')]
}

function version(): string {
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'))
  return pkg.version as string
}

/** XDG homes, matching how the server resolves DATA_DIR. */
function configHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}
function dataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
}

/** A readable, stable, collision-resistant id: the repo folder name plus a short random suffix. */
function newProjectId(repoDir: string): string {
  const base = path.basename(repoDir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  return `${base}-${randomBytes(3).toString('hex')}`
}

function runInit(argv: string[]): number {
  const parsed = parseInitArgs(argv)
  if (parsed.kind === 'help') {
    console.log(INIT_USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    console.error(parsed.message)
    console.error('\nRun `spectra init --help` for usage.')
    return 2
  }

  const repoDir = process.cwd()
  const linkPath = path.join(repoDir, '.spectra', 'config.json')
  if (existsSync(linkPath) && !parsed.options.force) {
    console.error(`${linkPath} already exists. Re-run with --force to overwrite.`)
    return 1
  }

  const plan = planInit({
    repoDir,
    name: parsed.options.name,
    domain: parsed.options.domain,
    coderDir: parsed.options.coderDir,
    server: parsed.options.server,
    configHome: configHome(),
    dataHome: dataHome(),
    id: newProjectId(repoDir),
  })

  if (parsed.options.dryRun) {
    console.log(`Would write (project ${plan.id}):`)
    for (const file of plan.files) console.log(`  ${file.path}`)
    return 0
  }

  applyInitPlan(plan)
  console.log(`Initialized Spectra project ${plan.id}.`)
  console.log(`  link:     ${linkPath}`)
  console.log(`  glossary: ${plan.glossaryDir}`)
  console.log(`  coder:    ${plan.coderMount}`)
  console.log('\nStart it with:')
  console.log(`  spectra up --compose-file default.yaml --compose-file ${plan.overridePath}`)
  console.log('(auto-discovery of the override is coming; for now pass it explicitly.)')
  return 0
}

async function main(): Promise<number> {
  if (process.argv[2] === 'init') return runInit(process.argv.slice(3))

  const parsed = parseArgs(process.argv.slice(2))

  switch (parsed.kind) {
    case 'help':
      console.log(USAGE)
      return 0
    case 'version':
      console.log(version())
      return 0
    case 'error':
      console.error(parsed.message)
      console.error('\nRun `spectra --help` for usage.')
      return 2
    case 'run':
    case 'stack':
    case 'build': {
      const composeFiles = parsed.composeFiles.length > 0 ? parsed.composeFiles : defaultComposeFiles()
      const args =
        parsed.kind === 'run'
          ? composeArgv(parsed.component, parsed.verb, composeFiles)
          : parsed.kind === 'stack'
            ? composeStackArgv(parsed.action, composeFiles)
            : composeBuildArgv(parsed.component, composeFiles)
      if (parsed.dryRun) {
        console.log(['docker', 'compose', ...args].join(' '))
        return 0
      }
      return runDockerCompose(args)
    }
  }
}

/** Spawn `docker compose <args>`, inheriting stdio so logs/prompts pass straight through. */
function runDockerCompose(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', ...args], { stdio: 'inherit' })
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error('docker not found on PATH. Spectra drives the stack through docker compose — install Docker first.')
      } else {
        console.error(`Failed to run docker compose: ${error.message}`)
      }
      resolve(127)
    })
    child.on('close', (code) => resolve(code ?? 0))
  })
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
