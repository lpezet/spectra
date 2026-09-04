/**
 * Compose-file resolution: the precedence is a pure function, tested exhaustively; the filesystem
 * probing (findLink walking up for the link, discover pairing it with an override) is tested with
 * real tmp dirs, since that is exactly what can go wrong (a link without an override, a nested cwd).
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { discover, findLink, resolveComposeFiles } from './discovery.js'

const FALLBACK = '/repo/docker-compose.yml'

describe('resolveComposeFiles (precedence)', () => {
  const discovered = { base: '/cfg/default.yaml', override: '/cfg/projects/x/compose.yaml' }

  it('explicit --compose-file wins over everything', () => {
    expect(resolveComposeFiles({ explicit: ['/a.yml'], envFile: '/e.yml', discovered, fallback: FALLBACK })).toEqual(['/a.yml'])
  })
  it('env file beats discovery and fallback', () => {
    expect(resolveComposeFiles({ explicit: [], envFile: '/e.yml', discovered, fallback: FALLBACK })).toEqual(['/e.yml'])
  })
  it('a discovered project layers base + override', () => {
    expect(resolveComposeFiles({ explicit: [], discovered, fallback: FALLBACK })).toEqual([
      discovered.base,
      discovered.override,
    ])
  })
  it('falls back to the contributors file when nothing else applies', () => {
    expect(resolveComposeFiles({ explicit: [], fallback: FALLBACK })).toEqual([FALLBACK])
  })
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tb-discover-'))
})

async function writeLink(dir: string, id: string): Promise<void> {
  await mkdir(path.join(dir, '.spectra'), { recursive: true })
  await writeFile(path.join(dir, '.spectra', 'config.json'), JSON.stringify({ id }))
}

describe('findLink', () => {
  it('finds a link in the current dir and walking up from a nested cwd', async () => {
    const repo = path.join(root, 'repo')
    const nested = path.join(repo, 'a', 'b')
    await mkdir(nested, { recursive: true })
    await writeLink(repo, 'repo-abc')
    expect(findLink(repo)).toEqual({ id: 'repo-abc', dir: repo })
    expect(findLink(nested)).toEqual({ id: 'repo-abc', dir: repo })
  })

  it('returns null when there is no link, and treats a corrupt one as none', async () => {
    expect(findLink(root)).toBeNull()
    await mkdir(path.join(root, '.spectra'), { recursive: true })
    await writeFile(path.join(root, '.spectra', 'config.json'), '{ not json')
    expect(findLink(root)).toBeNull()
  })
})

describe('discover', () => {
  it('pairs the link with its override and the repo default.yaml as base', async () => {
    const repo = path.join(root, 'repo')
    const cfg = path.join(root, 'cfg')
    const repoDefault = path.join(root, 'default.yaml')
    await writeLink(repo, 'repo-xyz')
    await writeFile(repoDefault, 'services: {}')
    const override = path.join(cfg, 'spectra', 'projects', 'repo-xyz', 'compose.yaml')
    await mkdir(path.dirname(override), { recursive: true })
    await writeFile(override, 'services: {}')

    expect(discover(repo, cfg, repoDefault)).toEqual({ base: repoDefault, override })
  })

  it('prefers an installed ~/.config/spectra/default.yaml over the repo one', async () => {
    const repo = path.join(root, 'repo')
    const cfg = path.join(root, 'cfg')
    await writeLink(repo, 'repo-xyz')
    const installedBase = path.join(cfg, 'spectra', 'default.yaml')
    const override = path.join(cfg, 'spectra', 'projects', 'repo-xyz', 'compose.yaml')
    await mkdir(path.dirname(override), { recursive: true })
    await writeFile(installedBase, 'services: {}')
    await writeFile(override, 'services: {}')

    expect(discover(repo, cfg, '/nonexistent/default.yaml')).toEqual({ base: installedBase, override })
  })

  it('is undefined when the link exists but the override does not', async () => {
    const repo = path.join(root, 'repo')
    await writeLink(repo, 'repo-xyz')
    expect(discover(repo, path.join(root, 'cfg'), path.join(root, 'default.yaml'))).toBeUndefined()
  })

  it('is undefined when there is no link at all', () => {
    expect(discover(root, path.join(root, 'cfg'), path.join(root, 'default.yaml'))).toBeUndefined()
  })
})
