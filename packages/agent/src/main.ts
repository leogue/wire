#!/usr/bin/env node
// The `wire` command. `wire <command>` runs a wire command (check, render, parts…); anything else starts the
// design agent: the regular pi CLI (models, login, sessions, terminal UI) with only wire's tools and wire's
// system prompt (design skill included), in the current folder.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS, runCli } from '@wire/cli/cli';
import { systemPrompt, TOOLS } from './prompt.ts';

// Local settings (EXA_API_KEY) in the .env file at the root of wire; the environment wins.
const env = new URL('../../../.env', import.meta.url);
if (existsSync(env)) process.loadEnvFile(env);

const args = process.argv.slice(2);
const first = args[0] ?? '';
if (COMMANDS.has(first) || first === '--help' || first === '-h') {
  let output;
  try {
    output = await runCli(args);
  } catch (error) {
    output = { code: 1, text: `error: ${(error as Error).message}` };
  }
  (output.code === 0 ? process.stdout : process.stderr).write(`${output.text}\n`);
  process.exit(output.code);
}

const extension = fileURLToPath(new URL('./extension.ts', import.meta.url));
const pi = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
const piArgs = first === 'agent' ? args.slice(1) : args;

const child = spawn(
  process.execPath,
  [
    pi,
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--extension',
    extension,
    '--system-prompt',
    systemPrompt(),
    '--tools',
    TOOLS.join(','),
    ...piArgs,
  ],
  { stdio: 'inherit' },
);
// pi receives terminal signals itself; forward the others and never leave it orphaned.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 130 : 1);
});
