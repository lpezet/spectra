/**
 * Committing a changeset. The engine in @tb/shared decides *what* the glossary should become
 * and this re-validates that server-side against the glossary as it is *now* — the files may
 * have been hand-edited since the client last read them. The persistence — which files change,
 * and the atomic move to `applied/` — belongs to the store.
 */
import { applyOps } from '@tb/shared'
import type { Diagnostic } from '@tb/shared'
import type { SpecStore } from './specStore.js'

// termFileName used to live here; kept re-exported from its new home so importers are unmoved.
export { termFileName } from './serialize.js'

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

  // The applied ops move to applied/; anything left unselected stays pending, so a cherry-pick
  // never silently discards the ops the human did not accept.
  const appliedOps = indices.map((index) => changeset.ops[index]!)
  const remainingOps = changeset.ops.filter((_, index) => !indices.includes(index))

  const { written, deleted, resolvedTo } = await store.commitApplication({
    changesetId: id,
    nextTerms: result.terms,
    appliedOps,
    remainingOps,
    appliedAt: new Date().toISOString(),
  })

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
 * Records that code has been written for an applied changeset.
 *
 * A stopgap: the human presses a button after re-running the implementation pass. The right
 * owner is the coder agent, which knows exactly when a pass finished and which changesets it
 * read — this is the first tool it should get.
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
