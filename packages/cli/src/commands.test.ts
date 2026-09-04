/**
 * The translation is the CLI's whole job, so it is tested exhaustively here — parsing an argv
 * tail into an intent, and mapping a command onto the docker compose argv. No docker is needed
 * (that is the point of keeping the builders pure); the runner in cli.ts is the only part that
 * touches a real daemon, and it is deliberately thin.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPONENTS,
  VERBS,
  composeArgv,
  composeBuildArgv,
  composeStackArgv,
  parseArgs,
} from './commands.js'

const BASE = '/repo/docker-compose.yml'
const OVERRIDE = '/cfg/project.yml'

describe('composeArgv (per component)', () => {
  it('maps server -> the spec service, with up/down/restart/status/logs', () => {
    expect(composeArgv('server', 'up', [BASE])).toEqual(['-f', BASE, 'up', '-d', 'spec'])
    expect(composeArgv('server', 'down', [BASE])).toEqual(['-f', BASE, 'rm', '-sf', 'spec'])
    expect(composeArgv('server', 'restart', [BASE])).toEqual(['-f', BASE, 'restart', 'spec'])
    expect(composeArgv('server', 'status', [BASE])).toEqual(['-f', BASE, 'ps', 'spec'])
    expect(composeArgv('server', 'logs', [BASE])).toEqual(['-f', BASE, 'logs', '-f', 'spec'])
  })

  it('carries --profile web for the profiled web service', () => {
    expect(composeArgv('web', 'up', [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'up', '-d', 'web'])
    expect(composeArgv('web', 'down', [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'rm', '-sf', 'web'])
  })

  it('does not add a profile for non-profiled services', () => {
    expect(composeArgv('coder', 'restart', [BASE])).toEqual(['-f', BASE, 'restart', 'coder'])
  })

  it('layers multiple compose files in order (base then override)', () => {
    expect(composeArgv('server', 'up', [BASE, OVERRIDE])).toEqual([
      '-f', BASE, '-f', OVERRIDE, 'up', '-d', 'spec',
    ])
  })

  it('produces a valid command for every component/verb pair', () => {
    for (const component of COMPONENTS) {
      for (const verb of VERBS) {
        const argv = composeArgv(component, verb, [BASE])
        expect(argv.slice(0, 2)).toEqual(['-f', BASE])
        expect(argv.length).toBeGreaterThan(2)
      }
    }
  })
})

describe('composeStackArgv (whole stack)', () => {
  it('brings the whole stack up with the web profile enabled', () => {
    expect(composeStackArgv('up', [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'up', '-d'])
  })
  it('tears it all down without a profile (down ignores profiles)', () => {
    expect(composeStackArgv('down', [BASE])).toEqual(['-f', BASE, 'down'])
  })
  it('layers base + override', () => {
    expect(composeStackArgv('up', [BASE, OVERRIDE])).toEqual([
      '-f', BASE, '-f', OVERRIDE, '--profile', 'web', 'up', '-d',
    ])
  })
})

describe('composeBuildArgv', () => {
  it('builds everything (web profile enabled) when no component is named', () => {
    expect(composeBuildArgv(undefined, [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'build'])
  })
  it('builds a single service, translating server -> spec', () => {
    expect(composeBuildArgv('server', [BASE])).toEqual(['-f', BASE, 'build', 'spec'])
  })
  it('carries the web profile when building web', () => {
    expect(composeBuildArgv('web', [BASE])).toEqual(['-f', BASE, '--profile', 'web', 'build', 'web'])
  })
})

describe('parseArgs', () => {
  it('parses a component + verb into a run intent', () => {
    expect(parseArgs(['server', 'up'])).toEqual({
      kind: 'run',
      component: 'server',
      verb: 'up',
      dryRun: false,
      composeFiles: [],
    })
  })

  it('collects repeated --compose-file, in order', () => {
    expect(parseArgs(['server', 'up', '--compose-file', BASE, '--compose-file', OVERRIDE])).toMatchObject({
      kind: 'run',
      composeFiles: [BASE, OVERRIDE],
    })
  })

  it('picks up --dry-run in any position', () => {
    expect(parseArgs(['--dry-run', 'web', 'logs'])).toMatchObject({ kind: 'run', dryRun: true })
  })

  it('treats no args and -h/--help as help; -v/--version as version', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' })
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' })
  })

  it('parses whole-stack up/down', () => {
    expect(parseArgs(['up'])).toMatchObject({ kind: 'stack', action: 'up' })
    expect(parseArgs(['down', '--dry-run'])).toMatchObject({ kind: 'stack', action: 'down', dryRun: true })
  })

  it('errors when up/down is given a stray argument', () => {
    expect(parseArgs(['up', 'server'])).toMatchObject({ kind: 'error' })
  })

  it('parses build with no component, with "all", and with a component', () => {
    expect(parseArgs(['build'])).toMatchObject({ kind: 'build', component: undefined })
    expect(parseArgs(['build', 'all'])).toMatchObject({ kind: 'build', component: undefined })
    expect(parseArgs(['build', 'web'])).toMatchObject({ kind: 'build', component: 'web' })
  })

  it('errors on unknown component, verb, build target, option, and stray positional', () => {
    expect(parseArgs(['nope', 'up'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'fly'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['build', 'nope'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'up', '--wat'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'up', 'extra'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['server', 'up', '--compose-file'])).toMatchObject({ kind: 'error' })
  })
})
