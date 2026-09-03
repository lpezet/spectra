/**
 * The filesystem backing for the glossary — today's behaviour, now behind {@link SpecStore}.
 *
 * This is the one module that touches `specs/`. It owns two things the rest of the server used
 * to reach for directly and a SQL backend could never share: the id→filename map (a record is
 * addressed by its domain id everywhere else; only here does it become a path) and the
 * temp-then-rename write dance. Every read still goes back to disk, because the files are the
 * source of truth and may have been hand-edited between two requests — a truth of *this*
 * backend, not of the interface.
 *
 * State is the directory: pending changesets sit at the top of `changesets/` and move to
 * `applied/` or `rejected/`; live expectations sit in `expectations/` and move to `retired/`.
 * The interface names those as transitions; here they are `rename`-shaped moves.
 */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseChangeset, parseExpectation, parseQuestion, parseTerm } from '@tb/shared'
import type { Answer, Changeset, Expectation, Question, SourceProblem, Term } from '@tb/shared'
import { slug, uniquePath, writeAtomic } from './files.js'
import { serializeChangeset, serializeTerm, termFileName } from './serialize.js'
import type {
  CommitApplication,
  CommitResult,
  ExpectationFeed,
  Glossary,
  PendingChangesets,
  QuestionFeed,
  SpecStore,
  StoredAt,
} from './specStore.js'

interface TermEntry {
  file: string
  term: Term
}
interface ChangesetEntry {
  file: string
  changeset: Changeset
}
interface QuestionEntry {
  file: string
  question: Question
}
interface ExpectationEntry {
  file: string
  expectation: Expectation
}

export class FileSystemSpecStore implements SpecStore {
  private readonly termsDir: string
  private readonly changesetsDir: string
  private readonly appliedDir: string
  private readonly rejectedDir: string
  private readonly questionsDir: string
  private readonly expectationsDir: string
  private readonly retiredDir: string

  constructor(specsDir: string) {
    this.termsDir = path.join(specsDir, 'terms')
    this.changesetsDir = path.join(specsDir, 'changesets')
    this.appliedDir = path.join(this.changesetsDir, 'applied')
    this.rejectedDir = path.join(this.changesetsDir, 'rejected')
    this.questionsDir = path.join(specsDir, 'questions')
    this.expectationsDir = path.join(specsDir, 'expectations')
    this.retiredDir = path.join(this.expectationsDir, 'retired')
  }

  // ── Low-level ────────────────────────────────────────────────────────────────────────

