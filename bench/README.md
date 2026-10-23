# Benchmark

The same model and the same design requests, two ways of working:

- **wire**: the wire agent.
- **baseline**: the same model in the plain pi coding agent (read, write, edit, bash) with KiCad installed,
  asked for a KiCad project checked with KiCad's ERC: an agent drawing a schematic without wire.

Every run is unattended and scored on the KiCad project it leaves, by KiCad: its netlist (components, nets
joining two pins or more), its ERC, and the parts the request names (`tasks.ts`). A run passes when KiCad
reads the schematic, it holds every required part and has no ERC error.

## Local models (Ollama)

```sh
node bench/ollama.ts qwen3.6:35b-a3b qwen3.8:27b   # pull, give a 128k context, declare to pi
wire --provider ollama --model qwen3.6:35b-a3b-ctx128k
```

On an ASUS Ascent GX10 / DGX Spark, `bench/gx10-setup.sh` installs everything (Node.js, KiCad 10, poppler,
Ollama, wire) and the models.

## Running

```sh
node bench/run.ts --model ollama/qwen3.6:35b-a3b-ctx128k --jobs 4
node bench/run.ts --model ollama/qwen3.6:35b-a3b-ctx128k --model ollama/qwen3.8:27b-ctx128k --tasks ldo --modes wire
node bench/run.ts --report ~/wire-bench/<run>     # rebuild a summary
```

Tasks: `ldo` (a quick check, close to wire's example: not for comparisons), `air-quality`, `powerbank`,
`expresslrs`. Results go to `~/wire-bench/<date>/` (`WIRE_BENCH_DIR`), outside wire's folder: per run, the project, the agent's events (JSONL), `result.json`, the pages as PNG; `summary.md` compares them.
