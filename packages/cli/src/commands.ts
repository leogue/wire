import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PartNameSchema, jsonSchemas, type Block, type Part } from '@wire/format';
import { builtinParts, loadParts } from '@wire/library';
import { labelGeometry, layoutProject, loadProject, sheetArea, turnSide, wiredGeometry, type Diagnostic, type ProjectLayout } from '@wire/core';
import { compareWithSource, erc, exportPdf, exportPng, exportProject, kicadBlock, searchSymbols, symbolDir } from '@wire/kicad';

/** What a command prints, its exit code, and the PNG files it produced for someone to look at. */
export interface Output {
  readonly code: number;
  readonly text: string;
  readonly images?: readonly string[];
}

export { MAX_PAGES, datasheet, parsePages } from './datasheet.ts';
export { webSearch } from './web.ts';
import { chipFootprint, jlcPart, kicadSymbolsFor, searchJlc, type JlcPart } from './jlc.ts';

const STEM = 'schematic';
const dirUrl = (dir: string) => pathToFileURL(`${resolve(dir)}/`);
const fail = (text: string): Output => ({ code: 1, text });

function load(dir: string): { ok: true; layout: ProjectLayout; project: Parameters<typeof exportProject>[0] } | { ok: false; output: Output } {
  if (!existsSync(join(dir, 'project.json'))) return { ok: false, output: fail(`no project.json in ${resolve(dir)}`) };
  const loaded = loadProject(dirUrl(dir));
  if (!loaded.ok) return { ok: false, output: fail(`invalid files:\n${loaded.errors.map((e) => `  ${e}`).join('\n')}`) };
  const { project, sheets, lookup } = loaded.value;
  const layout = layoutProject(project, sheets, lookup);
  return { ok: true, layout: { ...layout, diagnostics: [...layout.diagnostics, ...checkSources(dir)] }, project };
}

/** Blocks imported from KiCad keep KiCad's pin table: the same numbers and names (a type may differ, with a reason). */
function checkSources(dir: string): Diagnostic[] {
  const own = join(dir, 'parts');
  if (!existsSync(own)) return [];
  const diagnostics: Diagnostic[] = [];
  for (const [name, part] of loadParts(dirUrl(own))) {
    if (part.kind !== 'block' || !part.source) continue;
    if (!symbolDir()) {
      diagnostics.push({ severity: 'warning', message: `parts/${name}.json: pins not compared with ${part.source} (KiCad symbol library not found)` });
      continue;
    }
    try {
      const { errors, types } = compareWithSource(part);
      diagnostics.push(...errors.map((message) => ({ severity: 'error' as const, message: `parts/${name}.json: ${message} (only "units" may change)` })));
      diagnostics.push(...types.map((message) => ({ severity: 'warning' as const, message: `parts/${name}.json: ${message}: keep it only if the datasheet says so` })));
    } catch (error) {
      diagnostics.push({ severity: 'error', message: `parts/${name}.json: ${(error as Error).message}` });
    }
  }
  return diagnostics;
}

function diagnosticsText(diagnostics: readonly Diagnostic[]): string[] {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  return [
    ...(errors.length > 0 ? [`errors (${errors.length}):`, ...errors.map((d) => `  ${d.message}`)] : []),
    ...(warnings.length > 0 ? [`warnings (${warnings.length}):`, ...warnings.map((d) => `  ${d.message}`)] : []),
  ];
}

const hasErrors = (layout: ProjectLayout) => layout.diagnostics.some((d) => d.severity === 'error');

