#!/usr/bin/env node
// `wire-agent [pi options] [prompt]`: the regular pi CLI (models, login, sessions, terminal UI) with only
// wire's tools, and wire's system prompt (design skill included). Run it in the project folder.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { systemPrompt, TOOLS } from './prompt.ts';

// Local settings (EXA_API_KEY) in the .env file at the root of wire; the environment wins.
const env = new URL('../../../.env', import.meta.url);
if (existsSync(env)) process.loadEnvFile(env);

const extension = fileURLToPath(new URL('./extension.ts', import.meta.url));
const pi = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));

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
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
// pi receives terminal signals itself; forward the others and never leave it orphaned.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 130 : 1);
});
