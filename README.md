# todo-blueprints

A shared, structured vocabulary that a human (product/end-user) and an AI coding agent can
both read and write, sitting *above* the code. The human authors and evolves the spec
through a UI without ever looking at code; the agent implements it however it likes.

Phase 1 pilot of the Spec DSL / glossary concept — see `genesis.md` for the why and
`specs.md` for the scope. **This repo is the tool.** The ToDo domain in `specs/terms/` is
seed content, picked because it is boring enough not to distract and still has real edge
cases worth pinning down (`completeTask` on an already-done task, `deleteProject` with
tasks still inside).

Inspired by Unreal Blueprints, minus two things on purpose: there is no node/wire canvas
(positions cost maintenance without adding meaning — this is search-first with backlinks),
and there is no runtime to debug against (this is design-time only, so tests are the
observability layer).

## Running it

Two separate things run here, each with its own command.

```bash
npm install

npm run dev          # the spec tool, all on the host — express :5174, vite :5173
npm run dev:sandbox  # the same, with express and @coder in containers (see Sandbox below)
npm run dev:app      # the ToDo app implemented from those specs → http://localhost:5175

# Chat needs a credential — see .env.example. One of:
#   ANTHROPIC_API_KEY=sk-ant-api...        console key from console.anthropic.com
#   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...   from `claude setup-token`

npm test           # unit tests: the engine in shared/, the domain in app/
npm run typecheck
```

## Architecture

Two independent things run here. They share a repo and nothing else.

```
   browser tab                                browser tab
┌──────────────────────────┐              ┌────────────────────────┐
│  spec tool         :5173 │              │  ToDo app       :5175  │
│  vite — react            │              │  vite — react          │
└────────────┬─────────────┘              │                        │
             │ /api/* proxied to :5174    │  no server, no API     │
             ▼                            │  state is in memory,   │
┌──────────────────────────┐              │  gone on refresh       │
│  express           :5174 │              └────────────────────────┘
│                          │                          ▲
│  reads + writes specs/   │                          ╎
│  data/transcripts.db     │      the only link is the implementation
│  runs @spec; relays      │      pass: a human or @coder editing app/
│  @coder to its sandbox   │╌╌╌╌╌╌to match specs/. Nothing at runtime.
└──────────────────────────┘
```

`npm run dev` starts the **spec tool** — both halves of it, express and vite, under one
`concurrently`. `npm run dev:app` starts the **ToDo app**, separately and on purpose: it is
the *output* of this tool, not part of it.

`app/` is a standalone npm project, not a workspace: its own `node_modules`, its own
`tsconfig`, its own copy of TypeScript. Copy the directory anywhere and `npm install &&
npm test && npm run build` works with no repo around it. That is what lets a sandbox mount
`app/` and nothing else — a workspace whose dependencies are hoisted to a parent cannot be
isolated, because half of it lives somewhere the sandbox will not have.

That now includes the `implements:` drift check, which used to be the one thing `app/` could
not do alone. It compares its markers against `specs.snapshot.json` — a committed file, not
a directory somewhere else — so it runs anywhere the code runs, including inside a sandbox
that cannot see `specs/` at all. See **The snapshot** below. The app has never heard of
`specs/` at runtime: it was written from those files, and they are not present at runtime in
any form.

That separation is the point. If the app needed the spec tool running, the glossary would
be a config format rather than a design-time vocabulary.

**Talking to it directly.** Everything the chat panel does is plain HTTP through the Vite
proxy, so curl reaches the same endpoints the browser does:

```bash
curl localhost:5173/api/chat/agents
SID=$(curl -s -XPOST localhost:5173/api/chat/sessions -H 'Content-Type: application/json' \
  -d '{}' | jq -r .session.id)
curl -XPOST localhost:5173/api/chat/sessions/$SID/messages \
  -H 'Content-Type: application/json' -d '{"text":"@spec where should I start?","to":"spec"}'
curl "localhost:5173/api/chat/sessions/$SID/events"          # poll, or
curl -N "localhost:5173/api/chat/sessions/$SID/stream"       # the SSE stream the UI uses
```

An agent waiting on an approval blocks until answered, from curl exactly as from the UI:

```bash
curl -XPOST localhost:5173/api/chat/sessions/$SID/approvals/$APPROVAL_ID \
  -H 'Content-Type: application/json' -d '{"decision":"allow"}'
```

## Sandbox

