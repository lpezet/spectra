#!/usr/bin/env bash
#
# Install the Spectra CLI — a single self-contained file downloaded from a GitHub release.
# No clone, no build: it just fetches the prebuilt `spectra` (like SAL's installer). You need
# `node` on PATH to *run* it, and Docker to run the stack — but not to install.
#
#   curl -fsSL https://raw.githubusercontent.com/lpezet/spectra/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- v0.1.0     # pin a release (default: latest)
#
# Env: SPECTRA_REF (release tag or "latest", or the first arg), SPECTRA_PREFIX (default ~/.local),
# XDG_CONFIG_HOME, and SPECTRA_ASSETS (install from a local dir of prebuilt assets instead of
# downloading — used by the install test, and handy for air-gapped installs).
set -euo pipefail

REF="${SPECTRA_REF:-${1:-latest}}"
REPO="lpezet/spectra"
PREFIX="${SPECTRA_PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/spectra"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "${SPECTRA_ASSETS:-}" ]; then
  echo "Installing from local assets at $SPECTRA_ASSETS"
  cp "$SPECTRA_ASSETS/spectra" "$TMP/spectra"
  cp "$SPECTRA_ASSETS/default.yaml" "$TMP/default.yaml"
else
  command -v curl >/dev/null 2>&1 || { echo "spectra install needs 'curl' on PATH." >&2; exit 1; }
  if [ "$REF" = latest ]; then
    BASE="https://github.com/$REPO/releases/latest/download"
  else
    BASE="https://github.com/$REPO/releases/download/$REF"
  fi
  echo "Downloading spectra ($REF)…"
  curl -fsSL "$BASE/spectra" -o "$TMP/spectra" \
    || { echo "Could not download the spectra release for '$REF'. Has that release been published?" >&2; exit 1; }
  curl -fsSL "$BASE/default.yaml" -o "$TMP/default.yaml"
  # Verify the checksum when the release publishes one (it does).
  if curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" 2>/dev/null; then
    ( cd "$TMP" && grep ' spectra$' SHASUMS256.txt | sha256sum -c - >/dev/null ) \
      || { echo "Checksum verification failed for spectra." >&2; exit 1; }
    echo "checksum ok"
  fi
fi

mkdir -p "$BIN_DIR" "$CONFIG_DIR"
install -m 0755 "$TMP/spectra" "$BIN_DIR/spectra"
cp "$TMP/default.yaml" "$CONFIG_DIR/default.yaml"

echo
echo "Installed: $BIN_DIR/spectra"
if command -v node >/dev/null 2>&1; then
  echo "  version $("$BIN_DIR/spectra" --version)"
else
  echo "  (install node to run it)"
fi
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
echo "Next:  cd your-project && spectra init && spectra up   (needs node + Docker)"
