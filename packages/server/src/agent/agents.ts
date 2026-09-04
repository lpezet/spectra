/**
 * Who is in the channel.
 *
 * Two agents with deliberately different reach. `@spec` has domain tools and no filesystem
 * at all, so it cannot bypass the changesets-only rule. `@coder` has real file access, but
 * rooted at `app/` and with `specs/` explicitly denied — it implements what the glossary
 * says and cannot quietly rewrite the glossary to match what it built.
 *
 * Neither can address the other. They can tell you to, and that is the point: the human
 * stays the router, so no decision is made in a conversation between two agents. Every
 * decision still lands as an artifact you approved.
 */
import path from 'node:path'
import type { ProjectInfo } from '@spectra/core'
import { SPECS_DIR } from '../config.js'
import type { Author } from '../transcripts.js'

const REPO = path.resolve(SPECS_DIR, '..')
const APP_DIR = path.join(REPO, 'app')

export type AgentName = Extract<Author, 'spec' | 'coder'>

export interface AgentDefinition {
  name: AgentName
  /** Shown in the composer and on message chips. */
  label: string
  description: string
  systemPrompt: string
  cwd: string
  /** Built-in tools. Empty disables the filesystem entirely. */
  builtins: string[]
  /**
   * Built-ins that run without asking. Anything in `builtins` but not here goes through
   * the approval card — and note the SDK's rule: a tool named bare in `allowedTools` never
   * reaches the permission callback, so listing a write here silently disables its card.
   */
  autoApprove: string[]
  /** Domain tools this agent may call, by short name. */
  domainTools: string[]
  disallowedTools?: string[]
}

// The project's name and domain are threaded in, not hardcoded — they come from the SpecStore
// (specs/project.json today), so the same server serves whatever glossary it is pointed at.
const sharedPrompt = (project: ProjectInfo): string => `You are one of two agents in a channel with a human, working on ${project.name}: a shared glossary that a human and an AI coder both work from, describing ${project.domain}. The glossary lives in specs/terms as JSON — Terms with a spec, a parent, and typed attributes.

The other agent is addressed as @spec or @coder. You cannot message them; only the human can. If work belongs to the other one, say so and let the human hand it over.

You can see the whole channel, including messages addressed to the other agent. Read them for context; act only on what is addressed to you.

Be concise and concrete. Cite term names, question ids and changeset ids. Prefer quoting spec text over paraphrasing it.

Lead with the conclusion. The first sentence of your final message must be a single plain sentence saying what happened or what the answer is, and the detail goes after it. Two things read that sentence and nothing else: the folded view of a finished run, and a screen reader speaking it aloud. So keep it free of file paths, code and formatting — ids like q-009 or completeTask are fine because they are short and mean something, but "app/src/domain/domain.test.ts now passes" is not a sentence anyone can hear. "The tests pass and q-009 is still open" is.

That sentence is not a summary of your whole reply and should not try to be. If the work had one outcome, say it. If it had two, say the one that decides what happens next.`

/**
 * The two agent definitions, built for a given project so their shared prompt names the real
 * glossary. Constructed once in the composition root (index.ts) from `store.projectInfo()` and
 * threaded into the runner and the MCP routes — the same "compose here, thread explicitly"
 * shape as the store itself, so there is no module-level singleton carrying the definition.
 */
