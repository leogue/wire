import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { child, children, parse } from './sexpr.ts';

/** Where KiCad installs itself, when it is not on the PATH. */
const MAC_KICAD = '/Applications/KiCad/KiCad.app/Contents';
const WINDOWS_KICAD = `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\KiCad\\10.0`;

/** A program on the PATH (`which`, or `where` on Windows), or undefined. */
export function findCommand(command: string): string | undefined {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return found.split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The KiCad installation: `KICAD_CLI`, `kicad-cli` on the PATH, or KiCad's default location (macOS, Windows). */
/** How to install poppler, for errors. */
export const POPPLER = 'pdftoppm not found: install poppler (macOS: brew install poppler; Linux: apt install poppler-utils; Windows: winget install oschwartz10612.Poppler, or scoop install poppler)';

export function kicadCli(): string {
  const found = [process.env.KICAD_CLI, findCommand('kicad-cli'), `${MAC_KICAD}/MacOS/kicad-cli`, `${WINDOWS_KICAD}\\bin\\kicad-cli.exe`].find(
    (path) => path && existsSync(path),
  );
  if (!found) throw new Error('kicad-cli not found: install KiCad 10 or set KICAD_CLI');
  return found;
}

function run(args: string[]): string {
  return execFileSync(kicadCli(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function withTemp<T>(use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'wire-'));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A blank `.kicad_pro`, from KiCad's template when it is installed. */
export function projectTemplate(): string {
  const template = [
    `${MAC_KICAD}/SharedSupport/template/kicad.kicad_pro`,
    '/usr/share/kicad/template/kicad.kicad_pro',
    `${WINDOWS_KICAD}\\share\\kicad\\template\\kicad.kicad_pro`,
  ].find(existsSync);
  return template ? readFileSync(template, 'utf8') : '{}\n';
}

export interface KicadNet {
  readonly name: string;
  readonly pins: readonly { readonly ref: string; readonly pin: string }[];
}

/** The nets KiCad computes from a schematic, power symbols and flags left out. */
export function kicadNetlist(schematic: string): KicadNet[] {
  const tree = withTemp((dir) => {
    const out = join(dir, 'netlist.net');
    run(['sch', 'export', 'netlist', '--format', 'kicadsexpr', schematic, '-o', out]);
    return parse(readFileSync(out, 'utf8'));
  });
  return children(child(tree, 'nets') ?? [], 'net').map((net) => ({
    name: String(child(net, 'name')?.[1] ?? ''),
    pins: children(net, 'node')
      .map((node) => ({ ref: String(child(node, 'ref')?.[1] ?? ''), pin: String(child(node, 'pin')?.[1] ?? '') }))
      .filter((pin) => !pin.ref.startsWith('#')),
  }));
}

export interface ErcViolation {
  readonly severity: string;
  readonly description: string;
  readonly items: readonly string[];
}

/** KiCad's electrical rules check. */
export function erc(schematic: string): ErcViolation[] {
  const report = withTemp((dir) => {
    const out = join(dir, 'erc.json');
    try {
      run(['sch', 'erc', '--format', 'json', '--severity-all', schematic, '-o', out]);
    } catch {
      // kicad-cli exits with an error code when it finds violations; the report is still written.
    }
    return JSON.parse(readFileSync(out, 'utf8')) as {
      sheets: { path: string; violations: { severity: string; description: string; items: { description: string }[] }[] }[];
    };
  });
  return report.sheets.flatMap((sheet) =>
    sheet.violations.map((violation) => ({
      severity: violation.severity,
      description: violation.description,
      items: violation.items.map((item) => item.description),
    })),
  );
}

/** Every page in one PDF, root sheet first. */
export function exportPdf(schematic: string, out: string): void {
  run(['sch', 'export', 'pdf', schematic, '-o', out]);
}

/** One page as a PNG, through KiCad's PDF and poppler's `pdftoppm`. Pages count from 1. */
export function exportPng(schematic: string, out: string, page = 1, width = 2400): void {
  const pdftoppm = findCommand('pdftoppm');
  if (!pdftoppm) throw new Error(POPPLER);
  withTemp((dir) => {
    const pdf = join(dir, 'all.pdf');
    exportPdf(schematic, pdf);
    const stem = join(dir, 'page');
    try {
      execFileSync(pdftoppm, ['-f', String(page), '-l', String(page), '-singlefile', '-png', '-scale-to-x', String(width), '-scale-to-y', '-1', pdf, stem], { stdio: 'pipe' });
    } catch {
      throw new Error(`no page ${page} in ${schematic}`);
    }
    copyFileSync(`${stem}.png`, out);
  });
}

export function writeFiles(dir: string, files: readonly { path: string; text: string }[]): void {
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file.path), file.text);
}
