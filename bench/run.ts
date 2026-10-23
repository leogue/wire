#!/usr/bin/env node
/**
 * The benchmark: the same model, the same design requests, two ways of working.
 *
 * - `wire`: the wire agent (its format, checks, part tools and KiCad review).
 * - `baseline`: the same model in the plain pi coding agent (read, write, edit, bash) with KiCad installed,
 *   asked for a KiCad project checked by KiCad's ERC: how an agent draws a schematic without wire.
 *
 * Every run is unattended and scored the same way, on the KiCad project it leaves: KiCad's netlist
 * (components, nets), KiCad's ERC, and the parts the request names.
 *
 *   node bench/run.ts --model ollama/qwen3.6:35b-a3b-ctx128k [--model …] [--tasks ldo,air-quality]
 *                     [--modes wire,baseline] [--jobs 2] [--timeout 60]
 *   node bench/run.ts --report ~/wire-bench/<run>     rebuild a run's summary
 *
 * Results go to ~/wire-bench/<date>/ (WIRE_BENCH_DIR), outside wire's folder: per run the project, the agent's events (JSONL), result.json and the
 * pages as PNG; summary.md compares them.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCli } from '@wire/cli/cli';
import { child, children, erc, exportPdf, findCommand, kicadCli, parse, symbolDir } from '@wire/kicad';
import { baselineBrief, TASKS, UNATTENDED } from './tasks.ts';

const MODES = ['wire', 'baseline'] as const;
type Mode = (typeof MODES)[number];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WIRE = join(ROOT, 'packages/agent/src/main.ts');
const PI = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));

interface Result {
  task: string;
  mode: Mode;
  model: string;
  /** Wall-clock minutes. */
  minutes: number;
  timedOut: boolean;
  exitCode: number | null;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  outputTokens: number;
  /** The largest context sent in one request. */
  contextTokens: number;
  schematic?: string;
  components: number;
  /** Nets joining at least two pins. */
  nets: number;
  ercErrors: number;
  ercWarnings: number;
  unconnectedPins: number;
  partsFound: string[];
  partsMissing: string[];
  pages: string[];
  /** Why the project could not be scored (no schematic, KiCad refused it…). */
  problem?: string;
  /** A schematic KiCad reads, with components, all required parts and no ERC error. */
  pass: boolean;
}

// ---------- running an agent ----------

function agentArgs(mode: Mode, provider: string, model: string, prompt: string, sessions: string): string[] {
  const common = ['--mode', 'json', '--provider', provider, '--model', model, '--session-dir', sessions];
  if (mode === 'wire') return [WIRE, ...common, prompt];
  return [PI, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--tools', 'read,bash,edit,write', ...common, prompt];
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
}
interface AgentEvent {
  type: string;
  message?: { role?: string; usage?: Usage; content?: { type: string }[] };
  toolResults?: { isError?: boolean }[];
}

async function runAgent(dir: string, mode: Mode, modelSpec: string, prompt: string, timeoutMinutes: number) {
  const [provider, ...rest] = modelSpec.split('/');
  const model = rest.join('/');
  const project = join(dir, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir, 'prompt.md'), `${prompt}\n`);
  const events = createWriteStream(join(dir, 'events.jsonl'));
  const stats = { turns: 0, toolCalls: 0, toolErrors: 0, outputTokens: 0, contextTokens: 0 };
  const started = Date.now();
  const child = spawn(process.execPath, agentArgs(mode, provider!, model, prompt, join(dir, 'session')), { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.pipe(createWriteStream(join(dir, 'stderr.log')));
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    events.write(chunk);
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        continue;
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const usage = event.message.usage ?? {};
        stats.outputTokens += usage.output ?? 0;
        stats.contextTokens = Math.max(stats.contextTokens, (usage.input ?? 0) + (usage.cacheRead ?? 0));
      }
      if (event.type === 'turn_end') {
        stats.turns++;
        stats.toolCalls += (event.message?.content ?? []).filter((block) => block.type === 'toolCall').length;
        stats.toolErrors += (event.toolResults ?? []).filter((result) => result.isError).length;
      }
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMinutes * 60_000);
  const exitCode = await new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  clearTimeout(timer);
  events.end();
  return { ...stats, minutes: Math.round((Date.now() - started) / 600) / 100, timedOut, exitCode };
}

// ---------- scoring the project it leaves ----------

