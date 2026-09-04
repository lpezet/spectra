/**
 * Which compose files a command runs against, when the user does not name them.
 *
 * After `spectra init`, a repo carries `.spectra/config.json` (the link) and there is a matching
 * per-project override under `~/.config/spectra/projects/<id>/`. Auto-discovery finds them so
 * `spectra up` inside an inited repo needs no `-f`: it layers the distribution base (`default.yaml`)
 * under that override.
 *
 * The precedence — explicit flags beat an env override beat discovery beat the contributors' default
 * — is a pure function (`resolveComposeFiles`), tested exhaustively. The filesystem probing that
 * builds its input (`discover`, `findLink`) is the thin impure part.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface Discovered {
  base: string
  override: string
}

export interface ComposeContext {
  /** From --compose-file (may repeat); wins outright when present. */
  explicit: string[]
  /** SPECTRA_COMPOSE_FILE, if set. */
  envFile?: string
  /** A linked project whose base + override both exist on disk. */
  discovered?: Discovered
  /** The contributors' file, used when nothing else applies. */
  fallback: string
}

/** Pure precedence: explicit flags → env override → a discovered project → the fallback. */
export function resolveComposeFiles(ctx: ComposeContext): string[] {
  if (ctx.explicit.length > 0) return ctx.explicit
  if (ctx.envFile) return [ctx.envFile]
  if (ctx.discovered) return [ctx.discovered.base, ctx.discovered.override]
  return [ctx.fallback]
}

/** Walk up from `startDir` for a `.spectra/config.json`, returning its project id. */
export function findLink(startDir: string): { id: string; dir: string } | null {
  let dir = path.resolve(startDir)
  for (;;) {
    const link = path.join(dir, '.spectra', 'config.json')
    if (existsSync(link)) {
      try {
        const config = JSON.parse(readFileSync(link, 'utf8')) as { id?: unknown }
        if (typeof config.id === 'string' && config.id) return { id: config.id, dir }
      } catch {
        // A corrupt link is treated as no link — fall through to the parent.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Build a Discovered pair for the repo containing `cwd`, or undefined if there is no linked project
 * with both files present. The base is the installed `default.yaml` under the config home if it
 * exists, else the repo's own `default.yaml` (dev/build-local, where the CLI runs from a checkout).
 */
export function discover(cwd: string, configHome: string, repoDefaultYaml: string): Discovered | undefined {
  const link = findLink(cwd)
  if (!link) return undefined

  const override = path.join(configHome, 'spectra', 'projects', link.id, 'compose.yaml')
  if (!existsSync(override)) return undefined

  const installedBase = path.join(configHome, 'spectra', 'default.yaml')
  const base = existsSync(installedBase) ? installedBase : existsSync(repoDefaultYaml) ? repoDefaultYaml : undefined
  if (!base) return undefined

  return { base, override }
}
