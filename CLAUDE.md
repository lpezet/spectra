# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` is long and carries the reasoning behind most of what follows. Read the relevant
section of it before changing anything structural — nearly every design choice here has a
stated "and here is why the obvious alternative is wrong" attached.

## Commands

```bash
npm install                    # root workspaces (packages/core, packages/server, packages/web)

npm run dev                    # spec tool, unsandboxed: express :5174 + vite :5173
npm run dev:sandbox            # same, with express and @coder in containers + vite on host
                               #   @coder has no project to point at yet — see "The consumer project" below

npm test                       # unit: core, server, web, cli (each a separate vitest run)
npm run typecheck              # tsc across core, server, web, cli

npm run test:integration       # e2e: the spectra bin in a throwaway HOME (install + init + up)
npm run test:integration:docker#   the same, in a clean container (test/integration/)

npm run sandbox:logs           # docker compose logs -f
npm run sandbox:down           # docker compose down
```

Single test file / single test name (vitest per workspace, so target the workspace first):

```bash
npm test -w @spectra/core -- src/changeset.test.ts
npm test -w @spectra/server -- -t 'refuses when the snapshot is behind'
```

There is no linter or formatter configured. `npm run typecheck` and the tests are the whole gate.

## Spectra is the tool; the consumer project is separate

This repo is **Spectra** — the spec tool (`packages/core`, `packages/server`, `packages/web`): a
glossary of Terms in `specs/*.json`, edited only through structured changesets, plus a chat dock
running two agents.

**The engine ships empty** — like a database with no data, it carries no glossary of its own.
The ToDo glossary this repo grew up around now lives at `examples/todo/specs/` as a *sample to
point at*, not content baked into the tool. `npm run dev` sets `SPECS_DIR` to it; run the server
with `SPECS_DIR` unset and it operates on an empty glossary (the default is a gitignored
`.dev/specs` scratch dir). A configured install will supply the path later, via the CLI/link
layer.

There used to be a second half in `app/` — a ToDo app written *from* `specs/terms/`, the output
side of the loop. It has been **sidelined** to the `backup/todo-app` branch (a full snapshot,
incl. `app/`), because Spectra ships as the tool and the *consumer project it implements into is
a separate thing* — kept elsewhere, or external. The removal was clean because `app/` was
standalone-by-construction (its own `node_modules`/`tsconfig`, never an npm workspace).

### The consumer project (configurable target — blocker E, part 1 done)

`@coder`'s working directory and only mount is the project it implements into, at
**`/work/project`** in the container (`APP_DIR` in `packages/coder/src/main.ts`, overridable).
An installed run gets the repo mounted there by `spectra init`; this dev `docker-compose.yml`
has no consumer project, so it mounts a placeholder `./app` at `/work/project` and `@coder` is
**inert in dev** until a real project is configured (a bare `docker compose up` still creates an
empty `./app` on the host). The in-process (unsandboxed) coder's cwd is `APP_DIR` in
`packages/server/src/agent/agents.ts` (`CODER_DIR` env, default `<repo>/app`).

What remains of **blocker E** is the *drift check* ("drift-check fork") — the `specs.snapshot.json`
+ `implements.test.ts` that lived in `app/`. `@coder` still reads a snapshot at
`APP_DIR/specs.snapshot.json` and degrades to "no snapshot" when absent; where that check finally
lives is tied to the store-version-query direction (a live query may replace the snapshot). The
rest of the tool (glossary, changesets, `@spec`, MCP, version guard) is unaffected and its tests pass.

The design principle to preserve when that project is wired back: the consumer project stays
**standalone** — its own `node_modules`/`tsconfig`, buildable in a bare copy — which is what
lets the sandbox mount it and nothing else. Do not fold it into the root workspaces. It has
never heard of `specs/` at runtime; the only link is a human or `@coder` editing it to match.

## The write path, and why it is shaped this way

The glossary is only ever written by the server, through `commit.ts`. Three rules hold it up,
and each is enforced by construction rather than by a prompt asking nicely:

- **Changesets only.** No direct term editor exists in the UI, and `@spec` has `builtins: []`
  — no filesystem tools at all, so it *cannot* bypass the rule.
- **Which tools each agent gets is decided server-side**, in `packages/server/src/agent/agents.ts`.
  That file is the single definition of who `@spec` and `@coder` are: prompt, builtins,
  auto-approvals, tool list. The sandboxed container fetches it from `/mcp/coder/profile` at
  the start of every run rather than carrying its own copy, so an attacker inside the box
  cannot edit the definition that decides.
