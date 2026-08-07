/**
 * Reading the `// implements:` markers.
 *
 * The markers are the only link from a term back to the code responsible for it, and a
 * comment nothing checks is a comment that rots. This makes them parseable so a test can
 * fail when the glossary and the code drift apart — a term with no implementer, or a
 * marker naming a term that no longer exists.
 *
 * The grammar is deliberately strict: `// implements:` followed by comma-separated bare
 * identifiers and nothing else. Trailing prose would have to be guessed at, so anything
 * that is not an identifier is reported rather than skipped. Put the prose on the next
 * line.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const MARKER = /^\s*(?:\/\/|\*)\s*implements:\s*(.*)$/
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const SOURCE = /\.tsx?$/

export interface Marker {
  /** Path relative to the scanned root. */
  file: string
  line: number
  terms: string[]
  /** Entries that are not bare identifiers — reported instead of silently ignored. */
  malformed: string[]
}

function sourceFiles(dir: string, root = dir): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full, root))
    } else if (SOURCE.test(entry) && !entry.endsWith('.test.ts')) {
      found.push(path.relative(root, full))
    }
  }
  return found
}

export function readMarkers(root: string): Marker[] {
  const markers: Marker[] = []

  for (const file of sourceFiles(root)) {
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n')

    lines.forEach((line, index) => {
      const match = MARKER.exec(line)
      if (!match) return

      const entries = match[1]!
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)

      markers.push({
        file,
        line: index + 1,
        terms: entries.filter((entry) => IDENTIFIER.test(entry)),
        malformed: entries.filter((entry) => !IDENTIFIER.test(entry)),
      })
    })
  }

  return markers
}

export interface TermRecord {
  name: string
  type: string
  /** Covers spec text, parent and attributes — what an implementer has to satisfy. */
  hash: string
}

export interface Snapshot {
  /**
   * One value for the whole glossary. There is deliberately no timestamp: the file is a
   * pure function of the glossary, so re-exporting when nothing changed leaves it
   * byte-identical, and any diff at all means the contract moved.
   */
  version: string
  terms: TermRecord[]
}

/**
 * The glossary as this project sees it: a committed file, not a directory somewhere else.
 *
 * `specs/` is not reachable from here. It never was when `app/` was copied somewhere on its
 * own, and it is not from inside @coder's sandbox either, which is where the drift check
 * quietly stopped running. So the contract arrives as a snapshot that @coder exports from
 * the spec tool and commits next to the code.
 *
 * The payoff beyond making the check work offline: because each term carries a hash of its
 * spec, parent and attributes, refreshing this file makes `git diff` name exactly which
 * terms changed. That includes a spec being *rewritten* — the case the markers cannot show,
 * because the marker still names the term and still looks correct.
 */
export function readSnapshot(file: string): Snapshot {
  return JSON.parse(readFileSync(file, 'utf8')) as Snapshot
}

/** Which files claim each term. */
export function implementersOf(markers: Marker[]): Map<string, string[]> {
  const byTerm = new Map<string, string[]>()
  for (const marker of markers) {
    for (const term of marker.terms) {
      byTerm.set(term, [...(byTerm.get(term) ?? []), marker.file])
    }
  }
  return byTerm
}
