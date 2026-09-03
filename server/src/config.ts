/**
 * Where the filesystem project lives.
 *
 * This is not the store — it is the one path the *filesystem* backend and the sandbox both
 * resolve from: `@coder`'s `app/` sits beside it, and the co-located snapshot fallback is read
 * relative to it. The store instance is constructed from this in the composition root
 * (index.ts) and threaded from there; a SQL/hosted deployment would resolve a store per tenant
 * and this constant would matter only to the filesystem paths that still genuinely live on disk.
 */
import path from 'node:path'

export const SPECS_DIR =
  process.env.SPECS_DIR ?? path.resolve(import.meta.dirname, '../../specs')