/** `wire check [dir]`: every check, and where each frame lies on its sheet. */
export function check(dir: string): Output {
  const loaded = load(dir);
  if (!loaded.ok) return loaded.output;
  const { layout } = loaded;
  const lines: string[] = [];
  for (const sheet of layout.sheets) {
    const area = sheetArea(sheet.paper);
    lines.push(
      `sheet ${sheet.name} "${sheet.title}" (${sheet.paper}: columns 0-${area.cols - 1}, rows 0-${area.rows - 1}, title block from column ${area.titleBlock[0]} and row ${area.titleBlock[1]})`,
    );
    for (const frame of sheet.frames) {
      const [c, r] = frame.at;
      const [w, h] = frame.size;
      lines.push(`  frame ${frame.key} "${frame.title}": at [${c}, ${r}], ${w} x ${h} cells (columns ${c}-${c + w - 1}, rows ${r}-${r + h - 1})`);
      for (const element of frame.elements) {
        if (element.kind === 'block') {
          const [bw, bh] = [element.geometry.cols, element.geometry.rows];
          lines.push(`    ${element.ref}${Object.keys(element.block.units).length > 1 ? ` unit ${element.unit}` : ''} (${element.mode}): local [${element.at[0]}, ${element.at[1]}], ${bw} x ${bh} cells`);
        }
      }
    }
  }
  lines.push(...diagnosticsText(layout.diagnostics));
  const errors = layout.diagnostics.filter((d) => d.severity === 'error').length;
  lines.push(errors > 0 ? `${errors} error(s)` : 'OK');
  return { code: errors > 0 ? 1 : 0, text: lines.join('\n') };
}

/** `wire netlist [dir]`: wire's own nets, without KiCad. */
export function netlist(dir: string): Output {
  const loaded = load(dir);
  if (!loaded.ok) return loaded.output;
  const nets = loaded.layout.nets.map((net) => `${net.name ?? '(unnamed)'}: ${net.pins.map((pin) => `${pin.ref}.${pin.pin}${pin.name && pin.name !== pin.pin ? `(${pin.name})` : ''}`).join(' ')}`);
  return { code: hasErrors(loaded.layout) ? 1 : 0, text: [...nets, ...(hasErrors(loaded.layout) ? ['', 'the project has errors: run wire check'] : [])].join('\n') };
}

/** `wire build [dir]`: checks, then writes the KiCad project and its PDF, verified against KiCad's netlist. */
export function build(dir: string, out = join(dir, 'out')): Output {
  const loaded = load(dir);
  if (!loaded.ok) return loaded.output;
  if (hasErrors(loaded.layout)) return fail([...diagnosticsText(loaded.layout.diagnostics), 'nothing written: fix the errors first'].join('\n'));
  const { schematic, differences } = exportProject(loaded.project, loaded.layout, join(out, 'kicad'), STEM);
  if (differences.length > 0) return fail(['KiCad does not see the same nets as wire (please report this bug):', ...differences.map((d) => `  ${d}`)].join('\n'));
  const pdf = join(out, `${STEM}.pdf`);
  exportPdf(schematic, pdf);
  const warnings = diagnosticsText(loaded.layout.diagnostics);
  return { code: 0, text: [...warnings, `KiCad project: ${schematic}`, `PDF: ${pdf}`, 'nets verified against KiCad'].join('\n') };
}

/** `wire render [dir] [--page N]`: builds, then one PNG per page (or the page asked for). */
export function render(dir: string, page?: number, out = join(dir, 'out')): Output {
  const loaded = load(dir);
  if (!loaded.ok) return loaded.output;
  const built = build(dir, out);
  if (built.code !== 0) return built;
  const sheets = loaded.layout.sheets;
  // With several sheets, page 1 is KiCad's index page: sheet n is page n + 1.
  const pages = sheets.map((sheet, index) => ({ sheet: sheet.name, page: sheets.length === 1 ? 1 : index + 2 }));
  const wanted = page === undefined ? pages : pages.filter((p) => p.page === page);
  if (wanted.length === 0) return fail(`no page ${page}: pages are ${pages.map((p) => `${p.page} (${p.sheet})`).join(', ')}`);
  mkdirSync(out, { recursive: true });
  const images = wanted.map(({ sheet, page: n }) => {
    const png = join(out, `${sheet}.png`);
    exportPng(join(out, 'kicad', `${STEM}.kicad_sch`), png, n);
    return png;
  });
  return { code: 0, text: wanted.map(({ sheet, page: n }, index) => `${sheet} (page ${n}): ${images[index]}`).join('\n'), images };
}

