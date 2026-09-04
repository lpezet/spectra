/**
 * The translation is the CLI's whole job, so it is tested exhaustively here — parsing an argv
 * tail into an intent, and mapping a component+verb onto the docker compose argv. No docker is
 * needed (that is the point of keeping composeArgv pure); the runner in cli.ts is the only part
 * that touches a real daemon, and it is deliberately thin.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPONENTS,
  VERBS,
  composeArgv,
  composeInstallArgv,
  composeStackArgv,
  parseArgs,
} from './commands.js'

const FILE = '/repo/docker-compose.yml'

describe('composeArgv', () => {
  it('maps server -> the spec service (the name lives on in the compose file)', () => {
    expect(composeArgv('server', 'start', FILE)).toEqual(['-f', FILE, 'up', '-d', 'spec'])
    expect(composeArgv('server', 'stop', FILE)).toEqual(['-f', FILE, 'stop', 'spec'])
    expect(composeArgv('server', 'status', FILE)).toEqual(['-f', FILE, 'ps', 'spec'])
    expect(composeArgv('server', 'logs', FILE)).toEqual(['-f', FILE, 'logs', '-f', 'spec'])
  })

  it('carries --profile web for the profiled web service, on every verb', () => {
    expect(composeArgv('web', 'start', FILE)).toEqual(['-f', FILE, '--profile', 'web', 'up', '-d', 'web'])
    expect(composeArgv('web', 'stop', FILE)).toEqual(['-f', FILE, '--profile', 'web', 'stop', 'web'])
  })

  it('does not add a profile for non-profiled services', () => {
    expect(composeArgv('coder', 'restart', FILE)).toEqual(['-f', FILE, 'restart', 'coder'])
  })

  it('produces a valid command for every component/verb pair', () => {
    for (const component of COMPONENTS) {
      for (const verb of VERBS) {
        const argv = composeArgv(component, verb, FILE)
        expect(argv[0]).toBe('-f')
        expect(argv[1]).toBe(FILE)
        expect(argv.length).toBeGreaterThan(2)
      }
    }
  })
})

describe('composeStackArgv', () => {
  it('brings the whole stack up with the web profile enabled', () => {
    expect(composeStackArgv('up', FILE)).toEqual(['-f', FILE, '--profile', 'web', 'up', '-d'])
  })
  it('tears it all down without a profile (down ignores profiles)', () => {
    expect(composeStackArgv('down', FILE)).toEqual(['-f', FILE, 'down'])
  })
})

describe('composeInstallArgv', () => {
  it('builds everything (web profile enabled) when no component is named', () => {
    expect(composeInstallArgv(undefined, FILE)).toEqual(['-f', FILE, '--profile', 'web', 'build'])
  })
  it('builds a single service, translating server -> spec', () => {
    expect(composeInstallArgv('server', FILE)).toEqual(['-f', FILE, 'build', 'spec'])
  })
  it('carries the web profile when building web', () => {
    expect(composeInstallArgv('web', FILE)).toEqual(['-f', FILE, '--profile', 'web', 'build', 'web'])
  })
})

describe('parseArgs', () => {
  it('parses a component + verb into a run intent', () => {
    expect(parseArgs(['server', 'start'])).toEqual({
      kind: 'run',
      component: 'server',
      verb: 'start',
      dryRun: false,
      composeFile: undefined,
    })
  })

  it('picks up --dry-run and --compose-file in any position', () => {
    expect(parseArgs(['--dry-run', 'web', 'logs'])).toMatchObject({ kind: 'run', dryRun: true })
    expect(parseArgs(['web', 'start', '--compose-file', '/x.yml'])).toMatchObject({
      kind: 'run',
      composeFile: '/x.yml',
    })
  })

  it('treats no args and -h/--help as help', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' })
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' })
  })

  it('reports -v/--version', () => {
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' })
  })

  it('errors on an unknown component or verb, naming the valid set', () => {
    expect(parseArgs(['nope', 'start'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'fly'])).toMatchObject({ kind: 'error' })
  })

  it('parses whole-stack up/down', () => {
    expect(parseArgs(['up'])).toMatchObject({ kind: 'stack', action: 'up' })
    expect(parseArgs(['down', '--dry-run'])).toMatchObject({ kind: 'stack', action: 'down', dryRun: true })
  })

  it('errors when up/down is given a stray argument', () => {
    expect(parseArgs(['up', 'server'])).toMatchObject({ kind: 'error' })
  })

  it('parses install with no component, with "all", and with a component', () => {
    expect(parseArgs(['install'])).toMatchObject({ kind: 'install', component: undefined })
    expect(parseArgs(['install', 'all'])).toMatchObject({ kind: 'install', component: undefined })
    expect(parseArgs(['install', 'web'])).toMatchObject({ kind: 'install', component: 'web' })
  })

  it('errors on install with an unknown component', () => {
    expect(parseArgs(['install', 'nope'])).toMatchObject({ kind: 'error' })
  })

  it('errors when a component is given without a verb', () => {
    expect(parseArgs(['server'])).toMatchObject({ kind: 'error' })
  })

  it('errors on an unknown option and on a missing --compose-file value', () => {
    expect(parseArgs(['server', 'start', '--wat'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'start', '--compose-file'])).toMatchObject({ kind: 'error' })
  })

  it('errors on an extra positional argument', () => {
    expect(parseArgs(['server', 'start', 'extra'])).toMatchObject({ kind: 'error' })
  })
})