`@coder` has a shell, and a shell escapes every path rule the SDK can express — `cd` goes
anywhere, redirection writes anywhere. The approval card has been the only real boundary,
which means it depends on someone reading a diff carefully at 6pm. The containers are the
boundary that does not.

```
        host :5173 (vite)                              internet
               │                                           ▲
               │ /api/* ──▶ 127.0.0.1:5174                 │ egress network
               ▼                                           │
      ┌──────────────────┐                        ┌────────┴─────────┐
      │  your browser    │───────────────────────▶│  spec   :5174    │
      └──────────────────┘                        │  owns specs/,    │
                                                  │  data/, the key  │
                                                  │                  │
                                                  │  /mcp/coder      │◀── tools
                                                  │  /anthropic      │◀── model API
                                                  └────────┬─────────┘
                                                           │ sandbox network
                                                           │ (internal: true)
                                                  ┌────────┴─────────┐
                                                  │  coder  :5177    │
                                                  │  app/ rw — the   │
                                                  │  only mount      │
                                                  │  no credential   │
                                                  │  no route out    │
                                                  └──────────────────┘
```

The container reaches the glossary and the model **only through express**. Two consequences
that are the point of the arrangement:

**The glossary is tools, not a mount.** `./specs:/work/specs:ro` used to be there. A mount
can offer reading and nothing else — `raise_question` and `mark_implemented` are writes to
`specs/`, and granting them by mount would have meant granting the ability to rewrite any
term. As tool calls they are exactly two capabilities, executed by the process that owns the
files and can refuse. And *which* tools `@coder` gets is decided by `agents.ts` on the server
side, so asking for `propose_changeset` gets "tool not found", not a refusal it can argue
with.

**The credential never enters the sandbox.** The container holds the literal string
`proxied-by-the-spec-tool`, because the SDK needs *something* present to start. Express drops
whatever arrives and substitutes the real token. A compromised container cannot read the
credential it spends, or spend it anywhere but through your process.

`spec` is on both networks and `coder` is on one. That asymmetry is the design: express is
the only way out, so anything `@coder` gets from the world comes through something express
chose to offer it.

Express is containerised for exactly one reason, and it is not isolation — `@spec` has no
filesystem and no shell, so a box around it removes nothing. **An internal docker network
cannot be reached from the host.** Publishing a port does not help; docker does not route
published ports on an internal network, so the host gets connection refused while the
service inside is perfectly healthy. Reaching `@coder` means being *on* the network.

What holds, verified with `internal: true` exactly as committed — a full turn, no egress:

| | |
|---|---|
| container has no route out | ✅ |
| `app/` is the only mount and the only writable thing | ✅ |
| model call reaches the API through `/anthropic` | ✅ |
| glossary tools arrive over `/mcp/coder` | ✅ 6 tools, from `agents.ts` |
| a write to `specs/` from inside the sandbox | ✅ raised `q-008` with quoted spec text |
| a tool outside `@coder`'s definition | ✅ `propose_changeset` → tool not found |
| approval card blocks an edit | ✅ declined Edit left the file byte-identical |
| container holds no credential | ✅ `proxied-by-the-spec-tool` |

**One correction the testing produced.** The prompts used to say every command is shown
before it runs. That is not true: for `Bash` the SDK classifies the command and lets ones it
judges read-only through without a card. `pwd && ls` ran unprompted; `touch
/work/app/probe-file` raised a card and was blocked. The card covers commands that *change*
things — the useful guarantee, but not the one that was written down.

**The chat panel uses this.** Messaging `@coder` relays the turn to the container over HTTP
and writes every event back into the same transcript rows the in-process path writes — so
the UI needs no idea which side ran it, and the approval card behaves identically. `@spec`
still runs in express: no filesystem, no shell, nothing to contain.

Verified through the chat API, the same path the browser takes: tool calls stream and settle
(none left hanging), a declined `Edit` left the file byte-identical, an approved one applied
and the transcript recorded both decisions.

**No fallback, deliberately.** If `CODER_URL` is set and the container is down, the turn does
not run — it records why. Running unsandboxed under a UI that says "sandboxed" is worse than
stopping, because you would believe you had a boundary. An *unset* `CODER_URL` is a different
thing: a deliberate choice to run without a sandbox, which is what plain `npm run dev` does
and what `/api/sandbox` reports as `configured: false`.