  private async listJsonFiles(dir: string): Promise<string[]> {
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

  private writeJson(target: string, value: unknown): Promise<void> {
    return writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`)
  }

  private expectationFileName(expectation: Expectation): string {
    return `${expectation.id}-${slug(expectation.expect)}.json`
  }

  // ── Term reads ─────────────────────────────────────────────────────────────────────────

  private async readTermEntries(): Promise<{ entries: TermEntry[]; problems: SourceProblem[] }> {
    const entries: TermEntry[] = []
    const problems: SourceProblem[] = []
    const seen = new Map<string, string>()

    for (const file of await this.listJsonFiles(this.termsDir)) {
      let data: unknown
      try {
        data = JSON.parse(await readFile(path.join(this.termsDir, file), 'utf8'))
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

  async readTerms(): Promise<Glossary> {
    const { entries, problems } = await this.readTermEntries()
    return { terms: entries.map((entry) => entry.term), problems }
  }

  // ── Changeset reads ──────────────────────────────────────────────────────────────────

  private async readChangesetEntries(): Promise<{ entries: ChangesetEntry[]; problems: SourceProblem[] }> {
    const entries: ChangesetEntry[] = []
    const problems: SourceProblem[] = []
    const seen = new Map<string, string>()

    for (const file of await this.listJsonFiles(this.changesetsDir)) {
      let data: unknown
      try {
        data = JSON.parse(await readFile(path.join(this.changesetsDir, file), 'utf8'))
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
   * Reads a resolved directory — `applied/` or `rejected/`. A file that fails to parse is
   * skipped silently rather than raised as a problem: these are history, and a malformed old
   * record should not clutter the UI with something you cannot act on.
   */
  private async readResolved(dir: string): Promise<Changeset[]> {
    const changesets: Changeset[] = []

    for (const file of await this.listJsonFiles(dir)) {
      try {
        const parsed = parseChangeset(JSON.parse(await readFile(path.join(dir, file), 'utf8')))
        if (parsed.ok) changesets.push(parsed.value)
      } catch {
        // Unreadable history is not worth failing a request over.
      }
    }

    return changesets.sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
  }

  async readChangesets(): Promise<PendingChangesets> {
    const [{ entries, problems }, applied, rejected] = await Promise.all([
      this.readChangesetEntries(),
      this.readResolved(this.appliedDir),
      this.readResolved(this.rejectedDir),
    ])

    return {
      changesets: entries.map((entry) => entry.changeset),
      problems,
      applied,
      rejected,
    }
  }

  private async findChangesetEntry(id: string): Promise<ChangesetEntry | null> {
    const { entries } = await this.readChangesetEntries()
    return entries.find((entry) => entry.changeset.id === id) ?? null
  }

  async findChangeset(id: string): Promise<Changeset | null> {
    return (await this.findChangesetEntry(id))?.changeset ?? null
  }

  // ── Question reads ───────────────────────────────────────────────────────────────────

  private async readQuestionEntries(): Promise<{ entries: QuestionEntry[]; problems: SourceProblem[] }> {
    const entries: QuestionEntry[] = []
    const problems: SourceProblem[] = []
    const seen = new Map<string, string>()

    for (const file of await this.listJsonFiles(this.questionsDir)) {
      let data: unknown
      try {
        data = JSON.parse(await readFile(path.join(this.questionsDir, file), 'utf8'))
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

  async readQuestions(): Promise<QuestionFeed> {
    const { entries, problems } = await this.readQuestionEntries()
    return { questions: entries.map((entry) => entry.question), problems }
  }

  private async findQuestionEntry(id: string): Promise<QuestionEntry | null> {
    const { entries } = await this.readQuestionEntries()
    return entries.find((entry) => entry.question.id === id) ?? null
  }

  async findQuestion(id: string): Promise<Question | null> {
    return (await this.findQuestionEntry(id))?.question ?? null
  }

  // ── Expectation reads ────────────────────────────────────────────────────────────────

  private async readExpectationEntries(): Promise<{ entries: ExpectationEntry[]; problems: SourceProblem[] }> {
    const entries: ExpectationEntry[] = []
    const problems: SourceProblem[] = []
    const seen = new Map<string, string>()

    for (const file of await this.listJsonFiles(this.expectationsDir)) {
      let data: unknown
      try {
        data = JSON.parse(await readFile(path.join(this.expectationsDir, file), 'utf8'))
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
  private async readRetired(): Promise<Expectation[]> {
    const retired: Expectation[] = []

    for (const file of await this.listJsonFiles(this.retiredDir)) {
      try {
        const parsed = parseExpectation(JSON.parse(await readFile(path.join(this.retiredDir, file), 'utf8')))
        if (parsed.ok) retired.push(parsed.value)
      } catch {
        // See readResolved — history that will not parse is not worth failing a request over.
      }
    }

    return retired.sort((a, b) => a.id.localeCompare(b.id))
  }

  async readExpectations(): Promise<ExpectationFeed> {
    const [{ entries, problems }, retired] = await Promise.all([
      this.readExpectationEntries(),
      this.readRetired(),
    ])
    // Drafts share the live directory with published expectations — status is data, not a
    // location — so the split happens here rather than by folder. Absent status reads as ready.
    const live = entries.map((entry) => entry.expectation)
    return {
      expectations: live.filter((expectation) => expectation.status !== 'draft'),
      drafts: live.filter((expectation) => expectation.status === 'draft'),
      retired,
      problems,
    }
  }

  private async findExpectationEntry(id: string): Promise<ExpectationEntry | null> {
    const { entries } = await this.readExpectationEntries()
    return entries.find((entry) => entry.expectation.id === id) ?? null
  }

  async findExpectation(id: string): Promise<Expectation | null> {
    return (await this.findExpectationEntry(id))?.expectation ?? null
  }

  // ── Id allocation ──────────────────────────────────────────────────────────────────────

  private async jsonFileNames(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((file) => file.endsWith('.json'))
    } catch {
      return []
    }
  }

  /** `chat-004` after `chat-003`. Counts resolved directories too — reusing an applied id would make history ambiguous. */
  async nextChangesetId(): Promise<string> {
    const files = (
      await Promise.all([
        this.jsonFileNames(this.changesetsDir),
        this.jsonFileNames(this.appliedDir),
        this.jsonFileNames(this.rejectedDir),
      ])
    ).flat()
    const highest = files.reduce((max, file) => {
      const match = /^chat-(\d+)/.exec(file)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    return `chat-${String(highest + 1).padStart(3, '0')}`
  }

  /** `q-004` after `q-003`. Ids are per-directory, so a gap from a deleted file is fine. */
  async nextQuestionId(): Promise<string> {
    const { entries } = await this.readQuestionEntries()
    const highest = entries.reduce((max, entry) => {
      const match = /^q-(\d+)$/.exec(entry.question.id)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    return `q-${String(highest + 1).padStart(3, '0')}`
  }

  /** `e-004` after `e-003`. Retired ids count too, or a superseded one would be handed out twice. */
  async nextExpectationId(): Promise<string> {
    const { entries } = await this.readExpectationEntries()
    const live = entries.map((entry) => entry.expectation.id)
    const retired = await this.jsonFileNames(this.retiredDir)

    const highest = [...live, ...retired].reduce((max, value) => {
      const match = /^e-(\d+)/.exec(value)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)

    return `e-${String(highest + 1).padStart(3, '0')}`
  }

  // ── Simple creates ───────────────────────────────────────────────────────────────────

  async addChangeset(changeset: Changeset): Promise<StoredAt> {
    await mkdir(this.changesetsDir, { recursive: true })
    const target = await uniquePath(this.changesetsDir, `${changeset.id}-${slug(changeset.summary)}.json`)
    await writeAtomic(target, serializeChangeset(changeset))
    return path.basename(target)
  }

  async addQuestion(question: Question): Promise<StoredAt> {
    await mkdir(this.questionsDir, { recursive: true })
    const target = await uniquePath(this.questionsDir, `${question.id}-${slug(question.asks)}.json`)
    await this.writeJson(target, question)
    return path.basename(target)
  }

  async addExpectation(expectation: Expectation): Promise<StoredAt> {
    await mkdir(this.expectationsDir, { recursive: true })
    const target = await uniquePath(this.expectationsDir, this.expectationFileName(expectation))
    await this.writeJson(target, expectation)
    return path.basename(target)
  }

  // ── State transitions ────────────────────────────────────────────────────────────────

  async commitApplication(application: CommitApplication): Promise<CommitResult> {
    const { entries } = await this.readTermEntries()
    const fileByName = new Map(entries.map((entry) => [entry.term.name, entry.file]))
    const written: string[] = []
    const deleted: string[] = []

    for (const term of application.nextTerms) {
      const target = fileByName.get(term.name) ?? termFileName(term.name)
      const contents = serializeTerm(term)
      const existing = entries.find((entry) => entry.term.name === term.name)
      if (existing && serializeTerm(existing.term) === contents) continue
      await writeAtomic(path.join(this.termsDir, target), contents)
      written.push(target)
    }

    const survived = new Set(application.nextTerms.map((term) => term.name))
    for (const entry of entries) {
      if (survived.has(entry.term.name)) continue
      await rm(path.join(this.termsDir, entry.file))
      deleted.push(entry.file)
    }

    const entry = await this.findChangesetEntry(application.changesetId)
    if (!entry) throw new Error(`No pending changeset with id "${application.changesetId}".`)
    const { changeset, file } = entry

    await mkdir(this.appliedDir, { recursive: true })
    const appliedPath = await uniquePath(this.appliedDir, file)
    await writeAtomic(
      appliedPath,
      serializeChangeset({
        ...changeset,
        ops: application.appliedOps,
        appliedAt: application.appliedAt,
        // Applied is not implemented. Recording null here is what lets the UI show a change
        // that landed in the glossary with no code written for it.
        implementedAt: null,
      }),
    )

    const pendingPath = path.join(this.changesetsDir, file)
    if (application.remainingOps.length === 0) {
      await rm(pendingPath)
    } else {
      await writeAtomic(pendingPath, serializeChangeset({ ...changeset, ops: application.remainingOps }))
    }

    return { written, deleted, resolvedTo: path.relative(this.changesetsDir, appliedPath) }
  }

  async rejectChangeset(id: string): Promise<string | null> {
    const entry = await this.findChangesetEntry(id)
    if (!entry) return null

    await mkdir(this.rejectedDir, { recursive: true })
    const rejectedPath = await uniquePath(this.rejectedDir, entry.file)
    await writeAtomic(rejectedPath, serializeChangeset(entry.changeset))
    await rm(path.join(this.changesetsDir, entry.file))

    return path.relative(this.changesetsDir, rejectedPath)
  }

  async markImplemented(id: string, at: string): Promise<StoredAt | null> {
    for (const file of await this.jsonFileNames(this.appliedDir)) {
      const full = path.join(this.appliedDir, file)
      const parsed = parseChangeset(JSON.parse(await readFile(full, 'utf8')))
      if (!parsed.ok || parsed.value.id !== id) continue

      await writeAtomic(full, serializeChangeset({ ...parsed.value, implementedAt: at }))
      return file
    }

    return null
  }

  async writeAnswer(questionId: string, answer: Answer): Promise<void> {
    const entry = await this.findQuestionEntry(questionId)
    if (!entry) throw new Error(`No question with id "${questionId}".`)
    await this.writeJson(path.join(this.questionsDir, entry.file), { ...entry.question, answer })
  }

  async retireExpectation(id: string, retired: Expectation): Promise<boolean> {
    const entry = await this.findExpectationEntry(id)
    if (!entry) return false

    // Retiring outright leaves `supersededBy: null`, which reads exactly like a live
    // expectation — so the directory is what carries that fact.
    await mkdir(this.retiredDir, { recursive: true })
    const target = await uniquePath(this.retiredDir, this.expectationFileName(retired))
    await this.writeJson(target, retired)
    await rm(path.join(this.expectationsDir, entry.file))
    return true
  }

  async rewriteExpectation(expectation: Expectation): Promise<StoredAt | null> {
    const entry = await this.findExpectationEntry(expectation.id)
    if (!entry) return null
    await this.writeJson(path.join(this.expectationsDir, entry.file), expectation)
    return entry.file
  }
}
