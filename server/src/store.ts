/**
 * The only part of the system that touches the filesystem. Every read goes back to
 * disk — the files are the source of truth, and someone may have hand-edited them
 * between two requests.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseChangeset, parseExpectation, parseQuestion, parseTerm } from '@tb/shared'
import type { Changeset, Expectation, Question, SourceProblem, Term } from '@tb/shared'

export const SPECS_DIR =
  process.env.SPECS_DIR ?? path.resolve(import.meta.dirname, '../../specs')

export const TERMS_DIR = path.join(SPECS_DIR, 'terms')
export const CHANGESETS_DIR = path.join(SPECS_DIR, 'changesets')
export const APPLIED_DIR = path.join(CHANGESETS_DIR, 'applied')
export const REJECTED_DIR = path.join(CHANGESETS_DIR, 'rejected')
export const QUESTIONS_DIR = path.join(SPECS_DIR, 'questions')
export const EXPECTATIONS_DIR = path.join(SPECS_DIR, 'expectations')
export const RETIRED_DIR = path.join(EXPECTATIONS_DIR, 'retired')

export interface Glossary {
  terms: Term[]
  problems: SourceProblem[]
}

export interface PendingChangesets {
  changesets: Changeset[]
  problems: SourceProblem[]
  /**
   * What has landed and what was turned down, newest first. Each entry is a distinct set
   * of ops, so a changeset applied in two partial passes appears twice — the honest count,
   * since each file records ops that actually landed.
   */
  applied: Changeset[]
  rejected: Changeset[]
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export interface TermEntry {
  /** Filename within `specs/terms/`. Cosmetic — `term.name` is authoritative — but needed to write back. */
  file: string
  term: Term
}

/**
 * Reads every term file. A file that fails to parse becomes a `problem` rather than
 * an exception, so one bad hand-edit degrades the UI instead of taking it down.
 */
export async function readTermEntries(): Promise<{
  entries: TermEntry[]
  problems: SourceProblem[]
}> {
  const entries: TermEntry[] = []
  const problems: SourceProblem[] = []
  const seen = new Map<string, string>()

  for (const file of await listJsonFiles(TERMS_DIR)) {
    let data: unknown
    try {
      data = JSON.parse(await readFile(path.join(TERMS_DIR, file), 'utf8'))
    } catch (error) {
      problems.push({ file, message: `invalid JSON — ${(error as Error).message}` })
      continue
    }

    const parsed = parseTerm(data)
    if (!parsed.ok) {
      problems.push({ file, message: parsed.errors.join('; ') })
      continue
    }

    const previous = seen.get(parsed.value.name)
    if (previous) {
      problems.push({
        file,
        message: `duplicate term "${parsed.value.name}" — already declared in ${previous}`,
      })
      continue
    }

    seen.set(parsed.value.name, file)
    entries.push({ file, term: parsed.value })
  }

  entries.sort((a, b) => a.term.name.localeCompare(b.term.name))
  return { entries, problems }
}

export async function readTerms(): Promise<Glossary> {
  const { entries, problems } = await readTermEntries()
  return { terms: entries.map((entry) => entry.term), problems }
}

export interface ChangesetEntry {
  /** Filename within `specs/changesets/`, needed to move the file once it is resolved. */
  file: string
  changeset: Changeset
}

/** Reads the pending changesets. `applied/` and `rejected/` are subdirectories, so they are skipped. */
export async function readChangesetEntries(): Promise<{
  entries: ChangesetEntry[]
  problems: SourceProblem[]
}> {
  const entries: ChangesetEntry[] = []
  const problems: SourceProblem[] = []
  const seen = new Map<string, string>()

  for (const file of await listJsonFiles(CHANGESETS_DIR)) {
    let data: unknown
    try {
      data = JSON.parse(await readFile(path.join(CHANGESETS_DIR, file), 'utf8'))
    } catch (error) {
      problems.push({ file, message: `invalid JSON — ${(error as Error).message}` })
      continue
    }

    const parsed = parseChangeset(data)
    if (!parsed.ok) {
      problems.push({ file, message: parsed.errors.join('; ') })
      continue
    }

    const previous = seen.get(parsed.value.id)
    if (previous) {
      problems.push({
        file,
        message: `duplicate changeset id "${parsed.value.id}" — already declared in ${previous}`,
      })
      continue
    }

    seen.set(parsed.value.id, file)
    entries.push({ file, changeset: parsed.value })
  }

  return { entries, problems }
}

/**
 * Reads a resolved directory — `applied/` or `rejected/`. Unlike the pending read, a file
 * that fails to parse is skipped silently rather than raised as a problem: these are
 * history, and a malformed old record should not clutter the UI with something you cannot
 * act on.
 */
async function readResolved(dir: string): Promise<Changeset[]> {
  const changesets: Changeset[] = []

  for (const file of await listJsonFiles(dir)) {
    try {
      const parsed = parseChangeset(JSON.parse(await readFile(path.join(dir, file), 'utf8')))
      if (parsed.ok) changesets.push(parsed.value)
    } catch {
      // Unreadable history is not worth failing a request over.
    }
  }

  // Newest first. Changesets applied before `appliedAt` existed sort last, which is right.
  return changesets.sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
}

