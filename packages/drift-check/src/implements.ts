/**
 * Reading the `// implements:` and `// verifies:` markers and the committed glossary snapshot.
 *
 * The markers are the only link from a term (or an expectation) back to the code responsible for it,
 * and a comment nothing checks is a comment that rots. This makes them parseable so a test can fail
 * when the glossary and the code drift apart — a term with no implementer, or a marker naming a term
 * that no longer exists.
 *
 * Two marker kinds, and their differences are deliberate:
 *
 * - **`// implements: <Term>`** links code to a term. Terms are implemented by *production* code, so
 *   these are read from source and `.test.ts` files are skipped. Grammar: comma-separated bare
 *   identifiers (`Task`, `createTask`).
 * - **`// verifies: <expectation-id>`** links a *test* to the expectation it exercises (GH #96). These
 *   live in test files by nature, so the scan *includes* `.test.ts`. Expectation ids are hyphenated
 *   (`e-001`), which the identifier grammar forbids — so they get their own id grammar.
 *
 * Either grammar is strict: comma-separated tokens and nothing else. Trailing prose would have to be
 * guessed at, so anything that is not a valid token is reported rather than skipped. Put the prose on
 * the next line.
 *
 * (Ported from the reference `app/` on the `backup/todo-app` branch, now a package a consumer project
 * depends on so the check ships with Spectra rather than being copied per project.)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
/** An expectation id like `e-001` — a lowercase-ish prefix, a hyphen, then digits. */
const EXPECTATION_ID = /^[A-Za-z]+-\d+$/
const SOURCE = /\.tsx?$/

export interface Marker {
  /** Path relative to the scanned root. */
  file: string
  line: number
  terms: string[]
  /** Entries that are not bare identifiers — reported instead of silently ignored. */
  malformed: string[]
}

export interface VerifyMarker {
  /** Path relative to the scanned root. */
  file: string
  line: number
  /** Expectation ids this test claims to verify. */
  ids: string[]
  /** Entries that are not expectation ids — reported instead of silently ignored. */
  malformed: string[]
}

function sourceFiles(dir: string, includeTests: boolean, root = dir): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full, includeTests, root))
    } else if (SOURCE.test(entry) && (includeTests || !entry.endsWith('.test.ts'))) {
      found.push(path.relative(root, full))
    }
  }
  return found
}

interface RawMarker {
  file: string
  line: number
  entries: string[]
  malformed: string[]
}

/**
 * Every `<keyword>:` marker under `root`, split into valid entries and malformed ones. Shared by
 * both marker kinds so the file-walk and the comment grammar (`//` or a `*` JSDoc continuation) live
 * in one place; the caller supplies what a valid entry looks like and whether tests are scanned.
 */
function collect(root: string, keyword: string, valid: RegExp, includeTests: boolean): RawMarker[] {
  const line = new RegExp(String.raw`^\s*(?:\/\/|\*)\s*${keyword}:\s*(.*)$`)
  const markers: RawMarker[] = []

  for (const file of sourceFiles(root, includeTests)) {
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n')

    lines.forEach((text, index) => {
      const match = line.exec(text)
      if (!match) return

      const entries = match[1]!
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)

      markers.push({
        file,
        line: index + 1,
        entries: entries.filter((entry) => valid.test(entry)),
        malformed: entries.filter((entry) => !valid.test(entry)),
      })
    })
  }

  return markers
}

/** Every `// implements:` marker under `root`, with the terms it names and any malformed entries. */
export function readMarkers(root: string): Marker[] {
  return collect(root, 'implements', IDENTIFIER, false).map((m) => ({
    file: m.file,
    line: m.line,
    terms: m.entries,
    malformed: m.malformed,
  }))
}

/**
 * Every `// verifies:` marker under `root`, with the expectation ids it names and any malformed
 * entries. Unlike {@link readMarkers}, this scans `.test.ts` files too — the verifying test is the
 * thing being marked.
 */
export function readVerifyMarkers(root: string): VerifyMarker[] {
  return collect(root, 'verifies', EXPECTATION_ID, true).map((m) => ({
    file: m.file,
    line: m.line,
    ids: m.entries,
    malformed: m.malformed,
  }))
}

export interface TermRecord {
  name: string
  type: string
  /** Covers spec text, parent and attributes — what an implementer has to satisfy. */
  hash: string
}

export interface ExpectationRecord {
  id: string
  kind: string
  hash: string
}

export interface Snapshot {
  /**
   * One value for the whole glossary. There is deliberately no timestamp: the file is a pure
   * function of the glossary, so re-exporting when nothing changed leaves it byte-identical.
   */
  version: string
  terms: TermRecord[]
  /** Optional so a snapshot exported before expectations existed still reads. */
  expectations?: ExpectationRecord[]
}

/**
 * The glossary as this project sees it — a committed file (`export_specs` writes it), not a directory
 * somewhere else. `specs/` is not reachable from a standalone copy of the project, nor from inside
 * @coder's sandbox; a committed snapshot works in both, a live lookup in neither.
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