- **Written files match the hand-authored format** — fixed key order, one line per attribute
  (`serializeTerm` in `commit.ts`). Break this and every applied changeset reformats the files
  it touches and buries the real diff.

`packages/server/src/store.ts` is the only module that reads the filesystem, and every read goes back to
disk — the files are the source of truth and may have been hand-edited between two requests.
A file that fails to parse becomes a `problem` in the response, never an exception.

The changeset engine lives in `shared/`, not the server, because the web app uses it to
*preview* what a changeset would do and the server uses the identical code to *commit*. One
set of rules, so the preview cannot disagree with the result.

## The snapshot and the version check

The *protocol* below lives in the tool (`packages/server/src/specsExport.ts`, `GET /api/specs/version`,
`mark_implemented`) and is unaffected by the app removal. The two concrete files it names —
`specs.snapshot.json` and `implements.test.ts` — lived in the sidelined `app/` (still on
`backup/todo-app`) and move with the consumer project when it is wired back (blocker E). The
snapshot fallback path (`packages/server/src/specsExport.ts`, `APP_SNAPSHOT`) now points at an absent
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
with no route out. The project at `/work/project` is `coder`'s only mount. The container reaches
the model through express's `/anthropic` proxy and the glossary through `/mcp/coder`, and holds
the literal string `proxied-by-the-spec-tool` instead of a credential.

- The `/anthropic` proxy is mounted **before `express.json()`** in `packages/server/src/index.ts`, and
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

Code lives under `packages/` (`core`, `server`, `web`, `coder`); `core`/`server`/`web` are
npm workspaces under the `@spectra/*` scope, `coder` is standalone (its own lockfile, the
sandbox image builds from it). The engine ships with **no glossary** — the example one lives
under `examples/todo/specs/`. Neither the glossary nor runtime data defaults into the source
tree: an unconfigured run reads specs from a gitignored `.dev/specs` and writes data under the
XDG data home (`~/.local/share/spectra`). `npm run dev` overrides both to `examples/todo/specs`
and a gitignored `.dev/` scratch dir.

```
examples/todo/specs/terms/*.json      source of truth, hand-editable (the example glossary)
examples/todo/specs/project.json      the glossary's identity (name, domain) — via SpecStore.projectInfo()
examples/todo/specs/changesets/       pending; applied/ and rejected/ are the history
examples/todo/specs/questions/        what the glossary does not settle, and what was decided
packages/core/src/                    the engine — types, valueType grammar, backlinks, conflicts, changeset ops
packages/server/src/agent/agents.ts   the single definition of who @spec and @coder are
packages/server/src/agent/runner.ts   runs a turn, streams it, blocks on approvals
packages/server/src/agent/tools.ts    domain tools; mcpHttp.ts is the same tools over HTTP
packages/server/src/specsExport.ts    the snapshot + version (README calls this glossaryExport.ts)
packages/server/src/commit.ts         the only writer of specs/
packages/server/src/specStore.ts      the storage seam; both backends scope to one project
packages/server/src/fileSystemSpecStore.ts  FS backend — (root, projectId) → <root>/<project_id>/specs
packages/server/src/sqlSpecStore.ts   SQL backend (node:sqlite) — (db, projectId), one DB many projects
packages/server/src/storeFactory.ts   picks the backend from config (SPEC_STORE=fs|sql) at the root
packages/coder/src/main.ts            the sandboxed half of @coder (target project unconfigured — blocker E)
packages/cli/src/commands.ts          the CLI grammar: argv -> docker compose argv (pure, tested)
packages/cli/src/cli.ts               the CLI entry — resolves the compose file, shells out to docker
~/.local/share/spectra/transcripts.db chat history — XDG data home (dev: .dev/data); prunable, never the record
```

The consumer project (`app/`, holding `specs.snapshot.json` and the `implements` drift check)
was sidelined to the `backup/todo-app` branch — see "Spectra is the tool" above.

Ports: **5173** spec tool UI — Vite in dev, or the `web` container (nginx, `Dockerfile.web`)
in the containerized/installed path; **5174** its API (serves no HTML — a 404 in the browser
is correct), **5177** the coder container. (5175 was the ToDo app's dev server, now on
`backup/todo-app`.)

