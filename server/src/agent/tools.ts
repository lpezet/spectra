/**
 * The agent's tool surface.
 *
 * These are domain tools, not file tools, and that is the whole point. The human write
 * path is changesets-only; if the agent had `Write` on `specs/` it could edit a term
 * directly and the discipline would rest on the system prompt asking it not to. Here it
 * rests on there being no such tool. The agent physically cannot bypass review.
 *
 * Two of these write, and neither needs an approval prompt. `raise_question` produces a
 * question a human still has to answer; `propose_changeset` produces a changeset a human
 * still has to review and apply. Both land in a queue and change nothing on their own —
 * "writes a file" is not the same as "changes the glossary", and the approval already
 * exists downstream.
 */
import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { analyzePending, computeBacklinks, computeCoverage, summarizeOp } from '@tb/shared'
import type { PendingItem, Question, Term } from '@tb/shared'
import { markImplemented } from '../commit.js'
import { checkExpectation } from '../expectationCheck.js'
import { currentSnapshot, deployedVersion, recordExport } from '../specsExport.js'
import { proposeChangeset } from '../propose.js'
import { raiseQuestion } from '../raise.js'
import { raiseExpectation } from '../expectations.js'
import type { RaiseRequest } from '../raise.js'
import type { ProposeRequest } from '../propose.js'
import { readChangesets, readExpectations, readQuestions, readTerms } from '../store.js'
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
 * Nothing is lost: both write paths run the real schema over the result before writing, so
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
  // Typed rather than `unknown`: with no shape to follow the model reaches for
  // `attributes` (the add_entity field) and the write is refused on the first try.
  attribute: z
    .union([attributeInput, z.string()])
    .optional()
    .describe('add_attribute takes the attribute object; remove_attribute takes just its name as a string'),
})

const proposalInput = z.object({
  summary: z.string(),
  ops: z.array(opInput),
  tests: z.array(z.string()).describe('Plain-language behaviours this change commits to'),
})

type CallResult = { content: Array<{ type: 'text'; text: string }> }

