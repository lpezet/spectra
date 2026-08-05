/**
 * The only part of the system that touches the filesystem. Every read goes back to
 * disk — the files are the source of truth, and someone may have hand-edited them
 * between two requests.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseChangeset, parseQuestion, parseTerm } from '@tb/shared'
import type { Changeset, Question, SourceProblem, Term } from '@tb/shared'

export const SPECS_DIR =
  process.env.SPECS_DIR ?? path.resolve(import.meta.dirname, '../../specs')

export const TERMS_DIR = path.join(SPECS_DIR, 'terms')
export const CHANGESETS_DIR = path.join(SPECS_DIR, 'changesets')
export const APPLIED_DIR = path.join(CHANGESETS_DIR, 'applied')
export const REJECTED_DIR = path.join(CHANGESETS_DIR, 'rejected')
export const QUESTIONS_DIR = path.join(SPECS_DIR, 'questions')

export interface Glossary {
  terms: Term[]
  problems: SourceProblem[]
}

export interface PendingChangesets {
  changesets: Changeset[]
  problems: SourceProblem[]
  /**
   * How many changesets have landed and how many were turned down. Counted as files, so
   * a changeset applied in two partial passes counts twice — which is the honest number,
   * since each file is a distinct set of ops that actually landed.
   */
  applied: number
  rejected: number
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

export async function readChangesets(): Promise<PendingChangesets> {
  const [{ entries, problems }, applied, rejected] = await Promise.all([
    readChangesetEntries(),
    listJsonFiles(APPLIED_DIR),
    listJsonFiles(REJECTED_DIR),
  ])

  return {
    changesets: entries.map((entry) => entry.changeset),
    problems,
    applied: applied.length,
    rejected: rejected.length,
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
