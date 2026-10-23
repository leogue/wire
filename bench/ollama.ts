#!/usr/bin/env node
/**
 * `node bench/ollama.ts MODEL…`: makes Ollama models usable by wire and the benchmark. Each model is pulled,
 * copied as `<model>-ctx<N>k` with a context window large enough for an agent (Ollama's default is too small
 * for the system prompt, tools and images), and declared to pi in ~/.pi/agent/models.json under the provider
 * `ollama`. Then: `wire --provider ollama --model <model>-ctx<N>k`.
 *
 * OLLAMA_HOST   the Ollama server (default http://localhost:11434)
 * WIRE_CONTEXT  the context window in tokens (default 131072)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const host = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
const context = Number(process.env.WIRE_CONTEXT ?? 131072);
const models = process.argv.slice(2);
if (models.length === 0) {
  console.error('usage: node bench/ollama.ts MODEL… (e.g. qwen3.6:35b-a3b qwen3.8:27b)');
  process.exit(1);
}

const ollama = (args: string[]) => execFileSync('ollama', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const config = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'models.json');
const json = existsSync(config) ? (JSON.parse(readFileSync(config, 'utf8')) as { providers?: Record<string, { models?: { id: string }[] }> }) : {};
const providers = (json.providers ??= {});
const provider = (providers.ollama ??= { baseUrl: `${host}/v1`, api: 'openai-completions', apiKey: 'ollama', models: [] } as never) as { models: { id: string }[] };

for (const model of models) {
  const [name, tag = 'latest'] = model.split(':');
  const id = `${name}:${tag}-ctx${Math.round(context / 1024)}k`;
  let shown: string;
  try {
    shown = ollama(['show', model]);
  } catch {
    console.log(`${model}: pulling`);
    execFileSync('ollama', ['pull', model], { stdio: 'inherit' });
    shown = ollama(['show', model]);
  }
  const vision = /^\s+vision\s*$/m.test(shown);
  const thinking = /^\s+thinking\s*$/m.test(shown);
  const temp = mkdtempSync(join(tmpdir(), 'wire-'));
  try {
    writeFileSync(join(temp, 'Modelfile'), `FROM ${model}\nPARAMETER num_ctx ${context}\n`);
    ollama(['create', id, '-f', join(temp, 'Modelfile')]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  provider.models = provider.models.filter((entry) => entry.id !== id);
  provider.models.push({
    id,
    name: `${model} (${Math.round(context / 1024)}k, local)`,
    input: vision ? ['text', 'image'] : ['text'],
    reasoning: thinking,
    // Ollama turns thinking off with reasoning_effort "none" (`--thinking off`): Qwen models that think
    // with tools sometimes end a turn with nothing.
    ...(thinking ? { thinkingLevelMap: { off: 'none' }, compat: { supportsReasoningEffort: true } } : {}),
    contextWindow: context,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as never);
  console.log(`${model}: ${id}${vision ? '' : ' (no vision: the agent cannot look at its renders or datasheets)'}`);
}

mkdirSync(dirname(config), { recursive: true });
writeFileSync(config, `${JSON.stringify(json, null, 2)}\n`);
console.log(`\nDeclared in ${config}. Run: wire --provider ollama --model ${models.length === 1 ? '<id above>' : '<one of the ids above>'}`);
