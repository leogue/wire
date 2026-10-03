#!/bin/sh
# Installs wire, or updates it: curl -fsSL https://raw.githubusercontent.com/OWNER/wire/main/install.sh | sh
#
# WIRE_REPO  the git repository to install from
# WIRE_HOME  where wire lives (default ~/.wire)
# WIRE_BIN   where the `wire` command goes (default ~/.local/bin)
set -eu

REPO="${WIRE_REPO:-https://github.com/OWNER/wire.git}"
HOME_DIR="${WIRE_HOME:-$HOME/.wire}"
BIN_DIR="${WIRE_BIN:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'wire: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "Node.js 24 or later is required: https://nodejs.org"
NODE_MAJOR=$(node -p 'parseInt(process.versions.node)')
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js 24 or later is required (found $(node -v)): https://nodejs.org"

if [ -d "$HOME_DIR/.git" ]; then
  say "Updating wire in $HOME_DIR"
  git -C "$HOME_DIR" pull --ff-only --quiet
else
  [ -e "$HOME_DIR" ] && fail "$HOME_DIR exists and is not a wire installation: set WIRE_HOME"
  say "Installing wire in $HOME_DIR"
  git clone --quiet --depth 1 "$REPO" "$HOME_DIR"
fi
(cd "$HOME_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

mkdir -p "$BIN_DIR"
chmod +x "$HOME_DIR/packages/agent/src/main.ts"
ln -sf "$HOME_DIR/packages/agent/src/main.ts" "$BIN_DIR/wire"
say "Installed: $BIN_DIR/wire"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "" && say "Add $BIN_DIR to your PATH, e.g. in ~/.zshrc or ~/.bashrc:" && say "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# Not needed to install, but by the agent: say what is missing.
MISSING=""
if ! command -v kicad-cli >/dev/null 2>&1 && [ ! -x /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli ]; then
  MISSING="$MISSING\n  KiCad 10 (rendering, export, symbols): https://www.kicad.org/download/"
fi
if ! command -v pdftoppm >/dev/null 2>&1; then
  MISSING="$MISSING\n  poppler (datasheets, PNG pages): brew install poppler, or apt install poppler-utils"
fi
[ -n "$MISSING" ] && printf '\nStill needed:%b\n' "$MISSING"

say ""
say "Start a design:  mkdir my-board && cd my-board && wire"
say "Web search: put EXA_API_KEY=... in $HOME_DIR/.env"
