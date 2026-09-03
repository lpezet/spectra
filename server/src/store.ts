/**
 * Where the glossary lives, and the one default instance the single-tenant server shares.
 *
 * The reads and writes moved to {@link SpecStore}; what stays here is the boot-time decision
 * of *which* store this process talks to. Today that is one {@link FileSystemSpecStore} rooted
 * at `SPECS_DIR`, constructed once and imported wherever a write path or a route needs it.
 * Resolving a store per request (per tenant) is the next slice — the class is already
 * constructor-injected, so that is a wiring change here, not a rewrite of the callers.
 *
 * The thin `readTerms`/`readChangesets`/… re-exports keep the routes and the export module on
 * the same names they always used; each is just `store.readX()`.
 */
import path from 'node:path'
import { FileSystemSpecStore } from './fileSystemSpecStore.js'

export const SPECS_DIR =
  process.env.SPECS_DIR ?? path.resolve(import.meta.dirname, '../../specs')

/** The default store for this (single-tenant) process. */
export const store = new FileSystemSpecStore(SPECS_DIR)

export const readTerms = () => store.readTerms()
export const readChangesets = () => store.readChangesets()
export const readQuestions = () => store.readQuestions()
export const readExpectations = () => store.readExpectations()
