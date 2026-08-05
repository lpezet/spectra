/**
 * The agent's tool surface.
 *
 * These are domain tools, not file tools, and that is the whole point. The human write
 * path is changesets-only; if the agent had `Write` on `specs/` it could edit a term
 * directly and the discipline would rest on the system prompt asking it not to. Here it
 * rests on there being no such tool. The agent physically cannot bypass review.
 *
 * Everything below is read-only except `raise_question`, which only ever produces a
 * proposal a human still has to answer — so nothing here needs an approval prompt yet.
 */
import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { analyzePending, computeBacklinks, summarizeOp } from '@tb/shared'
import type { PendingItem, Question, Term } from '@tb/shared'
import { raiseQuestion } from '../raise.js'
import type { RaiseRequest } from '../raise.js'
import { readChangesets, readQuestions, readTerms } from '../store.js'
import type { TranscriptStore } from '../transcripts.js'

/**
 * An op as the *tool* accepts it: one flat shape with an enum tag and optional fields,
 * rather than the discriminated union `shared/` uses.
 *
 * Not a style choice. Nested inside `options[] → proposal → ops[]`, a `z.discriminatedUnion`
 * defeats the SDK's JSON-Schema conversion and the whole MCP server silently fails to
 * register — the agent then reports having no tools at all, with nothing in the logs. Each
 * construct is fine on its own; it is the depth that breaks it.
 *
 * Nothing is lost: `raiseQuestion` runs the real schema over the result before writing, so
 * a malformed op is rejected there with a readable message rather than landing on disk.
 */
const attributeInput = z.object({
  name: z.string(),
  valueType: z.string().describe('string | number | boolean | date | ref:<TermName>, each with an optional [] suffix'),
  default: z.unknown().optional(),
  optional: z.boolean().optional(),
})

const opInput = z.object({
  op: z.enum(['add_entity', 'remove_entity', 'add_attribute', 'remove_attribute', 'modify_spec']),
  term: z.string().describe('The term this op targets'),
  termType: z.enum(['entity', 'event', 'function', 'attribute-type']).optional().describe('add_entity only; defaults to entity'),
  parent: z.string().nullable().optional().describe('add_entity only'),
  spec: z.string().optional().describe('Required for add_entity and modify_spec'),
  tags: z.array(z.string()).optional(),
  attributes: z.array(attributeInput).optional().describe('add_entity only'),
  attribute: z.unknown().optional().describe('add_attribute takes an attribute object; remove_attribute takes its name as a string'),
})

const proposalInput = z.object({
  summary: z.string(),
  ops: z.array(opInput),
  tests: z.array(z.string()).describe('Plain-language behaviours this change commits to'),
})

/** MCP tools return content blocks; every tool here answers with one JSON or text block. */
function say(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }
}

/** A term plus the relationships that make it make sense — the useful unit, not the file. */
function describeTerm(terms: Term[], name: string) {
  const term = terms.find((candidate) => candidate.name === name)
  if (!term) return null

  const backlinks = computeBacklinks(terms)
  return {
    ...term,
    children: backlinks.children[name] ?? [],
    referencedBy: (backlinks.byTarget[name] ?? []).map((reference) => ({
      from: reference.from,
      via: reference.via,
    })),
  }
}

/** Everything pending, flattened into comparable op-lists for the conflict analysis. */
function pendingItems(changesets: Awaited<ReturnType<typeof readChangesets>>['changesets'], questions: Question[]): PendingItem[] {
  const items: PendingItem[] = changesets.map((changeset) => ({
    id: changeset.id,
    kind: 'changeset',
    label: changeset.summary,
    ops: changeset.ops,
  }))

  for (const question of questions) {
    if (question.answer) continue
    for (const option of question.options) {
      if (!option.proposal) continue
      items.push({
        id: `${question.id}:${option.label}`,
        kind: 'question-option',
        label: `${question.id} — ${option.label}`,
        ops: option.proposal.ops,
      })
    }
  }

  return items
}

