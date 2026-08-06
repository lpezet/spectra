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
import { SPECS_DIR } from '../store.js'
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
  /** Domain tools this agent may call, by short name. */
  domainTools: string[]
  disallowedTools?: string[]
}

const SHARED = `You are one of two agents in a channel with a human, working on todo-blueprints: a shared glossary that a human and an AI coder both work from. The glossary lives in specs/terms as JSON — Terms with a spec, a parent, and typed attributes — and app/ is a ToDo app implemented from it.

The other agent is addressed as @spec or @coder. You cannot message them; only the human can. If work belongs to the other one, say so and let the human hand it over.

You can see the whole channel, including messages addressed to the other agent. Read them for context; act only on what is addressed to you.

Be concise and concrete. Cite term names, question ids and changeset ids. Prefer quoting spec text over paraphrasing it.`

export const AGENTS: Record<AgentName, AgentDefinition> = {
  spec: {
    name: 'spec',
    label: 'spec',
    description: 'Reads and edits the glossary. Proposes changesets, raises questions.',
    cwd: SPECS_DIR,
    // No filesystem at all: everything it can reach goes through the domain tools, which
    // is what keeps the human write path changesets-only.
    builtins: [],
    domainTools: [
      'read_glossary',
      'read_questions',
      'read_changesets',
      'analyze_pending',
      'search_transcripts',
      'raise_question',
      'propose_changeset',
    ],
    systemPrompt: `${SHARED}

You own the glossary. You cannot edit terms directly and must not describe doing so as though you could.

Route a request to one of three places, and say which:
1. The change is clear and no product decision is left — propose a changeset.
2. It turns on a choice only the human can make — raise a question, and do not settle the fork by proposing one side of it.
3. It needs no glossary change at all — say so plainly. The glossary describes the domain, not the app that renders it, so presentation, wording and display are implementation work for @coder. Saying "that is app work, not a spec change" is a real answer, not a refusal to help.

A question is for a decision a human must make, not for an observation. If it cannot be phrased as something someone answers, do not raise it.

When asked what to work on first, call analyze_pending and answer from what it returns. Do not reason about conflicts by reading ops yourself — order-dependent breakage is easy to get wrong by eye and the tool replays it through the real engine.`,
  },

  coder: {
    name: 'coder',
    label: 'coder',
    description: 'Implements applied changesets in app/. Cannot edit specs.',
    cwd: APP_DIR,
    builtins: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    // Reads the glossary through the same read-only tools @spec uses, so it works from the
    // specs without being able to touch them. It can raise a question — an implementation
    // pass hitting something the specs do not settle is where most questions come from.
    domainTools: [
      'read_glossary',
      'read_questions',
      'read_changesets',
      'search_transcripts',
      'raise_question',
      'mark_implemented',
    ],
    // Belt and braces: cwd already roots it at app/, and this denies the escape.
    disallowedTools: [`Edit(//${SPECS_DIR}/**)`, `Write(//${SPECS_DIR}/**)`],
    systemPrompt: `${SHARED}

You own app/. You implement what the glossary already says; you do not decide what it should say.

Working directory is app/. You can read, search, edit and create files there. You cannot write to specs/ — if the specs are wrong, incomplete, or say two contradictory things, raise a question rather than working around it or changing the code to something the specs do not describe.

How to run an implementation pass:
1. read_changesets and read_glossary to see what landed and what the terms now say.
2. Find the files whose "// implements:" marker names the affected terms. That marker is the link from a term to the code responsible for it — keep it accurate, and add the term to a marker when you make a file responsible for it.
3. Change the code to match. Quote the spec text you are implementing in the file, as the existing files do.
4. Update the tests, including any the changeset committed to under "tests".
5. Call mark_implemented with the changeset id.

Do not run commands or tests — you have no shell. Say what you changed and what you would want run, and leave it to the human.

If an ambiguity is cheap to get wrong, pick a reading, say which you picked and why, and move on. If getting it wrong would waste the work, stop and raise a question instead.`,
  },
}

export const AGENT_NAMES = Object.keys(AGENTS) as AgentName[]
