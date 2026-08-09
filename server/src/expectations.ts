/**
 * Writing expectations, governed asymmetrically — and the asymmetry is the design.
 *
 * **Adding is free.** A new expectation changes no term, applies no op, and cannot alter what
 * the app does. The most it can do is turn a check red, which is the direction that reveals a
 * defect rather than hiding one. That makes it safe by construction in exactly the sense
 * `raiseQuestion` is, and it is what lets an expectation be captured the moment someone
 * notices it while *using* the thing — which is where most of them will come from, and a
 * moment that does not survive a review queue.
 *
 * **Weakening is reviewed.** Superseding replaces a statement someone is relying on, and it is
 * the one move that can turn a red check green without touching a line of code. So it does not
 * happen in place: the old expectation keeps its id, gains `supersededBy`, and moves to
 * `retired/`, the same way a changeset moves to `applied/`. Three things follow — a test named
 * `e-014` still resolves, the reason survives, and the dangerous direction leaves an artifact
 * in the history that is already being reviewed.
 *
 * Neither of these is offered to `@coder` as a supersession tool. Raising one is; retiring one
 * is a human act, because "this expectation was wrong" is a product judgement and the agent
 * that would most like to make it is the one whose code just failed it.
 */
import path from 'node:path'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { parseExpectation } from '@tb/shared'
import type { Clash, Expectation, ExpectationKind } from '@tb/shared'
import { slug, uniquePath, writeAtomic } from './files.js'
import {
  EXPECTATIONS_DIR,
  RETIRED_DIR,
  findExpectationEntry,
  readExpectationEntries,
} from './store.js'

export interface RaiseExpectationRequest {
  kind: ExpectationKind
  terms: string[]
  given?: string
  expect: string
  pass: string
  from?: string
  file?: string
  /**
   * What the check found and the author went ahead regardless.
   *
   * Carried on the write rather than recomputed here. The check is a separate call — a caller
   * that already decided should not pay for a second model round trip — and recomputing would
   * also mean a draft could be accepted against one glossary and stored against another.
   */
  contested?: Clash[]
}

export type ExpectationOutcome =
  | { ok: false; error: string; status?: number }
  | { ok: true; id: string; file: string; expectation: Expectation }

/** `e-004` after `e-003`. Retired ids count too, or a superseded one would be handed out twice. */
async function nextExpectationId(): Promise<string> {
  const { entries } = await readExpectationEntries()
  const live = entries.map((entry) => entry.expectation.id)

  // Retired filenames are enough — they start with the id — and reading them beats parsing a
  // history this only needs numbers from.
  let retired: string[] = []
  try {
    retired = (await readdir(RETIRED_DIR)).filter((file) => file.endsWith('.json'))
  } catch {
    // No retired directory yet is the normal case, not an error.
  }

  const highest = [...live, ...retired].reduce((max, value) => {
    const match = /^e-(\d+)/.exec(value)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)

  return `e-${String(highest + 1).padStart(3, '0')}`
}

function fileNameFor(expectation: Expectation): string {
  return `${expectation.id}-${slug(expectation.expect)}.json`
}

export async function raiseExpectation(request: RaiseExpectationRequest): Promise<ExpectationOutcome> {
  const id = await nextExpectationId()

  const expectation: Expectation = {
    id,
    kind: request.kind,
    terms: request.terms,
    given: request.given ?? '',
    expect: request.expect,
    raisedBy: {
      pass: request.pass,
      ...(request.from ? { from: request.from } : {}),
      ...(request.file ? { file: request.file } : {}),
    },
    supersededBy: null,
    contested: request.contested ?? [],
  }

  // Validated before it reaches disk, not after — an invalid expectation would otherwise come
  // back as a source problem in the UI instead of an error the caller can act on.
  const parsed = parseExpectation(expectation)
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; '), status: 400 }

  await mkdir(EXPECTATIONS_DIR, { recursive: true })
  const target = await uniquePath(EXPECTATIONS_DIR, fileNameFor(expectation))
  await writeAtomic(target, `${JSON.stringify(expectation, null, 2)}\n`)

  return { ok: true, id, file: path.basename(target), expectation }
}

export interface SupersedeRequest {
  /** What the replacement says. Omit to retire the expectation outright. */
  replacement?: Omit<RaiseExpectationRequest, 'pass' | 'from' | 'file'> & { pass?: string }
  /** Why it moved. Recorded on the replacement's origin, or lost. */
  note: string
}

export type SupersedeOutcome =
  | { ok: false; error: string; status: number }
  | { ok: true; retired: string; replacement: Expectation | null }

/**
 * Retire an expectation, optionally replacing it.
 *
 * The replacement is written first and the original moved second. If the process dies between
 * the two, the result is a duplicate-looking pair rather than a gap — an expectation stated
 * twice is noise someone will notice, and one silently missing is the failure that matters.
 */
export async function supersedeExpectation(
  id: string,
  request: SupersedeRequest,
): Promise<SupersedeOutcome> {
  const entry = await findExpectationEntry(id)
  if (!entry) return { ok: false, error: `No live expectation "${id}".`, status: 404 }

  let replacement: Expectation | null = null

  if (request.replacement) {
    const raised = await raiseExpectation({
      ...request.replacement,
      pass: request.replacement.pass ?? 'supersedes',
      from: id,
    })
    if (!raised.ok) return { ok: false, error: raised.error, status: raised.status ?? 400 }
    replacement = raised.expectation
  }

  const retired: Expectation = {
    ...entry.expectation,
    supersededBy: replacement?.id ?? null,
    retiredBecause: request.note,
  }

  // Retiring outright leaves `supersededBy: null`, which on its own reads exactly like a live
  // expectation — so the directory is what carries that fact, and `readExpectations` reports
  // the two sets separately rather than merging them.
  await mkdir(RETIRED_DIR, { recursive: true })
  const target = await uniquePath(RETIRED_DIR, fileNameFor(retired))
  await writeAtomic(target, `${JSON.stringify(retired, null, 2)}\n`)
  await rm(path.join(EXPECTATIONS_DIR, entry.file))

  return { ok: true, retired: id, replacement }
}
