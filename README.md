# wire

**An AI agent that designs electronic schematics, and a file format that lets it succeed.**

Language models are poor at schematic capture for one precise reason: a schematic is symbols and wires at
millimetre coordinates, and a wire is connected only if its end falls exactly on a pin. Models place a
symbol half a millimetre off, run a wire next to a pin without touching it, stack parts on top of each
other. The result is unreadable, or electrically wrong without anyone noticing.

wire removes that failure mode instead of asking the model to be more careful:

- **A grid of cells, not millimetres.** Parts sit in cells; a cell exposes connection points at the middle
  of its sides; two facing points are connected. Nothing can be "almost connected".
- **Frames, one per function.** A buck converter, an input protection, an MCU core: each is a frame with its
  own small grid, placed on the sheet by one coordinate. Moving a function is changing one number.
- **Every connection is checked**, with errors written for the agent to act on
  (`R3.1 at [2, 4]: side N touches nothing`).
- **KiCad is the output and the judge.** wire writes a native KiCad project, then has KiCad compute its own
  netlist and refuses any difference. The agent looks at the pages exactly as KiCad draws them.
- **Real parts.** 22,000+ KiCad symbols imported deterministically (the model never copies a pin table),
  JLCPCB's stock and basic parts, datasheets read as page images, web search.

<p align="center"><img src="docs/ldo-indicator.png" width="720" alt="A 5 V to 3.3 V LDO and two indicator LEDs, as KiCad draws the wire project"></p>

The schematic above is this JSON (`examples/ldo-indicator/sheets/power.json`, shortened):

```json
{
  "title": "Power",
  "frames": {
    "ldo": {
      "title": "LDO 3.3 V",
      "at": [0, 0],
      "cells": [
        {"at": [1, 1], "tile": "PWR", "net": "+5V"},
        {"at": [1, 2], "wire": "NSEW"},
        {"at": [1, 3], "tile": "C", "ref": "C1", "value": "1u"},
        {"at": [1, 4], "tile": "GND"},
        {"at": [3, 1], "block": "AP2112K-3.3", "ref": "U1", "mode": "wired"},
        …
      ]
    },
    "led-5v": {"title": "5 V on", "at": [8, 0], "border": false, "cells": […]}
  }
}
```

## Getting started

Requirements: **Node 24+**, **KiCad 10** (rendering, export, symbol library) and **poppler** (`pdftoppm`,
`pdftotext`; `brew install poppler` or `apt install poppler-utils`).

```sh
git clone <this repository> wire && cd wire
npm install
npm test
```

### The agent

