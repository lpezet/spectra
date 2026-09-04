#!/usr/bin/env bash
#
# Exercises the INSTALLED CLI — the bin install.sh dropped into ~/.local/bin, not the workspace bin.
# Run inside test/integration/Dockerfile.install after install.sh has run. Proves the real install
# path: the bundle runs on plain node with no repo around it, and auto-discovery finds the
# default.yaml install.sh scaffolded into the config dir.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/spectra"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n     %s\n' "$1" "${2:-}"; exit 1; }

echo "spectra installed-CLI test"

command -v spectra >/dev/null || fail "on PATH" "spectra not found under ~/.local/bin"
pass "spectra is on PATH ($(spectra --version))"

[ -f "$CONFIG_DIR/default.yaml" ] || fail "config scaffold" "default.yaml not in $CONFIG_DIR"
pass "default.yaml scaffolded in the config dir"

# The bundle is self-contained: it runs with no repo and no node_modules beside it.
REPO="$(mktemp -d)/proj"
mkdir -p "$REPO"
( cd "$REPO" && spectra init --name Demo --domain widgets >/dev/null ) || fail "init" "spectra init failed"
[ -f "$REPO/.spectra/config.json" ] || fail "init" "no .spectra/config.json written"
pass "spectra init links a fresh repo"

# Auto-discovery must use the INSTALLED default.yaml (there is no repo default.yaml here).
OUT="$( cd "$REPO" && spectra up --dry-run )"
echo "$OUT" | grep -q -- "-f $CONFIG_DIR/default.yaml" || fail "discovery base" "installed default.yaml not used: $OUT"
echo "$OUT" | grep -q -- 'projects/.*/compose.yaml' || fail "discovery override" "$OUT"
pass "spectra up auto-discovers the installed default.yaml + project override"

echo
echo "ALL PASS"
