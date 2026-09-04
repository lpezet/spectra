#!/usr/bin/env bash
#
# Integration test for the install-and-use flow, in a fully isolated environment.
#
# It runs the real `spectra` bin against a throwaway HOME/XDG and a throwaway repo, and asserts
# the outcomes a user actually sees: the bin runs, `init` writes the link into the repo and the
# glossary OUTSIDE it (server-side, under the data home), and `up` auto-discovers the base +
# override with no -f. It touches nothing outside a mktemp dir, so it is safe to run anywhere —
# on the host (this is what `npm run test:integration` does) or inside the clean container in
# test/integration/Dockerfile.
#
# It deliberately does NOT boot the stack: `spectra up` would call `docker compose`, which needs a
# daemon inside the test. That full-stack e2e (build the images, curl the web UI) is a heavier
# docker-in-docker tier, tracked separately. This tier is the one that runs in plain CI.
#
# Every command goes through --dry-run where it would otherwise reach docker, so the assertions
# check the *translation* a real run would perform.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPECTRA="${SPECTRA_BIN:-$REPO_ROOT/node_modules/.bin/spectra}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
mkdir -p "$HOME"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n     %s\n' "$1" "${2:-}"; exit 1; }

echo "spectra integration test"
echo "  bin:  $SPECTRA"
echo "  home: $HOME"
echo

# 1. The bin runs and reports a version.
"$SPECTRA" --version | grep -qE '^[0-9]+\.' || fail "spectra --version" "did not print a version"
pass "spectra --version"

# 2. --help lists the commands.
"$SPECTRA" --help | grep -q 'docker compose' || fail "spectra --help" "help text missing"
pass "spectra --help"

# 3. init links a fresh repo.
REPO="$WORK/myproj"
mkdir -p "$REPO"
( cd "$REPO" && "$SPECTRA" init --name "Demo" --domain "a demo app" >/dev/null ) || fail "spectra init" "exited non-zero"

[ -f "$REPO/.spectra/config.json" ] || fail "init: the link" ".spectra/config.json not written"
grep -q '"name": "Demo"' "$REPO/.spectra/config.json" || fail "init: the link" "name not in link"
pass "init writes .spectra/config.json (the link) into the repo"

# The glossary is the Server's — it must NOT be in the repo.
[ ! -e "$REPO/specs" ] || fail "init: glossary placement" "specs/ must not be in the repo"
GLOSSARY="$(find "$XDG_DATA_HOME/spectra/projects" -name project.json 2>/dev/null | head -1)"
[ -n "$GLOSSARY" ] || fail "init: glossary" "server-side project.json not written under the data home"
grep -q '"name": "Demo"' "$GLOSSARY" || fail "init: glossary identity" "name not seeded into glossary"
pass "init seeds the glossary server-side (under the data home, not the repo)"

# The override compose lives under the config home.
OVERRIDE="$(find "$XDG_CONFIG_HOME/spectra/projects" -name compose.yaml 2>/dev/null | head -1)"
[ -n "$OVERRIDE" ] || fail "init: override" "override compose.yaml not written under the config home"
grep -q '/work/project' "$OVERRIDE" || fail "init: override" "coder mount missing from override"
pass "init writes the per-project compose override under the config home"

# 4. auto-discovery: `up` from the repo needs no -f, and layers base + override.
OUT="$( cd "$REPO" && "$SPECTRA" up --dry-run )"
echo "$OUT" | grep -q -- '-f .*default.yaml' || fail "up: discovery base" "$OUT"
echo "$OUT" | grep -q -- "-f $OVERRIDE" || fail "up: discovery override" "$OUT"
echo "$OUT" | grep -q 'up -d' || fail "up: subcommand" "$OUT"
pass "up auto-discovers default.yaml + the project override"

# 5. auto-discovery works from a nested subdir (walk-up).
SUB="$REPO/services/api"
mkdir -p "$SUB"
( cd "$SUB" && "$SPECTRA" server logs --dry-run ) | grep -q -- "-f $OVERRIDE" || fail "walk-up" "override not found from a subdir"
pass "commands find the project from a nested subdir"

# 6. explicit --compose-file wins over discovery.
( cd "$REPO" && "$SPECTRA" up --compose-file /tmp/x.yml --dry-run ) | grep -q -- '-f /tmp/x.yml' || fail "explicit override" "--compose-file ignored"
pass "explicit --compose-file wins over discovery"

# 7. errors exit non-zero and name the problem.
if ( cd "$REPO" && "$SPECTRA" server fly >/dev/null 2>&1 ); then fail "error exit" "unknown verb should fail"; fi
pass "an unknown command exits non-zero"

echo
echo "ALL PASS"
