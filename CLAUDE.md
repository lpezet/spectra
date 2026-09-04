# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` is long and carries the reasoning behind most of what follows. Read the relevant
section of it before changing anything structural — nearly every design choice here has a
stated "and here is why the obvious alternative is wrong" attached.

## Commands

```bash
npm install                    # root workspaces (shared, server, web)

npm run dev                    # spec tool, unsandboxed: express :5174 + vite :5173
npm run dev:sandbox            # same, with express and @coder in containers + vite on host
                               #   @coder has no project to point at yet — see "The consumer project" below

npm test                       # shared, server, web (each is a separate vitest run)
npm run typecheck              # tsc across shared, server, web

npm run sandbox:logs           # docker compose logs -f
npm run sandbox:down           # docker compose down
```

Single test file / single test name (vitest per workspace, so target the workspace first):

```bash
npm test -w shared -- src/changeset.test.ts
npm test -w server -- -t 'refuses when the snapshot is behind'
```

There is no linter or formatter configured. `npm run typecheck` and the tests are the whole gate.

## Spectra is the tool; the consumer project is separate

This repo is **Spectra** — the spec tool (`shared/`, `server/`, `web/`): a glossary of Terms in
`specs/*.json`, edited only through structured changesets, plus a chat dock running two agents.
`specs/` here is the example glossary the tool operates on.

There used to be a second half in `app/` — a ToDo app written *from* `specs/terms/`, the output
side of the loop. It has been **sidelined** to the `backup/todo-app` branch (a full snapshot,
incl. `app/`), because Spectra ships as the tool and the *consumer project it implements into is
a separate thing* — kept elsewhere, or external. The removal was clean because `app/` was
standalone-by-construction (its own `node_modules`/`tsconfig`, never an npm workspace).

### The consumer project (currently unconfigured — blocker E)

`@coder`'s working directory and only sandbox mount were `app/`. With `app/` gone, **the
sandboxed `@coder` has no project to point at**: `npm run dev:sandbox` runs, but a coder turn
targets `APP_DIR` (`server/src/agent/agents.ts`) / the `./app:/work/app` mount in
`docker-compose.yml`, which no longer exist — and `docker compose up` will create an empty
`./app` on the host. Running `@coder` is therefore inert until the project target is made
configurable. That work — pointing the coder at a chosen project, and where the drift check
lives — is the deferred **blocker E** ("drift-check fork"); the rest of the tool (glossary,
changesets, `@spec`, MCP, version guard) is unaffected and its tests pass.

The design principle to preserve when that project is wired back: the consumer project stays
**standalone** — its own `node_modules`/`tsconfig`, buildable in a bare copy — which is what
lets the sandbox mount it and nothing else. Do not fold it into the root workspaces. It has
never heard of `specs/` at runtime; the only link is a human or `@coder` editing it to match.

## The write path, and why it is shaped this way

The glossary is only ever written by the server, through `commit.ts`. Three rules hold it up,
and each is enforced by construction rather than by a prompt asking nicely:

- **Changesets only.** No direct term editor exists in the UI, and `@spec` has `builtins: []`
  — no filesystem tools at all, so it *cannot* bypass the rule.
- **Which tools each agent gets is decided server-side**, in `server/src/agent/agents.ts`.
  That file is the single definition of who `@spec` and `@coder` are: prompt, builtins,
  auto-approvals, tool list. The sandboxed container fetches it from `/mcp/coder/profile` at
  the start of every run rather than carrying its own copy, so an attacker inside the box
  cannot edit the definition that decides.
- **Written files match the hand-authored format** — fixed key order, one line per attribute
  (`serializeTerm` in `commit.ts`). Break this and every applied changeset reformats the files
  it touches and buries the real diff.

`server/src/store.ts` is the only module that reads the filesystem, and every read goes back to
disk — the files are the source of truth and may have been hand-edited between two requests.
A file that fails to parse becomes a `problem` in the response, never an exception.

The changeset engine lives in `shared/`, not the server, because the web app uses it to
*preview* what a changeset would do and the server uses the identical code to *commit*. One
set of rules, so the preview cannot disagree with the result.

## The snapshot and the version check

The *protocol* below lives in the tool (`server/src/specsExport.ts`, `GET /api/specs/version`,
`mark_implemented`) and is unaffected by the app removal. The two concrete files it names —
`specs.snapshot.json` and `implements.test.ts` — lived in the sidelined `app/` (still on
`backup/todo-app`) and move with the consumer project when it is wired back (blocker E). The
snapshot fallback path (`server/src/specsExport.ts`, `APP_SNAPSHOT`) now points at an absent
file and degrades to "no readable snapshot" rather than crashing. Read the rest as describing
how the guard works against *whatever* project holds the snapshot.

`specs.snapshot.json` is the glossary contract as a committed file — names, kinds, and a hash of
each term's spec/parent/attributes. The project's `implements.test.ts` checks the
`// implements: termName` markers against it, which is what makes the drift check work both in a
bare copy of the project and inside a sandbox that cannot see `specs/`.

The staleness guard is modelled on `git push`:

| git | here |
|---|---|
| remote `HEAD` | `specsVersion` — what `specs/` is at now |
| local ref | `version` inside the committed snapshot |
| `git fetch` | `export_specs`, then writing the file |
| non-fast-forward reject | `mark_implemented` refused on mismatch |

Consequences worth knowing before touching any of it:

- **The snapshot has no timestamp, on purpose.** It is a pure function of the specs, so
  re-exporting when nothing changed leaves it byte-identical. Adding a `generatedAt` would
  dirty it every export and bury the signal.
- **Reads are never refused, only `mark_implemented`.** Reading current specs while holding an
  old snapshot is harmless and often the point.