/** Files under `dir` (agent sessions and datasheets left out) whose name ends with `ext`. */
function find(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'session' || entry.name === 'datasheets' || entry.name === 'node_modules' ? [] : find(path, ext);
    return entry.name.endsWith(ext) ? [path] : [];
  });
}

/** The root schematic: the one named after a `.kicad_pro`, else the only one, else the largest. */
function rootSchematic(project: string): string | undefined {
  for (const pro of find(project, '.kicad_pro')) {
    const sch = pro.replace(/\.kicad_pro$/, '.kicad_sch');
    if (existsSync(sch)) return sch;
  }
  const all = find(project, '.kicad_sch');
  return all.sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0];
}

function score(dir: string, task: string): Omit<Result, 'task' | 'mode' | 'model' | 'minutes' | 'timedOut' | 'exitCode' | 'turns' | 'toolCalls' | 'toolErrors' | 'outputTokens' | 'contextTokens'> {
  const project = join(dir, 'project');
  const required = TASKS[task]!.parts;
  const empty = { components: 0, nets: 0, ercErrors: 0, ercWarnings: 0, unconnectedPins: 0, partsFound: [], partsMissing: Object.keys(required), pages: [], pass: false };
  const schematic = rootSchematic(project);
  if (!schematic) return { ...empty, problem: 'no KiCad schematic' };
  try {
    const netlist = join(dir, 'netlist.net');
    execFileSync(kicadCli(), ['sch', 'export', 'netlist', '--format', 'kicadsexpr', schematic, '-o', netlist], { stdio: 'pipe' });
    const tree = parse(readFileSync(netlist, 'utf8'));
    const components = children(child(tree, 'components') ?? [], 'comp').map((comp) =>
      [child(comp, 'ref')?.[1], child(comp, 'value')?.[1], child(child(comp, 'libsource') ?? [], 'lib')?.[1], child(child(comp, 'libsource') ?? [], 'part')?.[1], child(comp, 'footprint')?.[1]]
        .map((field) => String(field ?? ''))
        .join(' '),
    );
    const nets = children(child(tree, 'nets') ?? [], 'net').filter(
      (net) => children(net, 'node').filter((node) => !String(child(node, 'ref')?.[1] ?? '').startsWith('#')).length >= 2,
    ).length;
    const violations = erc(schematic);
    writeFileSync(join(dir, 'erc.json'), `${JSON.stringify(violations, null, 2)}\n`);
    const found = Object.entries(required).filter(([, pattern]) => components.some((line) => pattern.test(line))).map(([name]) => name);
    const ercErrors = violations.filter((v) => v.severity === 'error').length;
    const result = {
      schematic: relative(dir, schematic),
      components: components.length,
      nets,
      ercErrors,
      ercWarnings: violations.filter((v) => v.severity === 'warning').length,
      unconnectedPins: violations.filter((v) => /not connected/i.test(v.description)).length,
      partsFound: found,
      partsMissing: Object.keys(required).filter((name) => !found.includes(name)),
      pages: pages(schematic, dir),
    };
    return { ...result, pass: result.components > 0 && ercErrors === 0 && result.partsMissing.length === 0 };
  } catch (error) {
    return { ...empty, schematic: relative(dir, schematic), problem: `KiCad could not read it: ${(error as Error).message.split('\n')[0]}` };
  }
}

/** Every page of the schematic as a PNG in the run's folder. */
function pages(schematic: string, dir: string): string[] {
  const pdf = join(dir, 'schematic.pdf');
  exportPdf(schematic, pdf);
  const pdftoppm = findCommand('pdftoppm');
  if (!pdftoppm) return [];
  execFileSync(pdftoppm, ['-png', '-scale-to-x', '1600', '-scale-to-y', '-1', pdf, join(dir, 'page')], { stdio: 'pipe' });
  return readdirSync(dir).filter((name) => /^page-\d+\.png$/.test(name)).sort();
}

// ---------- the report ----------