export function blueprintTools(transcripts: TranscriptStore) {
  const readGlossary = tool(
    'read_glossary',
    'Read the spec glossary. Omit `term` for every term in summary form; supply one to get its full spec, attributes, subtypes and everything that references it.',
    { term: z.string().optional().describe('A single term name, e.g. "Task"') },
    async (args) => {
      const { terms, problems } = await readTerms()

      if (args.term) {
        const described = describeTerm(terms, args.term)
        return say(
          described ?? {
            error: `No term named "${args.term}".`,
            known: terms.map((term) => term.name),
          },
        )
      }

      return say({
        terms: terms.map((term) => ({
          name: term.name,
          type: term.type,
          spec: term.spec,
          parent: term.parent,
          attributes: term.attributes.map((attribute) => `${attribute.name}: ${attribute.valueType}`),
        })),
        problems,
      })
    },
    { annotations: { readOnlyHint: true } },
  )

  const readQuestionsTool = tool(
    'read_questions',
    'Read questions raised against the glossary — what it does not settle, and what has been decided. Answered questions are the record of why the specs say what they say.',
    {
      status: z.enum(['open', 'answered', 'all']).optional().describe('Defaults to "all"'),
    },
    async (args) => {
      const { questions, problems } = await readQuestions()
      const status = args.status ?? 'all'
      const filtered = questions.filter((question) =>
        status === 'all' ? true : status === 'open' ? !question.answer : Boolean(question.answer),
      )

      return say({
        questions: filtered.map((question) => ({
          id: question.id,
          asks: question.asks,
          because: question.because,
          raisedBy: question.raisedBy,
          options: question.options.map((option) => ({
            label: option.label,
            detail: option.detail,
            ops: option.proposal?.ops.map(summarizeOp) ?? null,
          })),
          answer: question.answer,
        })),
        problems,
      })
    },
    { annotations: { readOnlyHint: true } },
  )

  const readChangesetsTool = tool(
    'read_changesets',
    'Read the pending changesets — proposed edits to the glossary awaiting review.',
    {},
    async () => {
      const { changesets, problems } = await readChangesets()
      return say({
        changesets: changesets.map((changeset) => ({
          id: changeset.id,
          summary: changeset.summary,
          fromQuestion: changeset.fromQuestion,
          ops: changeset.ops.map(summarizeOp),
          tests: changeset.tests,
        })),
        problems,
      })
    },
    { annotations: { readOnlyHint: true } },
  )

  const analyzePendingTool = tool(
    'analyze_pending',
    'Work out what to tackle first. Replays every pending changeset and unanswered question option through the changeset engine, alone and in pairs, and reports which ones break which — including cases where order is what matters. Use this before recommending where to start; do not reason it out by hand.',
    {},
    async () => {
      const [{ terms }, { changesets }, { questions }] = await Promise.all([
        readTerms(),
        readChangesets(),
        readQuestions(),
      ])

      const items = pendingItems(changesets, questions)
      const report = analyzePending(terms, items)

      return say({
        ...report,
        note: 'A conflict listed as {first, second} means applying `first` before `second` causes the diagnostics shown. If the reverse pair is absent, that order is safe.',
      })
    },
    { annotations: { readOnlyHint: true } },
  )

  const searchTranscripts = tool(
    'search_transcripts',
    'Search earlier conversations in this workspace for a word or phrase. Use it before asking the human to repeat context they may already have given.',
    {
      query: z.string().describe('Substring to look for, case-insensitive'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const hits = transcripts.search(args.query, args.limit ?? 20)
      return say(
        hits.map((hit) => ({
          session: hit.title,
          sessionId: hit.sessionId,
          role: hit.kind,
          at: hit.createdAt,
          text: hit.text,
        })),
      )
    },
    { annotations: { readOnlyHint: true } },
  )

  const raiseQuestionTool = tool(
    'raise_question',
    [
      'Raise a question against the glossary. Use this when the specs do not settle something a human must decide — never to record an observation.',
      'If it cannot be phrased as a question someone answers, it does not belong here.',
      '`because` must quote the spec text in conflict. "This was awkward to implement" is not grounds to change a spec; "these two spec sentences cannot both hold" is.',
      'The number of options is the answer shape: one means approve-or-decline, several means a genuine choice (do not signal a favourite by ordering), none means only the human can write the spec text.',
      'Do not use this to propose a change you are confident about and could simply describe — that is what a changeset is for.',
    ].join(' '),
    {
      asks: z.string().describe('The question itself, answerable as written'),
      because: z
        .string()
        .describe('Why it is being asked, quoting the conflicting spec text verbatim'),
      pass: z
        .string()
        .describe('What was being done when it came up, e.g. "implementation" or "review"'),
      file: z.string().optional().describe('Source file where it surfaced, if any'),
      terms: z.array(z.string()).describe('Glossary terms the question is about'),
      options: z
        .array(
          z.object({
            label: z.string(),
            detail: z
              .string()
              .optional()
              .describe('The tradeoff in plain language, including what this choice costs'),
            proposal: proposalInput
              .nullable()
              .optional()
              .describe('The changeset this option would raise. Null when it changes no specs.'),
          }),
        )
        .describe('Candidate answers; may be empty when only the human can write the spec'),
    },
    async (args) => {
      const outcome = await raiseQuestion({
        asks: args.asks,
        because: args.because,
        pass: args.pass,
        file: args.file,
        terms: args.terms,
        // proposalSchema validates the shape at the tool boundary; zod's inferred output
        // is structurally `Proposal` but widened, so it is asserted rather than re-parsed.
        options: args.options as RaiseRequest['options'],
      })

      return say(
        outcome.ok
          ? { raised: outcome.id, file: `specs/questions/${outcome.file}`, awaiting: 'a human answer' }
          : { error: outcome.error },
      )
    },
  )

  return [
    readGlossary,
    readQuestionsTool,
    readChangesetsTool,
    analyzePendingTool,
    searchTranscripts,
    raiseQuestionTool,
  ]
}

/** Fully-qualified names, as the SDK addresses in-process MCP tools. */
export const TOOL_NAMES = [
  'read_glossary',
  'read_questions',
  'read_changesets',
  'analyze_pending',
  'search_transcripts',
  'raise_question',
].map((name) => `mcp__blueprints__${name}`)
