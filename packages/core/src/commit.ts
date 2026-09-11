/**
 * Committing a changeset — the review write, over the {@link SpecStore} seam.
 *
 * The engine here decides *what* the glossary should become and re-validates that against the
 * glossary as it is *now* — the source may have been hand-edited since the client last read it. The
 * persistence — which entries change, and the atomic move to applied — belongs to the store. It lives
 * in `@abseed/spectra-core`, beside the seam, so every coordinator applies, marks, and rejects identically
 * (the same reason `proposeChangeset`/`raiseQuestion` do).
 */
import { applyOps } from './changeset.js'
import { glossaryVersion } from './version.js'
import type { Diagnostic } from './types.js'
import type { SpecStore } from './specStore.js'

export type CommitOutcome =
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 400; error: string }
  | {
      ok: false
      status: 409
      error: string
      diagnostics: Diagnostic[]
      needsAcknowledgement: boolean
    }
  | {
      // The glossary moved out from under this changeset — reviewed against, or applied against, a
      // version that is no longer current (GH #93). `currentVersion` is where it is now; the client
      // re-reviews against that. Distinct from the diagnostics 409: nothing is wrong with the ops,
      // the world changed.
      ok: false
      status: 409
      error: string
      staleVersion: true
      currentVersion: string
    }
  | {
      ok: true
      appliedOps: number
      remainingOps: number
      written: string[]
      deleted: string[]
      resolvedTo: string
      diagnostics: Diagnostic[]
    }

export interface ApplyRequest {
  opIndices: number[]
  acknowledgeWarnings?: boolean
  /**
   * Optimistic concurrency (GH #93): the {@link glossaryVersion} the reviewer saw. When supplied and
   * the glossary has moved since, the apply is refused with a `staleVersion` 409 before any write —
   * "re-review." Omit it to keep the prior behaviour (validate-against-live and apply).
   */
  expectedVersion?: string
}

export async function applyChangeset(
  store: SpecStore,
  id: string,
  request: ApplyRequest,
): Promise<CommitOutcome> {
  const changeset = await store.findChangeset(id)
  if (!changeset) return { ok: false, status: 404, error: `No pending changeset with id "${id}".` }

  const indices = [...new Set(request.opIndices)].sort((a, b) => a - b)

  if (indices.length === 0) {
    return { ok: false, status: 400, error: 'No ops selected.' }
  }
  if (indices.some((index) => !Number.isInteger(index) || !changeset.ops[index])) {
    return { ok: false, status: 400, error: `Op indices out of range for changeset "${id}".` }
  }

  const { terms: before } = await store.readTerms()

  // Optimistic concurrency (GH #93). The version of the glossary this apply is computing against.
  // If the caller told us what they reviewed against and it has moved, refuse now — before any
  // validation or write — so the human re-reviews against what is actually there.
  const baseVersion = glossaryVersion(before)
  if (request.expectedVersion !== undefined && request.expectedVersion !== baseVersion) {
    return {
      ok: false,
      status: 409,
      error: 'The glossary changed since this changeset was reviewed. Re-review before applying.',
      staleVersion: true,
      currentVersion: baseVersion,
    }
  }

  // Re-run the same validation the UI ran, against the glossary as it is *now*.
  const result = applyOps(
    before,
    indices.map((index) => changeset.ops[index]!),
  )

  // The engine only saw the selected ops, so its indices count within that subset. Report them
  // as positions in the changeset the caller actually sent.
  const diagnostics: Diagnostic[] = result.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    opIndex: diagnostic.opIndex === null ? null : (indices[diagnostic.opIndex] ?? null),
  }))
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')

  if (errors.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'This selection would leave the glossary broken.',
      diagnostics,
      needsAcknowledgement: false,
    }
  }
  if (warnings.length > 0 && !request.acknowledgeWarnings) {
    return {
      ok: false,
      status: 409,
      error: 'This selection orphans references that still point at what it removes.',
      diagnostics,
      needsAcknowledgement: true,
    }
  }

  // The applied ops move to applied; anything left unselected stays pending, so a cherry-pick
  // never silently discards the ops the human did not accept.
  const appliedOps = indices.map((index) => changeset.ops[index]!)
  const remainingOps = changeset.ops.filter((_, index) => !indices.includes(index))

  const committed = await store.commitApplication({
    changesetId: id,
    nextTerms: result.terms,
    appliedOps,
    remainingOps,
    appliedAt: new Date().toISOString(),
    baseVersion,
  })

  // The compare-and-swap failed: another write landed between our read and our commit. Nothing was
  // written. Same "re-review" signal as a stale review — the glossary moved under us.
  if ('conflict' in committed) {
    return {
      ok: false,
      status: 409,
      error: 'The glossary changed while this changeset was being applied. Re-review before applying.',
      staleVersion: true,
      currentVersion: committed.currentVersion,
    }
  }

  const { written, deleted, resolvedTo } = committed

  return {
    ok: true,
    appliedOps: indices.length,
    remainingOps: remainingOps.length,
    written,
    deleted,
    resolvedTo,
    diagnostics,
  }
}

/**
 * Records that code has been written for an applied changeset — the human presses a button after
 * re-running the implementation pass. (The agent's own `mark_implemented` tool guards this with a
 * snapshot version; this human path just records it.)
 */
export async function markImplemented(
  store: SpecStore,
  id: string,
  at: string,
): Promise<{ ok: boolean; status?: number; error?: string; file?: string }> {
  const file = await store.markImplemented(id, at)
  if (file === null) return { ok: false, status: 404, error: `No applied changeset with id "${id}".` }
  return { ok: true, file }
}

export async function rejectChangeset(store: SpecStore, id: string): Promise<CommitOutcome> {
  const resolvedTo = await store.rejectChangeset(id)
  if (resolvedTo === null) return { ok: false, status: 404, error: `No pending changeset with id "${id}".` }

  return {
    ok: true,
    appliedOps: 0,
    remainingOps: 0,
    written: [],
    deleted: [],
    resolvedTo,
    diagnostics: [],
  }
}
