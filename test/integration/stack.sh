#!/usr/bin/env bash
#
# Full-stack e2e: build the images, boot spec + web via compose, and assert the running stack
# actually serves — the web UI, and /api proxied through nginx to spec. Tears down on exit.
#
# Unlike run.sh (which --dry-runs every docker-bound command), this one needs a Docker daemon:
# it is the tier where the containers actually execute. It builds from docker-compose.yml (local
# context, `context: .`), so it does not depend on the repo being public / the git build context.
#
# Credential-free on purpose: the server serves the read API with an empty ANTHROPIC_API_KEY — the
# agent is only needed to run a chat turn, not to browse the glossary — so this runs in CI with no
# secret. @coder is not started (it is inert until a project is configured), which also avoids the
# stray ./app the compose would otherwise create.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
COMPOSE=(docker compose -f docker-compose.yml --profile web)

cleanup() { "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n     %s\n' "$1" "${2:-}"; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

echo "spectra full-stack e2e (docker compose)"
echo "  building + starting spec + web…"
export ANTHROPIC_API_KEY="" CLAUDE_CODE_OAUTH_TOKEN=""
"${COMPOSE[@]}" up -d --build spec web >/dev/null 2>&1 || fail "compose up" "the stack did not start"

# The server runs under tsx and takes a few seconds to listen. Docker publishes the port up front,
# so before the server is up curl sees an empty reply / reset, NOT connection-refused — hence
# --retry-all-errors (not just --retry-connrefused), or the retry would give up on the first try.
curl -s --retry 60 --retry-all-errors --retry-connrefused --retry-delay 1 -o /dev/null localhost:5174/api/project \
  || fail "spec readiness" "no /api after ~60s"
pass "stack is up (spec + web built and started)"

# spec serves the API directly.
[ "$(code localhost:5174/api/project)" = 200 ] || fail "spec /api/project" "not HTTP 200"
curl -s localhost:5174/api/project | grep -q '"name"' || fail "spec identity" "no project name in /api/project"
pass "spec serves /api directly"

# web serves the built SPA.
[ "$(code localhost:5173/)" = 200 ] || fail "web /" "not HTTP 200"
curl -s localhost:5173/ | grep -q 'id="root"' || fail "web SPA" "index.html has no #root"
pass "web serves the SPA"

# The load-bearing assertion: /api proxied through nginx to spec on the compose network.
curl -s localhost:5173/api/project | grep -q '"name"' || fail "nginx proxy" "/api not proxied to spec"
TERMS=$(curl -s localhost:5173/api/terms | grep -oE '"name":"[a-zA-Z]+"' | wc -l)
[ "$TERMS" -gt 0 ] || fail "proxy /api/terms" "no terms returned through the proxy"
pass "web proxies /api to spec ($TERMS terms via nginx)"

# SPA deep-links fall back to index.html (nginx try_files), so client routing works on refresh.
[ "$(code localhost:5173/any/client/route)" = 200 ] || fail "SPA fallback" "deep link not 200"
pass "SPA deep-links fall back to index.html"

echo
echo "ALL PASS"