/** `wire erc [dir]`: builds, then KiCad's electrical rules check. */
export function ercCommand(dir: string, out = join(dir, 'out')): Output {
  const built = build(dir, out);
  if (built.code !== 0) return built;
  const violations = erc(join(out, 'kicad', `${STEM}.kicad_sch`));
  if (violations.length === 0) return { code: 0, text: 'ERC: no violation' };
  return {
    code: violations.some((v) => v.severity === 'error') ? 1 : 0,
    text: [`ERC: ${violations.length} violation(s)`, ...violations.map((v) => `  ${v.severity}: ${v.description}${v.items.length > 0 ? ` — ${v.items.join('; ')}` : ''}`)].join('\n'),
  };
}

function partsOf(dir: string): Map<string, { part: Part; source: string }> {
  const parts = new Map<string, { part: Part; source: string }>();
  for (const [name, part] of builtinParts()) parts.set(name, { part, source: 'built-in' });
  const own = join(dir, 'parts');
  if (existsSync(own)) for (const [name, part] of loadParts(dirUrl(own))) parts.set(name, { part, source: 'parts/' });
  return parts;
}

/** KiCad symbols listed by `parts`; more means the query should be narrower. */
const KICAD_RESULTS = 30;

/** JLCPCB parts listed by `parts --jlc`. */
const JLC_RESULTS = 20;

const jlcLine = (part: JlcPart) =>
  `${part.code.padEnd(9)} ${part.kind.padEnd(9)} stock ${String(part.stock).padEnd(9)} ${part.prices[0] ? `$${part.prices[0].price}` : ''}  ${part.mpn}${part.brand ? ` (${part.brand})` : ''}  ${part.package}  ${part.description.slice(0, 90)}`;

/** `wire parts QUERY --jlc [--basic]`: JLCPCB parts in stock, basic first (only basic with `basic`). */
async function jlcParts(query: string, basicOnly: boolean): Promise<Output> {
  if (!query.trim()) return fail('wire parts --jlc needs words to search for: an MPN, an LCSC code, or a value and a package ("100nF 0402")');
  const found = await searchJlc(query, basicOnly);
  if (found.length === 0) return { code: 0, text: `no JLCPCB part in stock${basicOnly ? ' (basic)' : ''} contains every word of "${query}": try fewer words` };
  return {
    code: 0,
    text: [
      `JLCPCB parts in stock${basicOnly ? ', basic only' : ', basic first'} (wire show CODE for the details and the symbol to use):`,
      ...found.slice(0, JLC_RESULTS).map((part) => `  ${jlcLine(part)}`),
      ...(found.length > JLC_RESULTS ? [`  … ${found.length - JLC_RESULTS} more: add words to narrow the search`] : []),
    ].join('\n'),
  };
}

/**
 * `wire parts [query] [--dir dir]`: built-in parts and the project's own, then the KiCad symbols, filtered
 * by every word of the query (names, descriptions, keywords). An empty query lists the local parts only.
 * With `jlc`, JLCPCB's parts in stock instead.
 */
