# Integration tests

End-to-end tests of the **install-and-use** flow: the real `spectra` bin, a throwaway HOME/XDG,
and a throwaway repo — asserting what a user actually sees (`init` writes the link into the repo
and the glossary *outside* it, `up` auto-discovers its compose files, errors exit non-zero).

`run.sh` touches nothing outside a `mktemp` dir, so it runs the same two ways:

```bash
# On the host — fast, no docker. Also wired as an npm script:
npm run test:integration          # == bash test/integration/run.sh

# In a clean container — fresh OS, fresh HOME, none of your state:
npm run test:integration:docker   # builds test/integration/Dockerfile, runs it
```

The bin under test defaults to `node_modules/.bin/spectra`; override with `SPECTRA_BIN=/path/to/spectra`
(e.g. to test a real install once the `curl|bash` bootstrap exists).

## What this tier does and does not cover

It covers install + CLI behavior: the bin runs, `init` lays out the three homes correctly, and the
compose commands translate right (checked via `--dry-run`, so no docker daemon is needed — this runs
in plain CI).

It does **not** boot the stack — that is `stack.sh` below.

## Full-stack e2e (`stack.sh`)

```bash
npm run test:integration:stack    # builds the images, boots spec + web, asserts, tears down
```

This is the tier where the **containers actually execute**. It builds from `docker-compose.yml`
(local `context: .`, so it does not need the repo public / the git build context), boots `spec` +
`web`, and asserts the running stack serves: `spec` answers `/api` directly, `web` serves the SPA,
`/api` is proxied through nginx to `spec` (with terms coming back), and SPA deep-links fall back to
`index.html`. It needs a **Docker daemon** and tears the stack down on exit.

Credential-free: the read API serves with an empty `ANTHROPIC_API_KEY` (the agent is only needed to
run a chat turn), so this runs in CI with no secret. `@coder` is not started — it is inert until a
project is configured, and skipping it avoids the stray `./app` the compose would otherwise create.

Note the readiness wait uses `curl --retry-all-errors`: docker publishes the port before the server
inside is listening, so a plain `--retry-connrefused` would give up on the first empty reply.

## Install e2e (`Dockerfile.install` + `installed.sh`)

```bash
npm run test:install:docker   # runs install.sh in a clean container, then the installed bin
```

Proves the real `curl | bash` install path: `install.sh` builds the single-file CLI bundle, drops
it at `~/.local/bin/spectra`, and scaffolds `~/.config/spectra`; then `installed.sh` runs the
**installed** bin (no repo, no `node_modules` beside it) — it is on PATH, `init` links a repo, and
`up` auto-discovers the *installed* `default.yaml`. Uses `SPECTRA_SRC=/src` so it installs from the
copied checkout with no network fetch.
