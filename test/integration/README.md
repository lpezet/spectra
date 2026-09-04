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

It does **not** boot the stack. `spectra up` for real calls `docker compose up`, which needs a
daemon *inside* the test. Building the images (from the pinned git context) and curling the running
web UI is a heavier **docker-in-docker** tier, tracked separately — that is the first place the
containers actually execute.