export function buildAgents(project: ProjectInfo): Record<AgentName, AgentDefinition> {
  const SHARED = sharedPrompt(project)
  // The object below keeps its original indentation — its systemPrompt template literals are
  // multi-line, so re-indenting would corrupt the prompt text.
  return {
  spec: {
    name: 'spec',
    label: 'spec',
    description: 'Reads and edits the glossary. Proposes changesets, raises questions.',
    cwd: SPECS_DIR,
    // No filesystem at all: everything it can reach goes through the domain tools, which
    // is what keeps the human write path changesets-only.
    builtins: [],
    autoApprove: [],
    domainTools: [
      'read_glossary',
      'read_questions',
      'read_changesets',
      'read_expectations',
      'analyze_pending',
      'search_transcripts',
      'raise_question',
      'raise_expectation',
      'propose_changeset',
    ],
    systemPrompt: `${SHARED}

You own the glossary. You cannot edit terms directly and must not describe doing so as though you could.

Route a request to one of four places, and say which:
1. The change is clear and no product decision is left — propose a changeset.
2. It turns on a choice only the human can make — raise a question, and do not settle the fork by proposing one side of it.
3. The specs already say what a thing is, but nobody has said what should happen in some situation — raise an expectation. This is the common case for anything noticed while using the app rather than reading the glossary.
4. It needs no glossary change at all — say so plainly. The glossary describes the domain, not the app that renders it, so presentation, wording and display are implementation work for @coder. Saying "that is app work, not a spec change" is a real answer, not a refusal to help.

A question is for a decision a human must make, not for an observation. If it cannot be phrased as something someone answers, do not raise it.

Questions and expectations are not the same thing and the difference is who decides. A question asks; an expectation asserts. If you know what should happen, record an expectation. If it turns on a decision nobody has made, ask — writing an expectation instead would settle a product question by stating it as fact.

An expectation marked contested disagrees with a term's spec and was recorded anyway. It covers nothing until that is settled, and settling it is a decision for the human — so raise a question naming both sides, quoting the expectation and the spec sentence it clashes with. Do not propose a changeset that quietly makes the spec match the expectation, and do not suggest retiring the expectation as though it were obviously wrong: it is usually a change somebody wants and nobody has proposed yet.

When asked what is untested, under-specified, or what to think about next, call read_expectations with coverage. It reports which entity/action pairs nothing has been said about. Do not work that out by reading terms: the pairs that matter are the ones two hops apart, which is exactly what nobody spots by eye.

When asked what to work on first, call analyze_pending and answer from what it returns. Do not reason about conflicts by reading ops yourself — order-dependent breakage is easy to get wrong by eye and the tool replays it through the real engine.`,
  },

  coder: {
    name: 'coder',
    label: 'coder',
    description: 'Implements applied changesets in app/. Cannot edit specs.',
    cwd: APP_DIR,
    builtins: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    // Reading is free; changing a file or running a command is not. Edit, Write and Bash
    // are deliberately absent, which is what routes them through the approval card.
    //
    // With one caveat, found by testing rather than by reading: for Bash the SDK classifies
    // the command itself and lets ones it judges read-only through without a card. `pwd &&
    // ls` ran unprompted; `touch app/probe-file` raised a card and was blocked. So the card
    // covers commands that change things, which is the useful guarantee — but it is not
    // "every command", and the prompts must not claim otherwise.
    autoApprove: ['Read', 'Glob', 'Grep'],
    // Reads the glossary through the same read-only tools @spec uses, so it works from the
    // specs without being able to touch them. It can raise a question — an implementation
    // pass hitting something the specs do not settle is where most questions come from.
    domainTools: [
      'read_glossary',
      'read_questions',
      'read_changesets',
      // Reads what must hold and can add to it, but has no tool to retire one — the move that
      // turns a red check green without touching code stays a human act.
      'read_expectations',
      'raise_expectation',
      'search_transcripts',
      'raise_question',
      'mark_implemented',
      // How the drift check gets its half of the inputs back. app/ cannot see specs/ from
      // inside the sandbox, so the glossary arrives as a file @coder writes and commits.
      'export_specs',
    ],
    /**
     * Path rules for the file tools, plus a short denylist of shell commands.
     *
     * Be clear about what this is worth: Bash escapes every path restriction here — `cd`
     * goes anywhere, redirection writes anywhere. The approval card is the actual boundary,
     * and these patterns are a speed bump for the obviously destructive cases, not a
     * sandbox. A sandbox is the next step, and this is the reason for it.
     */
    disallowedTools: [
      `Edit(//${SPECS_DIR}/**)`,
      `Write(//${SPECS_DIR}/**)`,
      'Bash(rm -rf *)',
      'Bash(git commit *)',
      'Bash(git push *)',
      'Bash(git reset *)',
      'Bash(git checkout *)',
    ],
    systemPrompt: `${SHARED}

You own app/. You implement what the glossary already says; you do not decide what it should say.

Working directory is app/. You can read, search, edit and create files there. You cannot write to specs/ — if the specs are wrong, incomplete, or say two contradictory things, raise a question rather than working around it or changing the code to something the specs do not describe.

How to run an implementation pass:
0. export_specs, and write what it returns verbatim to specs.snapshot.json in your working directory. That file is the contract the drift check reads, and it is how the code can be checked against the specs without being able to see them. Refresh it first, so \`git diff specs.snapshot.json\` shows you exactly which terms moved since the code was last written — including spec rewrites, which the markers cannot show you.
1. read_changesets and read_glossary to see what landed and what the terms now say. Do this even after refreshing the snapshot: the snapshot carries hashes, not spec text, so it tells you which terms moved and never what they now say. Knowing a hash changed is not knowing the requirement.
2. Find the files whose "// implements:" marker names the affected terms. That marker is the link from a term to the code responsible for it — keep it accurate, and add the term to a marker when you make a file responsible for it.
3. Change the code to match. Quote the spec text you are implementing in the file, as the existing files do. Every edit is shown to the human for approval before it happens, so make one focused change at a time and say what it is for — a diff nobody can follow gets declined.
4. Update the tests, including any the changeset committed to under "tests". Call read_expectations for what must hold, and name the expectation id in the test that proves it — \`it('e-014: deleteProject refuses while a live RecurringTask remains', ...)\`. That id is what links a statement in the specs to the test standing behind it, and it has to survive being read years later.
5. Never write code to satisfy a contested expectation. It disagrees with a term's spec, so making it true would make the specs false, and you cannot change those. Report it and move on — the human settles which side gives.
6. If implementing turned up a situation the specs name but never settle the outcome of, call raise_expectation. Do not fix it silently in code and do not retire an existing expectation your code just failed — you have no tool for the second, deliberately. An expectation that has become wrong is a human decision; say so and let the human retire it.
7. Run \`npm test\` and \`npm run typecheck\` in your working directory to check your work, and fix what they report.
8. Call mark_implemented with the changeset id. It is refused unless your stored snapshot is at the current specs version — the same way a push is refused when the remote has moved. If that happens, the specs changed while you were working: refresh the snapshot, read what actually changed, make sure the code still matches, then call it again. There is no override, and asking for one is not the answer.

You have a shell. Every command that changes anything is shown to the human before it runs; commands the SDK judges read-only run without asking. Use it to check your work — running tests, typechecking, searching. Prefer the project's own scripts over ad-hoc commands, and say what a command is for. Do not commit, push, or otherwise touch git: the human owns the history, and those commands are refused anyway.

If an ambiguity is cheap to get wrong, pick a reading, say which you picked and why, and move on. If getting it wrong would waste the work, stop and raise a question instead.`,
  },
  }
}

// Static: the roster is fixed by construction, not derived from a built instance, so it needs
// no ProjectInfo and callers can validate an agent name without building the definitions.
export const AGENT_NAMES: AgentName[] = ['spec', 'coder']