The agent is the [pi](https://pi.dev) coding-agent CLI, launched with wire's tools and system prompt only.
Run it in an empty folder for a new design; pick a model that accepts images (it looks at its renders and at
datasheet pages) with pi's `/login` and `/model`.

```sh
mkdir my-board && cd my-board
node ../packages/agent/src/main.ts                                   # interactive
node ../packages/agent/src/main.ts --print "A USB-C powered ESP32-C3 temperature sensor, JLCPCB basic parts"
```

It writes the project (`project.json`, `sheets/`, `parts/`, `datasheets/`) and delivers `out/`: the KiCad
project, a PDF and one PNG per sheet. For web search, put an [Exa](https://exa.ai) key in a `.env` file at the
root of this repository: `EXA_API_KEY=…`.

| Tool | What it does |
|---|---|
| `wire_check` | every check; where each frame and block lies |
| `wire_render` | builds the KiCad project (nets verified) and returns each page as an image |
| `wire_netlist` | the nets, pin by pin |
| `wire_erc` | KiCad's electrical rules check |
| `wire_parts` | search built-in parts, KiCad's symbol library, or JLCPCB's stock (`jlc`, `basic`) |
| `wire_show` | a part's pins and their sides on the grid; a JLCPCB part's stock, price and the symbol to use |
| `wire_import` | copy a KiCad symbol into the project as a block |
| `wire_datasheet` | a datasheet as page images (≤ 8 pages), or an index of its pages and the pages asked for |
| `web_search` | search the web (Exa) |
| `read`, `bash`, `edit`, `write` | pi's own |

The design knowledge (format, work loop, how an engineer draws) is the skill in
[`packages/agent/skills/wire/SKILL.md`](packages/agent/skills/wire/SKILL.md), included whole in the system
prompt. When the agent stops on a project that fails its checks, it is sent back to fix it (three times at
most). It has shell access and is not sandboxed: run it on your own machine, in a project folder.

### The command line

Everything the agent does is a `wire` command (`npm run wire -- …`, or `npm link -w @wire/cli` for a global
`wire`):

```sh
wire check examples/ldo-indicator            # checks, and where each frame lies
wire render examples/ldo-indicator           # KiCad project, PDF and PNGs in examples/ldo-indicator/out/
wire erc examples/ldo-indicator              # KiCad's ERC
wire netlist examples/ldo-indicator

wire parts "ldo 3.3"                          # built-in parts, then KiCad symbols
wire show Amplifier_Operational:LM358         # pins and units of a KiCad symbol
wire import Regulator_Linear:AP2112K-3.3 .    # as ./parts/AP2112K-3.3.json
wire parts "100nF 0402" --jlc --basic         # JLCPCB parts in stock
wire show C51118                              # stock, price, datasheet, symbol to use
wire datasheet https://www.diodes.com/assets/Datasheets/AP2112.pdf . --pages 1,2
wire web "AP2112 reference design"
wire help
```

## The format

A project folder:

```
project.json        {"name": "...", "sheets": ["power", "mcu"], "defaults": {...}}
sheets/<name>.json  one page, made of frames
parts/<Name>.json   the project's blocks (ICs, connectors) and any extra basic part
datasheets/         PDFs and their rendered pages
```

**The grid.** A cell is `[column, row]` (10.16 mm, 4 × KiCad's 2.54 mm pitch), rows going down. Two
neighbouring cells whose facing sides both carry a port are connected; a port facing nothing is an error.

**Frames.** A sheet's frames each have their own grid (`[0, 0]` is the frame's top-left cell, row 0 is its
title). Frames do not overlap, leave the paper (`"paper": "A4" | "A3" | "A2"`) or cover the title block; no
wire leaves a frame: frames connect through labels and power symbols. `"border": false` hides a small
group's box.

**Cells.**

| Cell | Example |
|---|---|
| basic part | `{"at": [0, 2], "tile": "R", "ref": "R1", "value": "10k", "rot": 90}` |
| power | `{"at": [0, 1], "tile": "PWR", "net": "+3V3"}` · `{"at": [0, 4], "tile": "GND"}` |
| IC unit | `{"at": [3, 1], "block": "AP2112K-3.3", "ref": "U1", "mode": "wired"}` |
| | `{"at": [0, 1], "block": "STM32G031F6Px", "unit": "PA", "ref": "U1", "mode": "label", "nets": {"PA13": "SWDIO"}, "unused": "NC"}` |
| wire | `{"at": [1, 2], "wire": "NSE"}` (joins those sides) · `"NS\|EW"` (crossing, not connected) |
| run | `{"run": [[1, 3], [6, 3]]}` |
| label | `{"at": [7, 4], "label": "I2C_SDA", "side": "W"}` |
| note | `{"at": [0, 8], "text": "VOUT = 0.8 × (1 + R1/R2)"}` |

**Parts.** A *tile* is a basic component drawn in one cell (23 built in: passives, diodes, transistors,
power symbols); its value is given when placing it. A *block* is an IC or connector: a pin table and
*units* listing pin numbers down their west and east sides; its drawing is computed. Splitting a large IC
by function or reordering its pins is editing `units`. Each placement chooses `wired` (one pin per row,
wired like a tile) or `label` (2.54 mm pitch, a net name per pin). Blocks come from KiCad
(`wire import`) and keep their `source`: `check` reports a pin table that no longer matches KiCad's.

**Nets and references.** The same name (label, power symbol, label-mode pin) is the same net everywhere in the
project. References are unique across the project; the units of one block share theirs.

The JSON Schemas are in [`packages/format/schemas/`](packages/format/schemas) (`wire schema sheet`).

## Repository

| Package | Role |
|---|---|
| [`packages/format`](packages/format) | zod schemas of every file (the single source of truth) and the generated JSON Schemas |
| [`packages/library`](packages/library) | the built-in basic parts |
| [`packages/core`](packages/core) | loading, layout of frames, sheets and projects, every check, the netlist |
| [`packages/kicad`](packages/kicad) | KiCad export verified against KiCad's netlist; PDF, PNG and ERC through `kicad-cli`; KiCad symbol import |
| [`packages/cli`](packages/cli) | the `wire` command; JLCPCB search, datasheets, web search |
| [`packages/agent`](packages/agent) | the pi extension (tools), system prompt, skill and launcher |
| [`examples`](examples) | reference projects |

```sh
npm test            # vitest; tests needing KiCad or poppler are skipped without them
npm run typecheck   # TypeScript 7, strict
npm run schema      # regenerate the JSON Schemas after changing packages/format
```

Node runs the TypeScript sources directly: there is no build step.

## Status

Working today: the format, checks, verified KiCad export, KiCad symbols, JLCPCB search, datasheets as
images, web search and the agent. Next: reference examples for the agent to imitate, a BOM, footprint checks
(existence, pins against pads), an unattended runner for benchmarks, and running the agent on a local
open-weight vision model.

KiCad symbols and footprints are © the KiCad library contributors (CC-BY-SA 4.0 with a design exception);
wire reads them from the local KiCad installation and ships none of them. JLCPCB data comes from the public,
unofficial API of jlcpcb.com.