/** MCP tools return content blocks; every tool here answers with one JSON or text block. */
function say(value: unknown): CallResult {
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

  const readExpectationsTool = tool(
    'read_expectations',
    'Read the expectations — what someone should be able to expect, stated outside the prose of the specs. Functional ones become tests over the domain; non-functional ones describe a running build. Pass `coverage` to get which entity/action pairs nothing has been said about yet, nearest first: that list is the work queue for what the glossary has named but nobody has thought through.',
    {
      coverage: z
        .boolean()
        .optional()
        .describe('Return the pair-coverage report instead of the expectation list'),
      term: z.string().optional().describe('Only expectations naming this term'),
    },
    async (args) => {
      const [{ terms }, { expectations, retired, problems }] = await Promise.all([
        readTerms(),
        readExpectations(),
      ])

      if (args.coverage) {
        const report = computeCoverage(terms, expectations)
        return say({
          ...report,
          note: 'Coverage means an expectation exists naming both ends of the pair — not that the behaviour is correct. distance 1 is an action naming the entity directly; 2 is reached through the entity graph, which is where the interactions nobody thought about tend to sit.',
        })
      }

      const wanted = (list: typeof expectations) =>
        args.term ? list.filter((expectation) => expectation.terms.includes(args.term!)) : list

      const live = wanted(expectations)
      const contested = live.filter((expectation) => expectation.contested.length > 0)

      return say({
        expectations: live,
        ...(contested.length > 0
          ? {
              warning: `${contested.map((entry) => entry.id).join(', ')} disagree with the specs and were recorded anyway. Do not write code to satisfy a contested expectation and do not change the specs to match it — which side gives is a decision only the human can make. Say what you found and leave it.`,
            }
          : {}),
        retired: wanted(retired).map((expectation) => ({
          id: expectation.id,
          expect: expectation.expect,
          supersededBy: expectation.supersededBy,
          retiredBecause: expectation.retiredBecause,
        })),
        problems,
      })
    },
    { annotations: { readOnlyHint: true } },
  )

  /**
   * The second write that needs no approval, and for the same reason as `raise_question`: it
   * cannot change what the app does. The worst an expectation can do is turn a check red,
   * which is the direction that surfaces a defect rather than concealing one.
   *
   * There is deliberately no tool for retiring one. That is the move that can turn a red check
   * green without touching code, and the agent most likely to want it is the one whose work
   * just failed it — so it stays a human act, over the HTTP route.
   */
  const raiseExpectationTool = tool(
    'raise_expectation',
    [
      'Record something someone should be able to expect. Use this when you notice a scenario the specs name but never settle the outcome of — especially one turned up by using or implementing the thing rather than reading it.',
      'It changes nothing and needs no approval: the most it can do is make a check go red.',
      'A functional expectation must be phrased using only glossary vocabulary — term names, attributes, function names. If you cannot write it without naming a button, a screen or a string in the UI, it is not an expectation about the domain and does not belong here.',
      'A non-functional one describes a property of a running build — responsiveness, persistence, accessibility — and is exempt from that rule.',
      'This is not a question. If the outcome turns on a product decision nobody has made, raise a question instead; an expectation asserts what should happen, so writing one is claiming the answer is already settled.',
      'Check read_expectations first — a near-duplicate is worse than nothing, because two statements of the same rule drift apart.',
      'What you write is read against the glossary before it lands. If it clashes with a spec it is still recorded, with the clash attached, and it will not count as coverage until a human settles which side gives — so read the findings that come back and say what they were.',
    ].join(' '),
    {
      kind: z.enum(['functional', 'non-functional']),
      terms: z
        .array(z.string())
        .describe('Glossary terms this concerns. Name every term involved — coverage is computed from this, so an expectation about an interaction must name both ends.'),
      given: z.string().optional().describe('The situation, if it is conditional'),
      expect: z.string().describe('What must hold'),
      pass: z.string().describe('What was being done when it came up, e.g. "implementation" or "usage"'),
      from: z.string().optional().describe('Question or changeset id this follows from, if any'),
      file: z.string().optional(),
    },
    async (args) => {
      const draft = {
        kind: args.kind,
        terms: args.terms,
        given: args.given ?? '',
        expect: args.expect,
      }

      // Checked on the way in, the same as the UI's gate. Not a refusal: an agent that noticed
      // a real disagreement should still be able to record it, and a tool that silently
      // discarded the finding would leave the write looking clean — which is the failure this
      // whole field exists to prevent.
      const [{ terms }, { expectations }] = await Promise.all([readTerms(), readExpectations()])
      const report = await checkExpectation(draft, terms, expectations)

      const outcome = await raiseExpectation({
        ...draft,
        pass: args.pass,
        from: args.from,
        file: args.file,
        contested: report.findings,
      })

      return say(
        outcome.ok
          ? {
              raised: outcome.id,
              file: `specs/expectations/${outcome.file}`,
              ...(report.findings.length > 0
                ? {
                    contested: report.findings,
                    note: 'Recorded, but it clashes with what the glossary already says. It will not count as coverage until a human settles which side gives. Do not implement it and do not change the specs to match it — report the clash and stop.',
                  }
                : { note: 'Live immediately. Cite this id in the test that proves it.' }),
            }
          : { error: outcome.error },
      )
    },
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

  const proposeChangesetTool = tool(
    'propose_changeset',
    [
      'Propose an edit to the glossary. Use this when the change is clear and there is no product decision left to make — a missing term, a spec that says two things, a name that does not match what it describes.',
      'It lands in the pending queue and changes nothing until a human reviews and applies it, so it is safe to propose; it is not safe to guess.',
      'If the change turns on a choice only the human can make, raise a question instead. Do not settle a fork by proposing one side of it — a changeset that quietly picked a default is far harder to review than a question that names the options.',
      'If the request needs no glossary change at all — presentation, wording in the UI, how something is displayed or implemented — say so and do not propose anything. The glossary describes the domain, not the app that renders it.',
      'Say in your reply what you did not decide. A proposal that names its own open ends is worth more than one that reads as finished.',
    ].join(' '),
    {
      summary: z.string().describe('One line: what this change does'),
      ops: z.array(opInput).describe('The edits, applied in order'),
      tests: z
        .array(z.string())
        .describe('Plain-language behaviours this change commits to — what a reviewer should expect to hold afterwards'),
      fromQuestion: z
        .string()
        .optional()
        .describe('Id of an already-answered question this follows from, if any'),
    },
    async (args) => {
      const outcome = await proposeChangeset({
        summary: args.summary,
        ops: args.ops as ProposeRequest['ops'],
        tests: args.tests,
        ...(args.fromQuestion ? { fromQuestion: args.fromQuestion } : {}),
      })

      return say(
        outcome.ok
          ? {
              proposed: outcome.id,
              file: `specs/changesets/${outcome.file}`,
              awaiting: 'human review — nothing has changed in the glossary yet',
            }
          : { error: outcome.error },
      )
    },
  )

  /**
   * The one refusal in this file, and it is git's non-fast-forward reject.
   *
   * `mark_implemented` is a claim: code exists matching this changeset. If the contract copy
   * stored alongside that code predates the change, nothing can verify the claim — so it is
   * refused rather than recorded.
   *
   * The message says versions and never a path. This side does not know where the
   * implementer keeps its code and must not act as though it does — `app/` is this repo's
   * arrangement, not part of the protocol. Git rejects a push by naming refs, not by telling
   * you where your working copy lives.
   *
   * It takes no version argument, deliberately. An agent that passed its own would call
   * export_specs, hold the new value, never write the file, and pass this check on the
   * second try; that is the obvious way round it and so it is not offered. The version is
   * read from the artifact instead — see deployedVersion.
   *
   * No override, for the same reason. A `force` flag would be a thing @coder could reach
   * for, and refreshing costs a tool call, so there is no case where anyone legitimately
   * knows better.
   */
  const markImplementedTool = tool(
    'mark_implemented',
    'Record that code has been written for an applied changeset. Call this only after the code actually matches what the changeset says — it is what stops the change showing as outstanding work in the UI. Refused unless your stored specs snapshot is at the current version, since otherwise the code was written against a contract that has since moved.',
    { id: z.string().describe('The applied changeset id, e.g. "cs-001"') },
    async (args) => {
      const current = (await currentSnapshot()).version
      const deployed = await deployedVersion()

      if (deployed === null) {
        return say({
          refused: 'You have no readable specs snapshot, so this claim cannot be checked.',
          specsVersion: current,
          fix: 'Call export_specs, store the result the way your project expects, then try again.',
        })
      }
      if (deployed !== current) {
        return say({
          refused: 'The specs have moved since your snapshot was taken, so this claim cannot be checked.',
          snapshotVersion: deployed,
          specsVersion: current,
          fix: 'Call export_specs and store the result. Then read_glossary for what actually changed — the snapshot names which terms moved, not what they now say — and confirm the code still matches before calling this again.',
        })
      }

      const outcome = await markImplemented(args.id, new Date().toISOString())
      return say(outcome.ok ? { marked: args.id, file: outcome.file } : { error: outcome.error })
    },
  )

  const exportSpecsTool = tool(
    'export_specs',
    'Fetch the specs contract at its current version. Store the returned JSON verbatim wherever your project keeps it, and commit it with the code: it is what lets the code be checked against the specs offline, and its version is what mark_implemented is checked against. Refresh it before an implementation pass. It carries names, kinds and hashes, not spec text — it tells you *which* terms moved, and read_glossary tells you what they now say. Do not hand-edit it.',
    {},
    async () => {
      const snapshot = await currentSnapshot()
      recordExport(snapshot, new Date().toISOString())
      return say(snapshot)
    },
    { annotations: { readOnlyHint: true } },
  )

  /**
   * Every result carries the current specs version.
   *
   * A `stale: true` flag would be this process's opinion, computed from a definition of
   * stale the caller then has to trust or ignore. A version is a fact: both sides hold one
   * and whoever needs to act compares them — the same reason git prints `abc123..def456`
   * rather than "you are behind".
   *
   * It rides in a second content block instead of being merged into the payload, because the
   * payloads have unrelated shapes and one of them is already a versioned snapshot.
   */
  return [
    readGlossary,
    readQuestionsTool,
    readChangesetsTool,
    readExpectationsTool,
    analyzePendingTool,
    searchTranscripts,
    raiseQuestionTool,
    raiseExpectationTool,
    proposeChangesetTool,
    markImplementedTool,
    exportSpecsTool,
  ].map((entry) => ({
    ...entry,
    handler: async (args: Record<string, unknown>, extra: unknown) => {
      const call = entry.handler as (a: unknown, e: unknown) => Promise<CallResult>
      const result = await call(args, extra)
      return {
        ...result,
        content: [
          ...result.content,
          { type: 'text' as const, text: JSON.stringify({ specsVersion: (await currentSnapshot()).version }) },
        ],
      }
    },
  }))
}

/** The subset a given agent may call, resolved from its definition. */
export function toolsFor(transcripts: TranscriptStore, names: readonly string[]) {
  const wanted = new Set(names)
  return blueprintTools(transcripts).filter((candidate) => wanted.has((candidate as { name: string }).name))
}

export function qualified(names: readonly string[]): string[] {
  return names.map((name) => `mcp__blueprints__${name}`)
}


