#!/usr/bin/env bash
#
# Install the Spectra CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/lpezet/spectra/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- v0.1.0        # pin a ref
#
# It fetches the repo at a ref, builds the CLI into a single self-contained file (no node_modules,
# no tsx), drops it at ~/.local/bin/spectra, and scaffolds ~/.config/spectra with the distribution
# compose (default.yaml). The running stack still needs Docker; the CLI itself needs only node.
#
# Env: SPECTRA_REF (ref to install, or the first arg), SPECTRA_PREFIX (default ~/.local),
# XDG_CONFIG_HOME, and SPECTRA_SRC (use an existing checkout instead of fetching — used by tests).
set -euo pipefail

REF="${SPECTRA_REF:-${1:-main}}"
REPO_URL="https://github.com/lpezet/spectra"
PREFIX="${SPECTRA_PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/spectra"

need() { command -v "$1" >/dev/null 2>&1 || { echo "spectra install needs '$1' on PATH." >&2; exit 1; }; }
need node
need npm

CLEAN=""
cleanup() { [ -n "$CLEAN" ] && rm -rf "$CLEAN"; return 0; }  # return 0: an empty CLEAN must not fail the script
trap cleanup EXIT

if [ -n "${SPECTRA_SRC:-}" ]; then
  SRC="$SPECTRA_SRC"
  echo "Using local source at $SRC"
else
  CLEAN="$(mktemp -d)"
  echo "Fetching spectra@$REF…"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$CLEAN/spectra" >/dev/null 2>&1 \
      || git clone --depth 1 "$REPO_URL" "$CLEAN/spectra" >/dev/null 2>&1
  else
    need curl
    need tar
    curl -fsSL "$REPO_URL/archive/$REF.tar.gz" | tar -xz -C "$CLEAN"
    mv "$CLEAN"/spectra-* "$CLEAN/spectra"
  fi
  SRC="$CLEAN/spectra"
fi

echo "Building the CLI…"
( cd "$SRC" && npm ci >/dev/null 2>&1 && npm run build -w @spectra/cli >/dev/null )

echo "Installing…"
mkdir -p "$BIN_DIR" "$CONFIG_DIR"
install -m 0755 "$SRC/packages/cli/dist/cli.mjs" "$BIN_DIR/spectra"
cp "$SRC/default.yaml" "$CONFIG_DIR/default.yaml"

echo
echo "Installed: $BIN_DIR/spectra ($("$BIN_DIR/spectra" --version))"
echo "Config:    $CONFIG_DIR/default.yaml"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "Add $BIN_DIR to your PATH:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
echo
echo "Next:  cd your-project && spectra init && spectra up   (needs Docker running)"