**One definition of who `@coder` is.** The container used to carry its own copy of the system
prompt, which had already drifted. It now fetches prompt, builtins, auto-approvals and tool
list from `/mcp/coder/profile` at the start of every run, so `agents.ts` stays the single
answer — and the copy an attacker in the box could edit is not the one that decides.

## The snapshot

The drift check needs two things that sit on opposite sides of the sandbox boundary: the
markers, which are in `app/`, and the specs, which are in the spec tool. When `specs/` stopped
being mounted, the check lost half its inputs and started skipping.

A tool answering the question live would work and would be wrong — `app/` has to stand alone,
and a test that needs a service running fails for anyone who does not have one. So the
contract arrives as a file. `@coder` calls `export_specs` and writes the result to
`app/specs.snapshot.json`, which is committed with the code:

```json
{
  "version": "57c11ce76dd8e416",
  "terms": [{ "name": "Task", "type": "entity", "hash": "e7a61e499b4da9b9" }]
}
```

Only what the check needs. Names and kinds answer "does everything have an implementer, and
does every marker name something real". The prose does not, so it is not here — a hash of it
is, covering spec text, parent and attributes.

**There is no timestamp, on purpose.** The file is a pure function of the specs, so
re-exporting when nothing changed leaves it byte-identical. Run the export; if git reports no
change, the contract did not move. A `generatedAt` would dirty it every time and bury exactly
the signal it exists for.

**That hash closes a gap the test structurally cannot.** A changeset that *rewrites* an
existing term's spec leaves the marker naming the term and still looking correct, so nothing
goes red — it always has and it still does. But refreshing the snapshot makes `git diff` name
the terms that moved:

```diff
       "name": "Task",
       "type": "entity",
-      "hash": "e7a61e499b4da9b9"
+      "hash": "893b1ee763ffb356"
```

The test cannot see it; review can.

### Versions, the way git does it

A snapshot nobody refreshed passes happily while the specs move on — green tests, wrong
answer. The model for guarding that is `git push`:

| git | here |
|---|---|
| remote `HEAD` | `specsVersion` — what `specs/` is at now |
| local ref | `version` inside the committed snapshot |
| `git fetch` | `export_specs`, then writing the file |
| non-fast-forward reject | `mark_implemented` refused on mismatch |

Every tool result carries `specsVersion` in a trailing block. Not a `stale` flag: a flag is
this process's *opinion*, computed from a definition the caller then has to trust or ignore.
A version is a fact — both sides hold one and whoever needs to act compares them, which is
why git prints `abc123..def456` rather than "you are behind". `GET /api/specs/version` reports
both numbers and offers no verdict.

**One refusal, and it is `mark_implemented`.** Reads are never blocked — `read_glossary`
returns current truth, so reading it while holding an old snapshot is harmless and often the
point. What becomes false is the *claim*: `mark_implemented` asserts code exists matching a
changeset, and if the contract copy committed beside that code predates the change, nothing
can verify it.

```json
{ "refused": "The snapshot in app/ is not at the current specs version…",
  "snapshotVersion": "57c11ce7…", "specsVersion": "dbeba28f…", "fix": "Call export_specs…" }
```

**No version argument, and no override.** An agent that supplied its own version could call
`export_specs`, hold the new value, never write the file, and pass on the second try — so
nothing is passed. The version is read from the artifact: directly when `@coder` runs
in-process, or from the sandbox reporting what it finds at its own mount, since only the
process holding the mount can say what is actually on disk. Verified by doing exactly that
cheat — `export_specs` called, file not written, `mark_implemented` still refused. A `force`
flag would be defeated the same way, so there is not one; refreshing costs a tool call, so
nobody legitimately knows better.

**Catching up is two steps.** The snapshot carries hashes, not spec text — it names *which*
terms moved and never what they now say. `read_glossary` is still required, and the prompt
says so, or the agent refreshes and assumes it knows the requirement.

**What this is and is not.** It is a correctness guard against forgetting. It is not a
security boundary: `@coder` could refresh the snapshot without touching the code and get
through. What makes that survivable is that the snapshot is *committed*, so cheating leaves a
specific artifact — a refresh with no corresponding code change, in the history you already
review. The security boundary remains the sandbox and the approval card.

Verified by adding a term to `specs/`, re-exporting, and watching the check fail with
`DriftProbe (entity)` — inside the sandbox, with no `specs/` anywhere near it.

## Layout