- **The refusal names versions, never a path.** The spec tool must not know where the
  implementer keeps its code — `app/specs.snapshot.json` is this repo's arrangement, not part
  of the protocol.
- **No version argument and no `force`.** An agent that supplied its own version could export,
  never write the file, and pass on the second try.

Expose versions both sides can compare, not a `stale: true` the server computed. `GET
/api/specs/version` reports both numbers and offers no verdict.

## Sandbox

`docker-compose.yml` puts `spec` on two networks and `coder` on one `internal: true` network
with no route out. `app/` is `coder`'s only mount. The container reaches the model through
express's `/anthropic` proxy and the glossary through `/mcp/coder`, and holds the literal
string `proxied-by-the-spec-tool` instead of a credential.

- The `/anthropic` proxy is mounted **before `express.json()`** in `server/src/index.ts`, and
  that ordering is load-bearing — a JSON parser upstream would consume the body stream.
- `/mcp` is deliberately outside `/api`: it is the sandbox's surface, not the UI's.
- **Port 5174 collides silently.** Docker publishes by DNAT, so a host server already on 5174
  wins with no bind conflict to notice. The tell is `GET /api/sandbox` reporting
  `configured: false`. Run `npm run dev:sandbox`, not `npm run dev`, with the containers up.
- **Switching between `docker-compose.yml` and `docker-compose.open.yml` recreates the
  network**, and a merely *restarted* container comes back without its DNS aliases — `spec`
  then fails to resolve from `coder`, which looks exactly like the service being down. Use
  `docker compose down` before switching, never `restart`.
- **There is no unsandboxed fallback.** If `CODER_URL` is set and the container is down, the
  turn does not run. An *unset* `CODER_URL` is the different, deliberate choice that plain
  `npm run dev` makes.
- **For `Bash` the SDK classifies the command itself** and lets ones it judges read-only
  through without an approval card. The card covers commands that *change* things — do not
  write prompts or docs claiming every command is shown.

## Agent-SDK traps already paid for

- **Credentials are not interchangeable.** `sk-ant-api…` → `ANTHROPIC_API_KEY`;
  `sk-ant-oat…` (from `claude setup-token`) → `CLAUDE_CODE_OAUTH_TOKEN`. The wrong pairing
  loads fine, reports "agent ready", then fails every call with `Invalid API key`. The server
  checks the prefix on boot.
- **Deeply nested zod defeats the SDK's JSON-Schema conversion, silently** — and takes down
  the *entire* MCP server, so the agent reports having no tools at all with nothing in any
  log. Tool boundaries use flat op shapes with an enum tag; the real schema validates before
  anything reaches disk. Do not reuse `shared/`'s discriminated unions in a tool signature.
- **`settingSources: []` is deliberate.** Without it the SDK inherits the machine's Claude Code
  settings and the agents pick up whatever MCP servers the user has configured globally.
- **A tool named bare in `allowedTools` never reaches the permission callback**, so listing a
  write there silently disables its approval card.
- **zod versions differ on purpose**: `shared/` is on zod 3, `server/` on zod 4 (what the SDK
  needs). The compose file mounts `/stack/server/node_modules` from the image for exactly this
  reason — do not let a host `node_modules` shadow it.

## Conventions

- **Every file opens with a doc comment explaining *why*, not what.** This is the dominant
  style in the repo and it carries real decisions — read it before editing, and extend it
  rather than stripping it.
- **`app/src/domain/*.ts` quote the spec text they implement** in the header comment, and cite
  the question id that settled any ambiguity (`q-002`, `q-004`). Keep doing this; it is what
  makes a spec change traceable to the code that needs updating.
- **`// implements: termName`** — comma-separated bare identifiers, nothing else. Trailing
  prose fails `implements.test.ts`; put it on the next line.
- Term filenames are kebab-cased from the term name (`RecurringTask` → `recurring-task.json`),
  via `termFileName` in `commit.ts`.
- **Questions, not findings.** If something an implementation pass discovers cannot be phrased
  as a question a human answers, it does not belong in `specs/questions/`. A question's
  `because` must quote the spec text in conflict — "this was awkward to implement" is not
  grounds to change a spec.
- Answers are written back into the question file and are not editable. Change a decision by
  raising a new question.

## Where things live

```
specs/terms/*.json            source of truth, hand-editable
specs/changesets/             pending; applied/ and rejected/ are the history
specs/questions/              what the glossary does not settle, and what was decided
shared/src/                   the engine — types, valueType grammar, backlinks, conflicts, changeset ops
server/src/agent/agents.ts    the single definition of who @spec and @coder are
server/src/agent/runner.ts    runs a turn, streams it, blocks on approvals
server/src/agent/tools.ts     domain tools; mcpHttp.ts is the same tools over HTTP
server/src/specsExport.ts     the snapshot + version (README calls this glossaryExport.ts)
server/src/commit.ts          the only writer of specs/
server/src/specStore.ts       the storage seam (FileSystemSpecStore today, SqlSpecStore next)
coder/src/main.ts             the sandboxed half of @coder (target project unconfigured — blocker E)
data/transcripts.db           chat history — gitignored, prunable, never the record
```

The consumer project (`app/`, holding `specs.snapshot.json` and the `implements` drift check)
was sidelined to the `backup/todo-app` branch — see "Spectra is the tool" above.

Ports: **5173** spec tool UI, **5174** its API (serves no HTML — a 404 in the browser is
correct), **5177** the coder container. (5175 was the ToDo app's dev server, now on
`backup/todo-app`.)

Re-running the implementation pass is not a command. It is a directed ask: point at
`specs/terms/` and update the consumer project to match, using the `// implements:` markers to
target it — inert until that project is configured (blocker E).
