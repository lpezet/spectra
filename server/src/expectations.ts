/**
 * Writing expectations, governed asymmetrically — and the asymmetry is the design.
 *
 * **Adding is free.** A new expectation changes no term, applies no op, and cannot alter what
 * the app does. The most it can do is turn a check red, which is the direction that reveals a
 * defect rather than hiding one. That makes it safe by construction in exactly the sense
 * `raiseQuestion` is, and it is what lets an expectation be captured the moment someone notices
 * it while *using* the thing — a moment that does not survive a review queue.
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
import { parseExpectation } from '@tb/shared'
import type { Author, Clash, Expectation, ExpectationKind, RecordStatus } from '@tb/shared'
import type { MutationResult, SpecStore } from './specStore.js'

export interface RaiseExpectationRequest {
  kind: ExpectationKind
  terms: string[]
  given?: string
  expect: string
  pass: string
  from?: string
  file?: string
  /** Draft or published. Absent means `ready` — agents omit it; a human may save a draft. */
  status?: RecordStatus
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
  | { ok: false; error: string; status?: number; currentRev?: number }
  | { ok: true; id: string; file: string; expectation: Expectation }

/** Maps a store mutation onto an ExpectationOutcome — not-found → 404, a stale rev → 409. */
function fromMutation(
  id: string,
  result: MutationResult,
  written: Expectation,
): ExpectationOutcome {
  if (result.ok) return { ok: true, id, file: result.at, expectation: { ...written, rev: result.rev } }
  if (result.reason === 'not-found') return { ok: false, error: `No live expectation "${id}".`, status: 404 }
  return {
    ok: false,
    status: 409,
    error: `"${id}" moved since you last read it — it is now at revision ${result.currentRev}.`,
    currentRev: result.currentRev,
  }
}

export async function raiseExpectation(
  store: SpecStore,
  request: RaiseExpectationRequest,
  author: Author,
): Promise<ExpectationOutcome> {
  const id = await store.nextExpectationId()

  const expectation: Expectation = {
    id,
    kind: request.kind,
    author,
    status: request.status ?? 'ready',
    rev: 1,
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

  const file = await store.addExpectation(expectation)
  return { ok: true, id, file, expectation }
}

/**
 * Publish a draft expectation — draft → ready.
 *
 * A draft counts toward nothing while it is a draft; publishing is the act that puts it into
 * coverage and the versioned contract and shows it to the agents. Rewrites in place (a draft
 * already lives in the same directory as a published one — only its status differs), so it
 * keeps its id and its file. Idempotent: publishing an already-ready expectation just restamps
 * it `ready`.
 */
export async function publishExpectation(
  store: SpecStore,
  id: string,
  expectedRev?: number,
): Promise<ExpectationOutcome> {
  const expectation = await store.findExpectation(id)
  if (!expectation) return { ok: false, error: `No live expectation "${id}".`, status: 404 }

  const updated: Expectation = { ...expectation, status: 'ready' }
  return fromMutation(id, await store.rewriteExpectation(updated, expectedRev), updated)
}

/**
 * Re-reads a live expectation against the specs as they are now, and rewrites what it clashes
 * with.
 *
 * `contested` is a snapshot of a disagreement, and the specs move underneath it. When q-009 was
 * answered, unarchiveProject's spec was rewritten and e-011 was left quoting a sentence that no
 * longer exists anywhere — still flagged, still out of coverage, and now for a reason nobody
 * could check. @coder found that and correctly refused to act on it.
 *
 * Rewriting rather than clearing is the point. A clash that is gone should disappear, and one
 * that has merely *changed* should say what it clashes with now. It never retires anything: if
 * the disagreement survives, the expectation stays live and contested and a human decides.
 */
export async function recheckExpectation(
  store: SpecStore,
  id: string,
  check: (expectation: Expectation, others: Expectation[]) => Promise<Clash[]>,
  expectedRev?: number,
): Promise<ExpectationOutcome> {
  const expectation = await store.findExpectation(id)
  if (!expectation) return { ok: false, error: `No live expectation "${id}".`, status: 404 }

  const { expectations } = await store.readExpectations()
  const others = expectations.filter((candidate) => candidate.id !== id)

  const contested = await check(expectation, others)
  const updated: Expectation = { ...expectation, contested }

  return fromMutation(id, await store.rewriteExpectation(updated, expectedRev), updated)
}

export interface SupersedeRequest {
  /** What the replacement says. Omit to retire the expectation outright. */
  replacement?: Omit<RaiseExpectationRequest, 'pass' | 'from' | 'file'> & { pass?: string }
  /** Why it moved. Recorded on the replacement's origin, or lost. */
  note: string
}

export type SupersedeOutcome =
  | { ok: false; error: string; status: number; currentRev?: number }
  | { ok: true; retired: string; replacement: Expectation | null }

/**
 * Retire an expectation, optionally replacing it.
 *
 * The replacement is written first and the original moved second. If the process dies between
 * the two, the result is a duplicate-looking pair rather than a gap — an expectation stated
 * twice is noise someone will notice, and one silently missing is the failure that matters.
 */
export async function supersedeExpectation(
  store: SpecStore,
  id: string,
  request: SupersedeRequest,
  author: Author,
  expectedRev?: number,
): Promise<SupersedeOutcome> {
  const original = await store.findExpectation(id)
  if (!original) return { ok: false, error: `No live expectation "${id}".`, status: 404 }

  let replacement: Expectation | null = null

  if (request.replacement) {
    const raised = await raiseExpectation(
      store,
      {
        ...request.replacement,
        pass: request.replacement.pass ?? 'supersedes',
        from: id,
      },
      author,
    )
    if (!raised.ok) return { ok: false, error: raised.error, status: raised.status ?? 400 }
    replacement = raised.expectation
  }

  const retired: Expectation = {
    ...original,
    supersededBy: replacement?.id ?? null,
    retiredBecause: request.note,
  }

  // A stale rev leaves the replacement written but the original un-retired — a duplicate-looking
  // pair, which is exactly the failure the replacement-first order already tolerates over a gap.
  const moved = await store.retireExpectation(id, retired, expectedRev)
  if (!moved.ok) {
    if (moved.reason === 'not-found') return { ok: false, error: `No live expectation "${id}".`, status: 404 }
    return {
      ok: false,
      status: 409,
      error: `"${id}" moved since you last read it — it is now at revision ${moved.currentRev}.`,
      currentRev: moved.currentRev,
    }
  }

  return { ok: true, retired: id, replacement }
}
