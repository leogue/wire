#!/bin/sh
# Sets up an ASUS Ascent GX10 / NVIDIA DGX Spark (Ubuntu, arm64) for wire and its benchmark:
# Node.js 24+, KiCad 10, poppler, Ollama, wire itself, and the local models declared to pi.
#
#   curl -fsSL https://raw.githubusercontent.com/leogue/wire/gx10-bench/bench/gx10-setup.sh | sh
#   WIRE_MODELS="qwen3.6:35b-a3b qwen3.8:27b" sh bench/gx10-setup.sh
#
# WIRE_BRANCH   the branch of wire to install (default gx10-bench)
# WIRE_MODELS   the Ollama models to pull (default below)
# WIRE_CONTEXT  their context window in tokens (default 131072)
set -eu

BRANCH="${WIRE_BRANCH:-gx10-bench}"
MODELS="${WIRE_MODELS:-qwen3.6:35b-a3b qwen3.8:27b qwen3.5:122b}"
HOME_DIR="${WIRE_HOME:-$HOME/.wire}"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$HOME/.local/node/bin:$PATH"

say() { printf '\n== %s\n' "$*"; }
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

say "System: $(uname -m), $(. /etc/os-release && echo "$PRETTY_NAME")"
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
free -g | head -2

say "Packages: git, curl, poppler"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq git curl xz-utils poppler-utils software-properties-common >/dev/null

say "Node.js 24+"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'parseInt(process.versions.node)')" -lt 24 ]; then
  # No sudo needed: the official arm64 build in ~/.local/node.
  BASE=https://nodejs.org/dist/latest-v24.x
  TARBALL=$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '/linux-arm64.tar.xz$/ {print $2}')
  rm -rf "$HOME/.local/node" && mkdir -p "$HOME/.local/node"
  curl -fsSL "$BASE/$TARBALL" | tar -xJ --strip-components=1 -C "$HOME/.local/node"
fi
node -v

say "KiCad 10"
if ! command -v kicad-cli >/dev/null 2>&1; then
  $SUDO add-apt-repository -y ppa:kicad/kicad-10.0-releases >/dev/null 2>&1 || true
  $SUDO apt-get update -qq
  if apt-cache policy kicad | grep -q 'Candidate: 10\.'; then
    # The program, its symbols and footprints: no 3D models (several GB, not needed for schematics).
    $SUDO apt-get install -y -qq --no-install-recommends kicad kicad-symbols kicad-footprints kicad-templates >/dev/null
  else
    # No arm64 build in the PPA: Flathub's KiCad, behind a kicad-cli wrapper.
    $SUDO apt-get install -y -qq flatpak >/dev/null
    flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
    flatpak install --user -y --noninteractive flathub org.kicad.KiCad
    flatpak override --user --filesystem=home org.kicad.KiCad
    printf '#!/bin/sh\nexec flatpak run --command=kicad-cli org.kicad.KiCad "$@"\n' >"$BIN_DIR/kicad-cli"
    chmod +x "$BIN_DIR/kicad-cli"
    SYMBOLS=$(find "$HOME/.local/share/flatpak" -type d -path '*share/kicad/symbols' 2>/dev/null | head -1)
    # Flatpak has its own /tmp: wire's temporary files go in the home folder.
    mkdir -p "$HOME/.cache/wire-tmp"
    {
      echo "export TMPDIR=\"$HOME/.cache/wire-tmp\""
      [ -n "$SYMBOLS" ] && echo "export KICAD_SYMBOL_DIR=\"$SYMBOLS\""
    } >"$HOME/.wire-env"
    echo "Flatpak KiCad: run '. ~/.wire-env' in each new shell"
    . "$HOME/.wire-env"
  fi
fi
kicad-cli version

say "Ollama"
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
# Several agents at once (the benchmark runs wire and the baseline side by side), models kept loaded.
if [ -d /etc/systemd/system ] && systemctl list-unit-files ollama.service >/dev/null 2>&1; then
  $SUDO mkdir -p /etc/systemd/system/ollama.service.d
  printf '[Service]\nEnvironment="OLLAMA_NUM_PARALLEL=4"\nEnvironment="OLLAMA_KEEP_ALIVE=-1"\nEnvironment="OLLAMA_FLASH_ATTENTION=1"\n' |
    $SUDO tee /etc/systemd/system/ollama.service.d/wire.conf >/dev/null
  $SUDO systemctl daemon-reload && $SUDO systemctl restart ollama
fi
ollama --version

say "wire"
curl -fsSL "https://raw.githubusercontent.com/leogue/wire/$BRANCH/install.sh" | WIRE_BRANCH="$BRANCH" sh

say "Models: $MODELS"
# shellcheck disable=SC2086
node "$HOME_DIR/bench/ollama.ts" $MODELS

say "Ready"
echo "Benchmark:  cd $HOME_DIR && node bench/run.ts --model ollama/<id above> --jobs 4"
echo "Design:     mkdir my-board && cd my-board && wire --provider ollama --model <id above>"