export async function readChangesets(): Promise<PendingChangesets> {
  const [{ entries, problems }, applied, rejected] = await Promise.all([
    readChangesetEntries(),
    readResolved(APPLIED_DIR),
    readResolved(REJECTED_DIR),
  ])

  return {
    changesets: entries.map((entry) => entry.changeset),
    problems,
    applied,
    rejected,
  }
}

export async function findChangesetEntry(id: string): Promise<ChangesetEntry | null> {
  const { entries } = await readChangesetEntries()
  return entries.find((entry) => entry.changeset.id === id) ?? null
}

export interface QuestionEntry {
  /** Filename within `specs/questions/`, needed to write an answer back into it. */
  file: string
  question: Question
}

export interface QuestionFeed {
  questions: Question[]
  problems: SourceProblem[]
}

/**
 * Reads every question. Answered ones are kept and returned alongside the open ones —
 * the answer is the record of why the glossary says what it says, and outlives the
 * changeset it produced.
 */
export async function readQuestionEntries(): Promise<{
  entries: QuestionEntry[]
  problems: SourceProblem[]
}> {
  const entries: QuestionEntry[] = []
  const problems: SourceProblem[] = []
  const seen = new Map<string, string>()

  for (const file of await listJsonFiles(QUESTIONS_DIR)) {
    let data: unknown
    try {
      data = JSON.parse(await readFile(path.join(QUESTIONS_DIR, file), 'utf8'))
    } catch (error) {
      problems.push({ file, message: `invalid JSON — ${(error as Error).message}` })
      continue
    }

    const parsed = parseQuestion(data)
    if (!parsed.ok) {
      problems.push({ file, message: parsed.errors.join('; ') })
      continue
    }

    const previous = seen.get(parsed.value.id)
    if (previous) {
      problems.push({
        file,
        message: `duplicate question id "${parsed.value.id}" — already declared in ${previous}`,
      })
      continue
    }

    seen.set(parsed.value.id, file)
    entries.push({ file, question: parsed.value })
  }

  return { entries, problems }
}

export async function readQuestions(): Promise<QuestionFeed> {
  const { entries, problems } = await readQuestionEntries()
  return { questions: entries.map((entry) => entry.question), problems }
}

export async function findQuestionEntry(id: string): Promise<QuestionEntry | null> {
  const { entries } = await readQuestionEntries()
  return entries.find((entry) => entry.question.id === id) ?? null
}

export interface ExpectationEntry {
  /** Filename within `specs/expectations/`, needed to move it to `retired/`. */
  file: string
  expectation: Expectation
}

export interface ExpectationFeed {
  /** Live expectations — what is currently expected to hold. */
  expectations: Expectation[]
  /**
   * Superseded ones, newest-superseded last. Kept and served rather than deleted: a test
   * named `e-014` has to stay resolvable after the expectation behind it moved on, and the
   * trail from old to new is where the reason lives.
   */
  retired: Expectation[]
  problems: SourceProblem[]
}

/**
 * Reads the live expectations. `retired/` is a subdirectory, so it is skipped here and read
 * separately — the same arrangement changesets use for `applied/`.
 */
export async function readExpectationEntries(): Promise<{
  entries: ExpectationEntry[]
  problems: SourceProblem[]
}> {
  const entries: ExpectationEntry[] = []
  const problems: SourceProblem[] = []
  const seen = new Map<string, string>()

  for (const file of await listJsonFiles(EXPECTATIONS_DIR)) {
    let data: unknown
    try {
      data = JSON.parse(await readFile(path.join(EXPECTATIONS_DIR, file), 'utf8'))
    } catch (error) {
      problems.push({ file, message: `invalid JSON — ${(error as Error).message}` })
      continue
    }

    const parsed = parseExpectation(data)
    if (!parsed.ok) {
      problems.push({ file, message: parsed.errors.join('; ') })
      continue
    }

    const previous = seen.get(parsed.value.id)
    if (previous) {
      problems.push({
        file,
        message: `duplicate expectation id "${parsed.value.id}" — already declared in ${previous}`,
      })
      continue
    }

    seen.set(parsed.value.id, file)
    entries.push({ file, expectation: parsed.value })
  }

  entries.sort((a, b) => a.expectation.id.localeCompare(b.expectation.id))
  return { entries, problems }
}

/** Retired expectations. Unreadable history is skipped rather than raised — it cannot be acted on. */
async function readRetired(): Promise<Expectation[]> {
  const retired: Expectation[] = []

  for (const file of await listJsonFiles(RETIRED_DIR)) {
    try {
      const parsed = parseExpectation(JSON.parse(await readFile(path.join(RETIRED_DIR, file), 'utf8')))
      if (parsed.ok) retired.push(parsed.value)
    } catch {
      // See readResolved — history that will not parse is not worth failing a request over.
    }
  }

  return retired.sort((a, b) => a.id.localeCompare(b.id))
}

export async function readExpectations(): Promise<ExpectationFeed> {
  const [{ entries, problems }, retired] = await Promise.all([readExpectationEntries(), readRetired()])
  return { expectations: entries.map((entry) => entry.expectation), retired, problems }
}

export async function findExpectationEntry(id: string): Promise<ExpectationEntry | null> {
  const { entries } = await readExpectationEntries()
  return entries.find((entry) => entry.expectation.id === id) ?? null
}