```
specs/                      the source of truth — plain JSON, hand-editable
  terms/*.json              one file per term
  changesets/*.json         pending proposals
  changesets/applied/       what landed
  changesets/rejected/      what was turned down
  questions/*.json          what the glossary does not settle, and what was decided
data/transcripts.db         chat history — gitignored, prunable, never the record
shared/src/                 the engine: types, value-type grammar, backlinks, conflicts
server/src/                 express — spec files, transcripts, and the two agents
  agent/agents.ts           who @spec and @coder are, and what each may reach
  agent/runner.ts           runs a turn, streams it, blocks on approvals
  agent/tools.ts            the domain tools both agents call
  agent/mcpHttp.ts          the same tools over HTTP, for an agent in another container
  anthropicProxy.ts         the model API, relayed so the sandbox needs no egress or key
  glossaryExport.ts         the contract as a file, so app/ can check itself offline
  sandbox.ts                whether the @coder container is up, asked from inside its network
web/src/                    react — browse, search, review, apply, chat
app/specs.snapshot.json     the glossary contract, committed — what the drift check reads
app/src/                    the ToDo app, written *from* specs/terms — the output side
coder/src/                  the sandboxed half of @coder — no history, no writes to specs/
Dockerfile.spec             express, on both networks
Dockerfile.coder            @coder, on the internal one
docker-compose.yml          the boundary between them
docker-compose.open.yml     the explicit escape hatch that removes it
```

Ports: **5173** spec tool UI, **5174** its API, **5175** the ToDo app, **5177** the coder
container (reachable only from inside the sandbox network). The API serves no HTML —
hitting `localhost:5174` in a browser gives a 404, which is correct.

The changeset engine lives in `shared/`, not the server: it is pure functions over
in-memory term arrays with no filesystem access. The web app uses it to *preview* what a
changeset would do and flag problems live as you toggle ops; the server uses the identical
code to *commit*. One set of rules, so the preview cannot disagree with the result.

## Data model

A **Term** is the atomic unit — roughly a class. `type` is `entity`, `event`, `function`
or `attribute-type`.

```json
{
  "name": "Task",
  "type": "entity",
  "spec": "A single actionable item within a Project. A Task is either done or not done — there is no in-progress state.",
  "parent": null,
  "tags": [],
  "attributes": [
    { "name": "title", "valueType": "string" },
    { "name": "done", "valueType": "boolean", "default": false },
    { "name": "dueDate", "valueType": "date", "optional": true },
    { "name": "project", "valueType": "ref:Project" }
  ]
}
```

`valueType` is a primitive (`string`, `number`, `boolean`, `date`) or `ref:<TermName>`,
either with an optional `[]` suffix for cardinality. Relationships are never stored — is-a
comes from `parent`, has-a from `ref:` attributes, and backlinks are recomputed from those
on every read, so a hand-edit can't leave a stale edge behind.

A **Changeset** is how edits are proposed: a structured list of ops, never free text.

```json
{
  "id": "cs-001",
  "summary": "Add a priority level to Task",
  "ops": [
    { "op": "add_entity", "term": "Priority", "termType": "attribute-type", "spec": "…" },
    { "op": "add_attribute", "term": "Task",
      "attribute": { "name": "priority", "valueType": "ref:Priority", "default": "normal" } }
  ],
  "tests": ["creating a Task without specifying priority defaults it to 'normal'"]
}
```

Ops: `add_entity`, `remove_entity`, `add_attribute`, `remove_attribute`, `modify_spec`.

## Reviewing a change

Open a changeset from the bar at the top and it renders as coloured highlights over the
glossary you are already looking at — green added, red removed, amber modified — rather
than a separate diff screen. Every op has a checkbox; toggling one re-validates the whole
selection immediately.

Two kinds of problem, deliberately treated differently:

- **Errors block.** The selection would reference something that does not exist — almost
  always a cherry-pick that left its dependency behind. There is no "I understand" story
  worth having here; it is simply wrong.
- **Warnings block until acknowledged.** The selection removes a term that other terms
  still point at. That is real breakage, but the human may mean it, so the Apply button
  stays available behind a checkbox that names exactly what breaks.

Applying re-validates server-side against the files as they are *now* (they may have been
hand-edited since the browser last read them), writes each term file atomically, and moves
the changeset to `applied/`. On a partial apply, only the accepted ops move; the ops you
did not accept stay pending in the original file, so a cherry-pick never silently discards
them. Rejecting moves the whole thing to `rejected/`. Git is the history.