The three pieces each have a container: `Dockerfile.spec` (server), `Dockerfile.coder`
(sandbox), `Dockerfile.web` (nginx serving the built UI, proxying `/api` to `spec`). The `web`
service is behind a compose **profile** so plain `docker compose up` (what `dev:sandbox` runs)
leaves it out and its 5173 does not collide with host Vite — start it explicitly with
`docker compose up web`.

There are two compose files. `docker-compose.yml` is the **contributors'** file — services build
from the working tree (`context: .`). `default.yaml` is the **distribution** file — services build
from a *remote git context pinned to a release* (`context: github…#${SPECTRA_REF}`), so an install
needs neither a clone nor a registry, just this file (this is SAL's model: a compose template
fetched from a pinned release, used verbatim). `default.yaml` is only the shared *base*: the
project-specific bits — `SPECS_DIR`, data persistence, and @coder's mount — come from a per-project
override that `spectra init` writes, layered with `-f default.yaml -f <project>.yaml`. Keep the two
files in structural sync; they differ only in build context and in that the project mounts live in
the override.

`packages/cli` (`@spectra/cli`) wraps this compose. Two shapes: per-component
`spectra <server|coder|web> up|down|restart|status|logs`, and whole-stack `spectra up|down|build [component]`.
Each maps to the matching `docker compose` call — `server` → the `spec` service, and anything
touching `web` carries `--profile web`. Verbs are up/down (not start/stop) to match compose; per-component
`down` is `rm -sf <svc>` (that one service), whole-stack `down` is the project teardown. There is no
`install`: `up` builds a missing image on its own, and `build` is only for pre-build/rebuild.
`--compose-file` repeats to layer a base and an override (`-f default.yaml -f <project>.yaml`) — the
seam `spectra init` uses. The argv→compose translation is a pure function (`commands.ts`), fully
tested without a docker daemon; `--dry-run` prints the command it would run.

`spectra init --name … --domain …` links a repo to a project (`init.ts`, pure `planInit`). It writes
three things in three places, per the corrected model above: `.spectra/config.json` in the repo (the
*link* — project id + identity + optional Server URL), the **server-side** glossary's `project.json`
under the XDG data home (`~/.local/share/spectra/projects/<id>/specs/` — the glossary is the Server's,
never the repo), and a per-project compose override under `~/.config/spectra/projects/<id>/` (mounts
that glossary + data into `spec`, and the repo — `--dir` for a subdir — into `coder` at `/work/project`).
Projects are keyed by **id**, not folder path. `--name`/`--domain` default to the repo folder name.

Compose-file resolution (`discovery.ts`, pure `resolveComposeFiles`) then makes `spectra up` inside an
inited repo need no `-f`: explicit `--compose-file` flags win, else `SPECTRA_COMPOSE_FILE`, else it
walks up for `.spectra/config.json` and layers `default.yaml` + that project's override, else falls
back to the repo's `docker-compose.yml` (the contributors' file). One follow-up remains on this path:
@coder's container actually *using* `/work/project` (the rest of blocker E — the mount is wired, the
coder code still targets the old `APP_DIR`).

Distribution (like SAL: build in CI, download prebuilt in the installer):
- `npm run build -w @spectra/cli` (`scripts/build.mjs`) esbuild-bundles the CLI to a single
  dependency-free `packages/cli/dist/cli.mjs` that runs on plain `node` (version inlined via a
  `define`; no `tsx` at runtime). `dist/` is gitignored.
- `.github/workflows/release.yml` runs that build on a `v*` tag and attaches the bundle (as
  `spectra`), `default.yaml`, and `SHASUMS256.txt` to the GitHub release.
- `install.sh` (repo root) **downloads** those release assets (checksum-verified), installs the bin
  at `~/.local/bin/spectra`, and scaffolds `~/.config/spectra/default.yaml` — which is why discovery
  prefers the installed `default.yaml`. It never clones or builds; `SPECTRA_ASSETS=<dir>` installs
  from local prebuilt assets instead of downloading (the test path).

Run in dev without installing via `npm run spectra -w @spectra/cli -- up`. `npm run
test:install:docker` builds the assets once (a builder stage, as CI does) then installs and
exercises the prebuilt bin. The download path itself needs a published release (push a `v*` tag).

Re-running the implementation pass is not a command. It is a directed ask: point at
`specs/terms/` and update the consumer project to match, using the `// implements:` markers to
target it — inert until that project is configured (blocker E).