export async function parts(query: string, dir: string, jlc?: { basic: boolean }): Promise<Output> {
  if (jlc) return jlcParts(query, jlc.basic);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const local = [...partsOf(dir)]
    .filter(([name, { part }]) => {
      const text = [name, part.description, ...(part.keywords ?? [])].join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .map(([name, { part, source }]) => `${name.padEnd(16)} ${part.kind.padEnd(5)} ${source.padEnd(8)} ${part.description}`);
  const lines = local.length > 0 ? ['ready to place:', ...local.map((line) => `  ${line}`)] : [];
  if (words.length > 0) {
    if (!symbolDir()) lines.push('KiCad symbols: library not found (install KiCad 10 or set KICAD_SYMBOL_DIR)');
    else {
      const found = searchSymbols(query);
      if (found.length > 0) {
        lines.push(`KiCad symbols (wire show Lib:Name to see the pins, wire import Lib:Name to use one):`);
        lines.push(...found.slice(0, KICAD_RESULTS).map((symbol) => `  ${symbol.id}  ${symbol.description}${symbol.footprint ? ` [${symbol.footprint}]` : ''}`));
        if (found.length > KICAD_RESULTS) lines.push(`  … ${found.length - KICAD_RESULTS} more: add words to narrow the search`);
      }
    }
  }
  return { code: 0, text: lines.length > 0 ? lines.join('\n') : `no part matches "${query}"` };
}

/** JSON on one line, with a space after each `:` and `,`. */
function flatJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flatJson).join(', ')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${flatJson(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}

/** Readable JSON: what fits on one line stays on one line. */
function formatJson(value: unknown, indent = 0): string {
  const flat = flatJson(value);
  if (flat.length + indent <= 100 || typeof value !== 'object' || value === null) return flat;
  const pad = ' '.repeat(indent + 2);
  const items = Array.isArray(value)
    ? value.map((item) => pad + formatJson(item, indent + 2))
    : Object.entries(value).map(([key, item]) => `${pad}${JSON.stringify(key)}: ${formatJson(item, indent + 2)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${items.join(',\n')}\n${' '.repeat(indent)}${close}`;
}

/** From this many pins, a unit is hard to read: split it by function. */
const LARGE_UNIT = 20;

/** `wire import Lib:Name [DIR] [--as NAME] [--force]`: a KiCad symbol as `parts/NAME.json`, its pins unchanged. */
export function importPart(id: string, dir: string, as?: string, force = false): Output {
  const block = kicadBlock(id);
  const name = as ?? id.slice(id.indexOf(':') + 1).replace(/[^A-Za-z0-9_.+-]/g, '_').slice(0, 64);
  if (!PartNameSchema.safeParse(name).success) return fail(`"${name}" cannot be a part name: choose one with --as (letters, digits, _ . + -)`);
  if (builtinParts().has(name)) return fail(`"${name}" is a built-in part: choose another name with --as`);
  const path = join(dir, 'parts', `${name}.json`);
  if (existsSync(path) && !force) return fail(`parts/${name}.json exists: --force replaces it (its units too), --as imports under another name`);
  mkdirSync(join(dir, 'parts'), { recursive: true });
  writeFileSync(path, `${formatJson(block)}\n`);
  const units = Object.entries(block.units).map(([unit, sides]) => {
    const count = [...sides.W, ...sides.E].filter((slot) => slot !== null).length;
    return { unit, count, text: `${unit} (${count} pins: W ${sides.W.length} rows, E ${sides.E.length} rows)` };
  });
  return {
    code: 0,
    text: [
      `parts/${name}.json: ${id}, ${Object.keys(block.pins).length} pins, unit${units.length > 1 ? 's' : ''} ${units.map((u) => u.text).join(', ')}`,
      `footprint: ${block.footprint ?? 'none in KiCad: set one'}${block.datasheet ? `, datasheet: ${block.datasheet}` : ''}`,
      `place it with {"block": "${name}", "ref": "${block.ref}1", "mode": "wired" or "label"${units.length > 1 ? ', "unit": "…"' : ''}}`,
      ...units.filter((u) => u.count >= LARGE_UNIT).map((u) => `unit ${u.unit} has ${u.count} pins: split it into units by function (edit "units" only)`),
    ].join('\n'),
  };
}

function blockText(name: string, block: Block): string[] {
  const pinText = (number: string | null) => (number === null ? '(empty row)' : `${number}${block.pins[number]!.name ? ` ${block.pins[number]!.name}` : ''}`);
  const lines = [
    `${name}: block, references ${block.ref}1, ${block.ref}2…, value ${block.value}: ${block.description}`,
    ...(block.footprint ? [`footprint: ${block.footprint}`] : []),
    ...(block.datasheet ? [`datasheet: ${block.datasheet}`] : []),
    'pins:',
    ...Object.entries(block.pins).map(([number, pin]) => `  ${number.padEnd(4)} ${pin.name.padEnd(12)} ${pin.type}`),
  ];
  for (const [unit, sides] of Object.entries(block.units)) {
    const wired = wiredGeometry(block, sides);
    const pinNames = new Map(Object.entries(block.pins).map(([number, pin]) => [number, pin.name]));
    const label = labelGeometry(block, sides, pinNames, `${block.ref}1`, block.value);
    lines.push(
      `unit ${unit}: W ${sides.W.map(pinText).join(', ') || '(none)'} | E ${sides.E.map(pinText).join(', ') || '(none)'}`,
      `  wired: ${wired.cols} x ${wired.rows} cells: header row, then one pin per row (row +1 = first); W pins on the west side of column +0, E pins on the east side of column +${wired.cols - 1}`,
      `  label: about ${label.cols} x ${label.rows} cells with nets as long as the pin names (wire check prints the actual size)`,
    );
  }
  return lines;
}

/** `wire show C51118`: a JLCPCB part, and what to place for it in a schematic. */
async function showJlc(code: string): Promise<Output> {
  const part = await jlcPart(code);
  if (!part) return fail(`no JLCPCB part ${code}`);
  const symbols = kicadSymbolsFor(part.mpn);
  const footprint = chipFootprint(part);
  const use = footprint
    ? [`use: a built-in tile (R, C, L, LED…) with "footprint": "${footprint}", "fields": {"LCSC": "${part.code}"}`]
    : symbols.length > 0
      ? [
          `KiCad symbol${symbols.length > 1 ? 's' : ''}: ${symbols.slice(0, 5).join(', ')} (check that its package is ${part.package})`,
          `use: wire import ${symbols[0]}, then "fields": {"LCSC": "${part.code}"} on the part`,
        ]
      : [`no KiCad symbol named after ${part.mpn}: look for one with wire parts, else write the block from the datasheet's pin table`];
  return {
    code: 0,
    text: [
      `${part.code}: ${part.mpn}${part.brand ? ` (${part.brand})` : ''}, ${part.package}, ${part.kind}, ${part.stock > 0 ? `${part.stock} in stock` : 'OUT OF STOCK'}`,
      `${part.category}: ${part.description}`,
      ...(part.prices.length > 0 ? [`price (USD): ${part.prices.map((p) => `${p.from}+ ${p.price}`).join(', ')}`] : []),
      ...(part.datasheet ? [`datasheet: ${part.datasheet}`] : []),
      ...(part.url ? [`LCSC: ${part.url}`] : []),
      ...use,
    ].join('\n'),
  };
}

/** `wire show NAME [--dir dir]`: a part's pins, and where they are on the grid. `NAME` may be a KiCad `Library:Name` or an LCSC code. */
export async function show(name: string, dir: string): Promise<Output> {
  if (/^C\d+$/.test(name)) return showJlc(name);
  if (name.includes(':')) return { code: 0, text: [`(KiCad symbol, not in the project: wire import ${name})`, ...blockText(name, kicadBlock(name))].join('\n') };
  const found = partsOf(dir).get(name);
  if (!found) return fail(`unknown part "${name}": see wire parts`);
  const { part, source } = found;
  if (part.kind === 'block') return { code: 0, text: [`(${source})`, ...blockText(name, part)].join('\n') };
  const lines = [
    part.kind === 'tile'
      ? `${name}: tile, references ${part.ref}1, ${part.ref}2…, default value ${part.value}: ${part.description} (${source})`
      : `${name}: power symbol${part.flag ? ' (flag: tells the ERC its net is driven; takes no net)' : part.net ? `, net ${part.net}` : ', "net" required'}: ${part.description} (${source})`,
    ...(part.kind === 'tile' && part.footprintFilters ? [`footprint filters: ${part.footprintFilters.join(' ')}`] : []),
    'pins (number name: side, per rotation):',
  ];
  for (const rot of [0, 90, 180, 270]) {
    lines.push(`  rot ${String(rot).padEnd(3)}: ${part.pins.map((pin) => `${pin.number}${pin.name ? ` ${pin.name}` : ''}: ${turnSide(pin.side, rot)}`).join(', ')}`);
  }
  return { code: 0, text: lines.join('\n') };
}

/** `wire schema part|sheet|project`: the JSON Schema of a file kind. */
export function schema(kind: string): Output {
  const schemas = jsonSchemas();
  if (!Object.hasOwn(schemas, kind)) return fail(`unknown file kind "${kind}": one of ${Object.keys(schemas).join(', ')}`);
  return { code: 0, text: schemas[kind as keyof typeof schemas].trimEnd() };
}
