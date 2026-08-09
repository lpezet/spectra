/**
 * The half of the check that needs to understand what the words mean.
 *
 * `checkDraft` in @tb/shared catches what can be decided by looking — an unknown term, a
 * duplicate. Whether a draft *contradicts* a spec cannot be: e-011 said "re-enabled any
 * recurring tasks present in project" and unarchiveProject says "Does not re-enable any
 * RecurringTask that archiving ended". No amount of token overlap separates that from
 * agreement; the two sentences are lexically almost identical and mean opposite things.
 *
 * So this is a model call, and it is deliberately a *small* one: no tools, no MCP server, no
 * session, no transcript. Everything it needs — the draft, the spec text of every term the
 * draft names, and the expectations already covering those terms — is handed to it in the
 * prompt. A check that could go browsing would be slower, would need approvals, and could
 * fail in more ways, to answer a question that fits on one screen.
 *
 * It reports and never decides. @spec's standing constraint is that it does not settle a fork
 * by picking a side, and "is this a legitimate thing to want?" is exactly such a fork: e-011
 * was not wrong, it was a change to the glossary nobody had proposed yet. So the findings come
 * back as findings, the button stays with the human, and a contradiction is routed to the one
 * place the repo already has for "somebody must decide" — a question.
 *
 * Degrades rather than blocks. With no credential, or when the call fails, `checked` comes
 * back false and the deterministic findings still stand. A gate that cannot be opened when the
 * model is down would be a worse gate than none, because the thing it stops is you writing
 * down something you noticed.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { checkDraft, materialFor } from '@tb/shared'
import type { Expectation, ExpectationDraft, Finding, Term } from '@tb/shared'
import { AgentRunner } from './agent/runner.js'

export interface CheckReport {
  findings: Finding[]
  /** False when the semantic pass did not run — no credential, or it failed. */
  checked: boolean
  /** Why it did not run, when it did not. */
  note?: string
}

const SYSTEM = `You check a proposed expectation against a glossary before it is written down.

An expectation states what should happen in a specific situation. A term's spec states what something is. Both are normative, so they can conflict.

You are looking for exactly two things:

1. contradicts — the draft and a term's spec cannot both hold. Quote the exact sentence from the spec that clashes. Be strict: a draft that is merely *not mentioned* by a spec does not contradict it, and neither does one that adds detail the spec leaves open. Only flag this when believing both would require the code to do two different things.

2. restates — the draft says what a spec already says, adding no situation and no outcome the spec does not already give. This is not an error; it is an expectation that will pass the moment it is written and prove nothing.

You are not judging whether the draft is a good idea, whether it is well written, or whether the author should want it. A draft that contradicts the glossary may be entirely reasonable — it may be a change somebody should propose. Say what it clashes with and stop there.

Reply with JSON only, no prose around it:
{"findings":[{"kind":"contradicts","subject":"<term name>","detail":"<one sentence>","quote":"<the clashing sentence, verbatim>"}]}

An empty list is the common and correct answer. Return {"findings":[]} when nothing clashes.`

function describe(draft: ExpectationDraft, terms: Term[], nearby: Expectation[]): string {
  const material = materialFor(draft, terms)

  return [
    'DRAFT EXPECTATION',
    `  kind: ${draft.kind}`,
    `  terms: ${draft.terms.join(', ')}`,
    `  given: ${draft.given || '(unconditional)'}`,
    `  expect: ${draft.expect}`,
    '',
    'SPECS OF THE TERMS IT NAMES',
    ...material.map((entry) => `  ${entry.name}: ${entry.spec}`),
    '',
    'EXPECTATIONS ALREADY COVERING THOSE TERMS',
    ...(nearby.length > 0
      ? nearby.map(
          (entry) =>
            `  ${entry.id}: ${entry.given ? `given ${entry.given} — ` : ''}${entry.expect}`,
        )
      : ['  (none)']),
  ].join('\n')
}

/** Pulls the JSON object out of a reply that may have wandered into prose around it. */
function parseFindings(text: string): Finding[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return []

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { findings?: unknown }
    if (!Array.isArray(parsed.findings)) return []

    return parsed.findings
      .filter((entry): entry is Finding => {
        const candidate = entry as Partial<Finding>
        return (
          (candidate.kind === 'contradicts' || candidate.kind === 'restates') &&
          typeof candidate.subject === 'string' &&
          typeof candidate.detail === 'string'
        )
      })
      .map((entry) => ({
        kind: entry.kind,
        subject: entry.subject,
        detail: entry.detail,
        ...(typeof entry.quote === 'string' ? { quote: entry.quote } : {}),
      }))
  } catch {
    // A reply that is not JSON is a check that did not happen, not a draft that is clean.
    return []
  }
}

export async function checkExpectation(
  draft: ExpectationDraft,
  terms: Term[],
  expectations: Expectation[],
): Promise<CheckReport> {
  const findings = checkDraft(draft, terms, expectations)

  const misconfigured = AgentRunner.misconfiguration
  if (misconfigured) return { findings, checked: false, note: misconfigured }
  if (!AgentRunner.configured) {
    return {
      findings,
      checked: false,
      note: 'No credential, so only the mechanical checks ran — nothing has read this against the specs.',
    }
  }

  const named = new Set(draft.terms)
  const nearby = expectations.filter(
    (entry) => entry.supersededBy === null && entry.terms.some((term) => named.has(term)),
  )

  try {
    let reply = ''
    for await (const message of query({
      prompt: describe(draft, terms, nearby),
      options: {
        tools: [],
        allowedTools: [],
        // Same reason as the chat agents: without this the SDK inherits whatever MCP servers
        // the machine has configured globally, which a glossary check has no business reaching.
        settingSources: [],
        systemPrompt: SYSTEM,
      },
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') reply += block.text
        }
      }
    }

    return { findings: [...findings, ...parseFindings(reply)], checked: true }
  } catch (cause) {
    return {
      findings,
      checked: false,
      note: `The specs check could not run: ${(cause as Error).message}`,
    }
  }
}