function summary(results: readonly Result[]): string {
  const rows = results.map((r) =>
    [
      r.task,
      r.mode,
      r.model,
      `${r.minutes} min${r.timedOut ? ' (timeout)' : ''}`,
      String(r.turns),
      `${r.toolCalls} (${r.toolErrors} err)`,
      `${Math.round(r.outputTokens / 1000)}k`,
      String(r.components),
      String(r.nets),
      `${r.ercErrors} / ${r.ercWarnings}`,
      r.partsMissing.length === 0 ? 'all' : `missing ${r.partsMissing.join(', ')}`,
      r.pass ? '**pass**' : `fail${r.problem ? `: ${r.problem}` : ''}`,
    ].join(' | '),
  );
  const byMode = MODES.map((mode) => {
    const runs = results.filter((r) => r.mode === mode);
    if (runs.length === 0) return '';
    const passed = runs.filter((r) => r.pass).length;
    const minutes = runs.reduce((sum, r) => sum + r.minutes, 0) / runs.length;
    return `- **${mode}**: ${passed}/${runs.length} pass, ${Math.round(minutes * 10) / 10} min on average`;
  }).filter(Boolean);
  return [
    '# wire benchmark',
    '',
    ...byMode,
    '',
    'task | mode | model | time | turns | tool calls | output tokens | components | nets (≥ 2 pins) | ERC errors / warnings | required parts | result',
    '---|---|---|---|---|---|---|---|---|---|---|---',
    ...rows,
    '',
    'pass: KiCad reads the schematic, it has components, every part the request names, and no ERC error.',
    '',
  ].join('\n');
}

function report(folder: string): void {
  const results = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, 'result.json')))
    .map((entry) => JSON.parse(readFileSync(join(folder, entry.name, 'result.json'), 'utf8')) as Result);
  writeFileSync(join(folder, 'summary.md'), summary(results));
  console.log(summary(results));
}

// ---------- main ----------

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true },
    tasks: { type: 'string', default: 'ldo,air-quality,powerbank,expresslrs' },
    modes: { type: 'string', default: MODES.join(',') },
    jobs: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '60' },
    report: { type: 'string' },
  },
});

if (values.report) {
  report(values.report);
  process.exit(0);
}

const models = values.model ?? [];
const tasks = values.tasks.split(',').filter(Boolean);
const modes = values.modes.split(',').filter(Boolean) as Mode[];
const unknown = [...tasks.filter((task) => !TASKS[task]), ...modes.filter((mode) => !MODES.includes(mode))];
if (models.length === 0 || unknown.length > 0 || models.some((model) => !model.includes('/'))) {
  console.error(`usage: node bench/run.ts --model PROVIDER/MODEL [--model …] [--tasks ${Object.keys(TASKS).join(',')}] [--modes wire,baseline] [--jobs N] [--timeout MINUTES]`);
  if (unknown.length > 0) console.error(`unknown: ${unknown.join(', ')}`);
  process.exit(1);
}

// Outside wire's folder: the agents must not find wire's examples (the ldo task is one of them).
const folder = join(process.env.WIRE_BENCH_DIR ?? join(homedir(), 'wire-bench'), new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-'));
const brief = baselineBrief(kicadCli(), symbolDir());
const queue = models.flatMap((model) => tasks.flatMap((task) => modes.map((mode) => ({ model, task, mode }))));
console.log(`${queue.length} runs, ${values.jobs} at a time → ${relative(process.cwd(), folder)}`);

/** wire's runs are scored on the KiCad project wire builds from their sources (and verifies against KiCad). */
async function scoreRun(dir: string, mode: Mode, task: string) {
  const project = join(dir, 'project');
  if (mode === 'wire' && existsSync(join(project, 'project.json'))) {
    const built = await runCli(['build', project]).catch((error: Error) => ({ code: 1, text: error.message }));
    writeFileSync(join(dir, 'build.txt'), `${built.text}\n`);
  }
  return score(dir, task);
}

async function worker() {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { model, task, mode } = item;
    const dir = join(folder, `${task}-${mode}-${basename(model).replace(/[^\w.-]/g, '_')}`);
    mkdirSync(dir, { recursive: true });
    const prompt = [TASKS[task]!.prompt, mode === 'baseline' ? brief : '', UNATTENDED].filter(Boolean).join('\n\n');
    console.log(`start  ${relative(folder, dir)}`);
    const run = await runAgent(dir, mode, model, prompt, Number(values.timeout));
    const result: Result = { task, mode, model, ...run, ...(await scoreRun(dir, mode, task)) };
    writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`done   ${relative(folder, dir)}: ${result.pass ? 'pass' : 'fail'}, ${result.minutes} min, ERC ${result.ercErrors} errors, ${result.components} components${result.problem ? `, ${result.problem}` : ''}`);
  }
}

mkdirSync(folder, { recursive: true });
await Promise.all(Array.from({ length: Math.max(1, Number(values.jobs)) }, worker));
report(folder);
