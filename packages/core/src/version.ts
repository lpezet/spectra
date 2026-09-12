/**
 * A content version for the glossary — an etag, not a digest.
 *
 * Concurrency needs one question answered cheaply: "is the glossary still what this changeset was
 * computed against?" So this maps the terms to a short token that changes iff the terms change, and
 * is compared as a string. It is the base for the optimistic-concurrency guard in `commit.ts`
 * (`applyChangeset`'s `expectedVersion`, and the compare-and-swap `commitApplication` does on
 * `baseVersion`).
 *
 * Two deliberate properties:
 *   - **Pure function of the terms, order-independent.** Terms are sorted by name and each is
 *     serialized canonically (attributes sorted, absent fields normalized), so re-reading an
 *     unchanged glossary yields the same token — the same discipline the snapshot keeps, for the
 *     same reason (a token that moved on a no-op would train people to ignore it).
 *   - **Synchronous and dependency-free.** No `crypto` — partly so it types and runs identically on
 *     Node and a Worker, but mostly so a backend can compute it *inside* a synchronous transaction
 *     and make the compare-and-swap genuinely atomic. This is change detection, not security, so a
 *     fast non-cryptographic hash is the right tool; an attacker forging a colliding glossary is not
 *     in the threat model (the writer is already authorized).
 *
 * Terms only — not expectations. Changesets mutate terms; expectations are a separate write path with
 * their own `rev` guard, so folding them in here would move the token on writes this guard does not
 * cover. (This is why it is distinct from `specsSnapshot`'s version, which covers both.)
 */
import type { Term } from './types.js'

/** The canonical, order-independent serialization the token hashes — every field a changeset can move. */
function canonicalize(terms: Term[]): string {
  return JSON.stringify(
    [...terms]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((term) => ({
        name: term.name,
        type: term.type,
        spec: term.spec,
        parent: term.parent,
        tags: [...(term.tags ?? [])].sort(),
        attributes: [...term.attributes]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((attribute) => ({
            name: attribute.name,
            valueType: attribute.valueType,
            default: attribute.default ?? null,
            optional: attribute.optional === true,
          })),
      })),
  )
}

/**
 * The glossary's content token. `cyrb53` — a small, well-distributed 53-bit non-crypto hash — over
 * the canonical serialization, rendered as hex. An empty glossary is a stable non-empty token, so
 * "no terms" is still comparable and distinct from any populated state.
 */
export function glossaryVersion(terms: Term[]): string {
  const str = canonicalize(terms)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(16).padStart(14, '0')
}