Written files match the hand-authored format exactly — fixed key order, one line per
attribute — so an applied change shows up as a one-line diff instead of a reformat.

## The app (M5)

`app/` is the other half of the claim: an actual ToDo app implemented *from*
`specs/terms/*.json`. In-memory state, its own Vite on :5175, deliberately bare UI. Each
file that implements a term says so in a header comment —

```ts
// implements: completeTask
```

— so a later spec change can be traced to the code that needs updating. There is no
compiler and no automatic regeneration: re-running the implementation pass after a
changeset lands is an explicit task each time.

The UI logs what every spec'd function returned, because that is where the spec text is
either honoured or not: completing a done Task says *"was already done — no change"*
rather than erroring, and deleting a Project with open Tasks says *"refused — still holds
2 incomplete Tasks"* rather than cascading. `app/src/domain/domain.test.ts` pins the same
clauses down as 22 tests.

### What implementing it exposed about the specs

Writing the app is a much harsher reader of the glossary than reviewing it is. The
implementation pass fixed none of what it found in code — it raised questions instead, in
`specs/questions/`:

- **q-001 — no creation functions.** The glossary defines `completeTask`, `reopenTask` and
  `deleteProject`, but nothing that creates a Project or a Task, which is the first thing
  any user does. `createProject`/`createTask` in `app/src/domain/world.ts` are invented by
  the implementation and marked as such.
- **q-002 — `completeTask` on a RecurringTask was underdetermined.** "Marks the current
  occurrence done and schedules the next occurrence" describes two things happening to one
  entity with one `done` flag. **Answered**: a RecurringTask reopens at its next occurrence.
- **q-003 — `recurrenceRule` has no grammar.** Typed as a bare `string`, so the app had to
  invent one (`weekly`, `every 2 weeks`) and report rules it cannot parse.
- **q-004 — Projects holding a RecurringTask became undeletable.** Raised by the *second*
  implementation pass, as a direct consequence of answering q-002: `deleteProject` blocks
  while any Task is not done, and a RecurringTask now never is.

q-004 is the interesting one. It did not exist until a decision was made, which is the
argument for the loop being a loop rather than a review step — answers create questions.

## Questions — the loop back from implementation

Changesets carry edits *to* the glossary. Questions carry what the glossary does not
settle, discovered by trying to build from it. The three in `specs/questions/` are real
output from the M5 pass, not fixtures.

The unit is deliberately a **question**, not a "finding". If an entry cannot be phrased as
something you answer, it does not belong in the queue — that rules out the observations an
implementation pass would otherwise flood it with, and it stops the agent making product
decisions by dressing a guess up as a proposal. The count of options *is* the answer shape,
so there is no separate field to keep in sync:

| Options | Shape | Example |
|---|---|---|
| 1 | approve or decline | "add the creation functions I drafted" |
| 2+ | a choice, no default | RecurringTask completion — two readings, one product decision |
| 0 | only you can write it | nothing to pick from; answer in prose |

One rule holds it honest: **`because` must quote the spec text in conflict.** "This was
awkward to implement" is not grounds to change a spec; "these two spec sentences cannot
both hold" is. Without that, the glossary quietly decays into a transcript of whatever the
agent already built — the exact drift this repo exists to prevent.

Answering does two things and stops. The answer is written back into the question file,
where it stays as the record of *why* the glossary says what it says; the chosen option's
proposal is minted into the pending changeset queue with `fromQuestion` set, and goes
through the same review as any other change. **Nothing is applied.** Deciding the intent
and committing the edit stay separate acts.

Answers are not editable in the UI — a decision that was acted on should not be silently
overwritten. Change your mind by raising a new question.

That makes the answered questions a machine-readable version of the table below, which is
currently maintained by hand.

## Chat

The spec tool has an agent-backed chat dock, so navigating the queue and asking about the
specs no longer means a terminal in a third window. It needs `ANTHROPIC_API_KEY` in the
server environment; without one the panel still records what you type and says plainly
that it cannot run.

**The agent gets domain tools, not file tools** — `read_glossary`, `read_questions`,
`read_changesets`, `analyze_pending`, `search_transcripts`, `raise_question`. Built-in
file tools are switched off entirely. The human write path is changesets-only, and if the
agent held `Write` on `specs/` that rule would rest on the system prompt asking it not to.
Here it rests on there being no such tool. Raising a question is the one write it can make,
and that is safe by construction: a question changes nothing and still needs a human answer
before anything moves.

