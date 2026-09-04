/**
 * Checking a draft expectation *before* it exists.
 *
 * The write path for expectations used to be direct, on the argument that adding one is safe
 * by construction — the worst it can do is turn a check red. That is true and it is not the
 * whole cost. An expectation that contradicts a term's spec fails an implementation pass that
 * cannot fix it: the implementer may not edit `specs/`, and deliberately has no tool to retire
 * an expectation, so the round trip ends in "ask the human" having spent a pass to get there.
 * Cheap to write down, expensive to discover.
 *
 * The other reason is the one only the author knows: "I just noticed something" is often "I
 * forgot what we already decided". A draft is worth reading against the glossary for the same
 * reason a changeset is — which is what every other write here already does. Expectations were
 * the exception, and the exception was wrong.
 *
 * What this file catches is only what can be decided by looking, never by understanding:
 * a term that does not exist, and a draft already written down. Whether a draft *contradicts*
 * a spec is a question about meaning and belongs to @spec — see server/src/expectationCheck.ts.
 * Splitting them this way matters: these findings are always available, instantly, with no
 * credential and no model, so the gate still does something useful when the agent cannot run.
 */
import type { Clash, Expectation, Term } from './types.js'

/**
 * A finding and a stored conflict are the same thing on purpose.
 *
 * What the check reports is exactly what gets written onto the expectation when the author
 * raises it anyway. Two shapes here would mean a translation step, and a translation step is
 * where the quote gets dropped and the finding degrades into "there was a problem once".
 */
export type Finding = Clash
export type FindingKind = Clash['kind']

export interface ExpectationDraft {
  kind: Expectation['kind']
  terms: string[]
  given: string
  expect: string
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'does', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'that', 'the', 'then', 'this',
  'to', 'was', 'were', 'when', 'which', 'with',
])

/** Lowercase, punctuation to spaces, stopwords dropped — so wording varies but content does not. */
function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  )
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * How alike two statements have to be before this calls them the same thing.
 *
 * Set by what it costs to be wrong in each direction. A false duplicate is one line of text
 * the author reads and dismisses; a missed duplicate is two statements of one rule that drift
 * apart until they disagree and nobody knows which is current. So it leans towards flagging,
 * and the finding is advisory — it never refuses the write.
 */
const DUPLICATE = 0.6

export function checkDraft(
  draft: ExpectationDraft,
  terms: Term[],
  expectations: Expectation[],
): Finding[] {
  const findings: Finding[] = []
  const known = new Set(terms.map((term) => term.name))

  for (const term of draft.terms) {
    if (!known.has(term)) {
      findings.push({
        kind: 'unknown-term',
        subject: term,
        detail: `No term named "${term}". Coverage matches on names, so this would count towards nothing.`,
      })
    }
  }

  const draftTokens = contentTokens(`${draft.given} ${draft.expect}`)
  const draftSet = new Set(draft.terms)
  const draftTerms = [...draft.terms].sort().join(',')

  for (const existing of expectations) {
    if (existing.supersededBy !== null) continue

    const similarity = jaccard(draftTokens, contentTokens(`${existing.given} ${existing.expect}`))
    const sameTerms = [...existing.terms].sort().join(',') === draftTerms

    // Wording alone is not enough, and this cost a false positive to learn: "reopenTask
    // changes nothing and does not error" scored 0.6 against "completeTask changes nothing
    // and does not error", because the idempotence boilerplate is most of both sentences and
    // the one word that distinguishes them is the function name. Two statements about
    // different functions are not the same statement however alike they read — so a duplicate
    // also has to be about the same subject, meaning one term set contains the other.
    const aboutTheSameThing =
      sameTerms ||
      existing.terms.every((term) => draftSet.has(term)) ||
      draft.terms.every((term) => existing.terms.includes(term))

    if (similarity >= DUPLICATE && aboutTheSameThing) {
      findings.push({
        kind: 'duplicate',
        subject: existing.id,
        detail: `${existing.id} already says close to this. Two statements of one rule drift apart; supersede it instead if the wording needs fixing.`,
        quote: existing.given ? `Given ${existing.given} — ${existing.expect}` : existing.expect,
      })
    } else if (sameTerms) {
      findings.push({
        kind: 'overlaps',
        subject: existing.id,
        detail: `${existing.id} is about exactly the same terms. Fine if it covers a different situation — worth a look if it does not.`,
        quote: existing.given ? `Given ${existing.given} — ${existing.expect}` : existing.expect,
      })
    }
  }

  return findings
}

/** The spec text of every term a draft names — what @spec has to read to judge it. */
export function materialFor(draft: ExpectationDraft, terms: Term[]): Array<{ name: string; spec: string }> {
  return draft.terms
    .map((name) => terms.find((term) => term.name === name))
    .filter((term): term is Term => term !== undefined)
    .map((term) => ({ name: term.name, spec: term.spec }))
}
