/**
 * The entry point: read argv, translate it (commands.ts), and shell out to `docker compose`.
 *
 * This file owns everything impure — resolving the compose file, spawning docker, exit codes —
 * and nothing else. The translation it drives is pure and tested separately, so the only things
 * that can go wrong here are the ones that need a real machine: docker missing, or a non-zero
 * exit from compose itself, both of which are reported plainly.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { composeArgv, parseArgs, USAGE } from './commands.js'

/**
 * Where the compose file lives. Build-local v1 drives the compose that ships with the source,
 * so the default is resolved relative to this package (packages/cli/src -> repo root). The
 * installer that fetches source keeps the two co-located, so this holds there too; SPECTRA_COMPOSE_FILE
 * and --compose-file override it.
 */
function defaultComposeFile(): string {
  return process.env.SPECTRA_COMPOSE_FILE ?? path.resolve(import.meta.dirname, '../../..', 'docker-compose.yml')
}

function version(): string {
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'))
  return pkg.version as string
}

async function main(): Promise<number> {
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
    case 'run': {
      const composeFile = parsed.composeFile ?? defaultComposeFile()
      const args = composeArgv(parsed.component, parsed.verb, composeFile)
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