`analyze_pending` is the interesting one. "What should I do first" is computable — replay
every pending changeset and unanswered question option through the changeset engine, alone
and in pairs, and read the diagnostics. Order is usually the answer: adding
`Project.archived` before dropping `Project` is fine and doing it after is an error. The
agent is told to call it rather than reason about conflicts by eye, because eyeballing
order-dependent breakage is exactly what it will get wrong.

`@` in the composer completes over terms, questions and changesets — the vocabulary, not
files. A term's meaning spans its own file plus everything pointing at it, so `@Task`
expands to more than any path would.

### Two things that cost time to find

**Credentials are not interchangeable.** A console key (`sk-ant-api…`) goes in
`ANTHROPIC_API_KEY`; a subscription token from `claude setup-token` (`sk-ant-oat…`) goes in
`CLAUDE_CODE_OAUTH_TOKEN`. Put an OAuth token in the API-key variable and it loads
perfectly, reports "agent ready", and then fails every call with `Invalid API key`. The
server now checks the prefix on boot and says which variable it belongs in.

**Deeply nested zod defeats the SDK's JSON-Schema conversion, silently.** `raise_question`
originally reused `proposalSchema` from `shared/`, whose `ops` is a `z.discriminatedUnion`.
Nested inside `options[] → proposal → ops[]` that one tool failed to convert, which took
down the *entire* MCP server — the agent reported having no tools at all, with nothing in
any log. Every construct involved is fine on its own; only the depth breaks it. The tool
boundary now uses a flat op shape with an enum tag, and `raiseQuestion` still validates
with the real schema before writing, so nothing malformed reaches disk.

The agent also runs with `settingSources: []`. Without it the SDK inherits the machine's
Claude Code settings, and the spec agent picks up whatever MCP servers the user has
configured globally — Gmail, Drive, Calendar. A glossary tool has no business reaching
those.

### Transcripts

Conversations live in SQLite at `data/transcripts.db` — gitignored, prunable, and
deliberately not in `specs/`. The specs are the record of what was decided; a transcript is
the workspace that led there. A question may point at the exchange that produced it, but
must stay readable without it, so losing this database costs context and never costs a
decision.

The runner does not tie a run to the request that started it: a turn can take minutes and
closing the tab must not kill it. Durable events land in SQLite, the stream replays from a
cursor, and reconnecting is just "give me everything after the last id I saw". Text deltas
are live-only, so a reconnect mid-answer waits for the complete message rather than
stitching fragments. Tool calls record a status, which is what will make resuming an
interrupted run possible later without a schema change.

## Decisions made along the way

| Question | Decision |
|---|---|
| Array cardinality | `ref:Task[]` suffix, not a separate `cardinality` field — keeps files hand-editable |
| `deleteProject` semantics | Blocks when incomplete Tasks remain, rather than cascading. Stated in the spec text itself |
| Cherry-pick dependencies | Warn and block; never auto-pull dependent ops |
| Human write path | Changesets only — no direct term editor |
| Post-apply | Move to `applied/`; remaining ops stay pending |

## Not in Phase 1

Instance data (type-level specs only), any graph canvas, live AI changeset generation
(the fixtures in `specs/changesets/` stand in for it), auth, multi-user, collaboration.

## Where this stops

M0–M5 are done: browse, search, review a proposed change, apply it, and implement a
running app from the result. Questions close the loop in the other direction — the
implementation pass can now hand back what it could not decide.

The round trip has now run once, end to end: q-002 was answered in the UI, the changeset
it minted was reviewed and applied, `complete-task.json` changed on disk, the
implementation pass was re-run over `app/`, and the behaviour changed — a RecurringTask
now reopens at its next occurrence instead of sitting done. The three tests the changeset
committed to are in `app/src/domain/domain.test.ts` and pass, and the pass came back with
q-004.

Re-running the pass is not a command. It is a directed ask — point Claude Code at
`specs/terms/` and have it update `app/` to match. The `// implements:` markers are what
make that targetable rather than a rewrite.

The reassess point: whether to wire live AI changeset generation into the spec UI, or move
to the Phase 2 Pac-Man pilot to stress-test the schema against events and reactive
fan-out. The three questions are evidence for that call — note that all three came from
one afternoon of implementing six terms, which says something about how much a schema
review misses.
