/**
 * Reading the glossary from inside the sandbox.
 *
 * The container has no network, so these read `/work/specs` directly rather than calling
 * the spec tool's API. That works because the mount is read-only at the kernel: @coder can
 * see every term and changeset and cannot alter one.
 *
 * The gap this leaves is `mark_implemented`, which is a *write* to
 * `specs/changesets/applied/`. It cannot work from here, and that is the thing that will
 * force an internal network and an HTTP channel back to the spec tool. Until then the
 * agent reports what it finished and the human marks it — which is where that button
 * already was.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const SPECS_DIR = process.env.SPECS_DIR ?? '/work/specs'

export interface Term {
  name: string
  type: string
  spec: string
  parent: string | null
  tags: string[]
  attributes: Array<{ name: string; valueType: string; default?: unknown; optional?: boolean }>
}

function readJsonDir<T>(dir: string): T[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .flatMap((file) => {
        try {
          return [JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as T]
        } catch {
          // A malformed file is the spec tool's problem to surface, not this one's.
          return []
        }
      })
  } catch {
    return []
  }
}

export function readTerms(): Term[] {
  return readJsonDir<Term>(path.join(SPECS_DIR, 'terms'))
}

export function readChangesets(): { pending: unknown[]; applied: unknown[] } {
  return {
    pending: readJsonDir(path.join(SPECS_DIR, 'changesets')),
    applied: readJsonDir(path.join(SPECS_DIR, 'changesets', 'applied')),
  }
}

export function readQuestions(): unknown[] {
  return readJsonDir(path.join(SPECS_DIR, 'questions'))
}

/** Whether the glossary is mounted at all — worth saying out loud rather than guessing. */
export function reachable(): boolean {
  return readTerms().length > 0
}
