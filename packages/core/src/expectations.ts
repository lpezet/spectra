/**
 * Writing expectations, over the {@link SpecStore} seam — governed asymmetrically, and the asymmetry
 * is the design.
 *
 * **Adding is free.** A new expectation changes no term and cannot alter what the app does; the most
 * it can do is turn a check red, which reveals a defect rather than hiding one — safe by construction,
 * the way `raiseQuestion` is. **Weakening is reviewed.** Superseding replaces a statement someone
 * relies on — the one move that can turn a red check green without touching code — so it does not
 * happen in place: the old expectation keeps its id, gains `supersededBy`, and moves to retired.
 *
 * Pure (the semantic re-check is *injected*, never called here), so it lives in core beside the seam:
 * every coordinator raises, publishes, rechecks and supersedes identically.
 */
import { parseExpectation } from './schema.js'
import type { Author, Clash, Expectation, ExpectationKind, RecordStatus } from './types.js'
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
   * What the check found and the author went ahead regardless. Carried on the write rather than
   * recomputed here — the check is a separate call, and recomputing would let a draft be accepted
   * against one glossary and stored against another.
   */
  contested?: Clash[]
}

export type ExpectationOutcome =
  | { ok: false; error: string; status?: number; currentRev?: number }
  | { ok: true; id: string; file: string; expectation: Expectation }

/** Maps a store mutation onto an ExpectationOutcome — not-found → 404, a stale rev → 409. */
function fromMutation(id: string, result: MutationResult, written: Expectation): ExpectationOutcome {
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
 * Publish a draft expectation — draft → ready. A draft counts toward nothing; publishing puts it into
 * coverage and the versioned contract. Rewrites in place, keeping its id and file. Idempotent.
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
 * Re-reads a live expectation against the specs as they are now, and rewrites what it clashes with.
 * The `check` is injected — a coordinator provides how a clash is found (a model pass, or the core
 * checks only). It never retires anything: if the disagreement survives, the expectation stays live
 * and contested and a human decides.
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
 * Retire an expectation, optionally replacing it. The replacement is written first and the original
 * moved second, so a crash between them leaves a duplicate-looking pair rather than a gap.
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
      { ...request.replacement, pass: request.replacement.pass ?? 'supersedes', from: id },
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
