import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlockSchema,
  DatasheetSchema,
  FootprintIdSchema,
  PinNumberSchema,
  PinTypeSchema,
  RefPrefixSchema,
  UnitNameSchema,
  type Block,
  type PinType,
} from '@wire/format';
import { child, children, parse, type Parsed } from './sexpr.ts';

/**
 * The KiCad symbol library installed with KiCad: search it, and convert a symbol into a wire block. The
 * conversion copies the data (pins, types, footprint, datasheet) and makes no design decision: a large IC
 * comes as KiCad draws it, to be split into units by whoever draws the schematic.
 */

const MAC_SYMBOLS = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols';
const PITCH_MM = 2.54;

/** The folder of `<Library>.kicad_sym` files: `KICAD_SYMBOL_DIR`, or KiCad's default location. */
export function symbolDir(): string | undefined {
  return [process.env.KICAD_SYMBOL_DIR, process.env.KICAD10_SYMBOL_DIR, MAC_SYMBOLS, '/usr/share/kicad/symbols'].find(
    (dir): dir is string => Boolean(dir) && existsSync(dir!),
  );
}

export interface SymbolSummary {
  /** `Library:Name`. */
  readonly id: string;
  readonly description: string;
  readonly keywords: string;
  readonly footprint: string;
}

/** A top-level `(symbol …)` of a library file, as text, keyed by name. */
function symbolTexts(text: string): Map<string, string> {
  const starts = [...text.matchAll(/^\t\(symbol "((?:[^"\\]|\\.)*)"/gm)];
  return new Map(
    starts.map((match, index) => [match[1]!.replace(/\\(.)/g, '$1'), text.slice(match.index, starts[index + 1]?.index ?? text.length)]),
  );
}

const property = (text: string, name: string) =>
  (new RegExp(`^\\t\\t\\(property "${name}" "((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(text)?.[1] ?? '').replace(/\\(.)/g, '$1');

/**
 * KiCad symbols whose library, name, description or keywords contain every word of `query` (ignoring case),
 * power symbols left out. Exact name matches come first.
 */
export function searchSymbols(query: string): SymbolSummary[] {
  const dir = symbolDir();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!dir || words.length === 0) return [];
  const found: SymbolSummary[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.kicad_sym')).sort()) {
    const library = file.slice(0, -'.kicad_sym'.length);
    for (const [name, text] of symbolTexts(readFileSync(join(dir, file), 'utf8'))) {
      if (/^\t\t\(power/m.test(text)) continue;
      const summary = { id: `${library}:${name}`, description: property(text, 'Description'), keywords: property(text, 'ki_keywords'), footprint: property(text, 'Footprint') };
      const haystack = `${summary.id} ${summary.description} ${summary.keywords}`.toLowerCase();
      if (words.every((word) => haystack.includes(word))) found.push(summary);
    }
  }
  const exact = (s: SymbolSummary) => (words.includes(s.id.slice(s.id.indexOf(':') + 1).toLowerCase()) ? 0 : 1);
  return found.sort((a, b) => exact(a) - exact(b));
}

interface KicadPin {
  readonly number: string;
  readonly name: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  /** Direction from the pin's end towards the body: 0 the pin is on the left, 180 right, 270 top, 90 bottom. */
  readonly angle: number;
  /** 0: common to every unit. */
  readonly unit: number;
}

/** The symbol node and its library, following `extends` to the symbol that holds the pins. */
function readSymbol(id: string): { node: Parsed; pinSource: Parsed; library: string } {
  const dir = symbolDir();
  if (!dir) throw new Error('KiCad symbol libraries not found: install KiCad 10 or set KICAD_SYMBOL_DIR');
  const colon = id.indexOf(':');
  if (colon <= 0) throw new Error(`"${id}" is not a KiCad symbol: expected Library:Name (see wire parts)`);
  const [library, name] = [id.slice(0, colon), id.slice(colon + 1)];
  const path = join(dir, `${library}.kicad_sym`);
  if (!/^[\w.+-]+$/.test(library) || !existsSync(path)) throw new Error(`no KiCad library "${library}"`);
  const texts = symbolTexts(readFileSync(path, 'utf8'));
  const text = texts.get(name);
  if (!text) throw new Error(`no symbol "${name}" in KiCad library ${library}`);
  const node = parse(text);
  // A derived symbol takes its pins from the symbol it extends, which may itself extend another.
  let pinSource = node;
  for (let depth = 0; ; depth++) {
    const parent = child(pinSource, 'extends')?.[1];
    if (parent === undefined) break;
    const parentText = texts.get(String(parent));
    if (!parentText || depth > 8) throw new Error(`${id} extends "${String(parent)}", which is missing from ${library}`);
    pinSource = parse(parentText);
  }
  return { node, pinSource, library };
}

/** KiCad text markup kept readable: `V_{SS}` → `VSS`; overbars `~{RESET}` stay (KiCad draws them). `~` alone is no name. */
const cleanName = (name: string) => (name === '~' ? '' : name.replace(/_\{([^}]*)\}/g, '$1'));

function pinsOf(source: Parsed, id: string): KicadPin[] {
  const pins: KicadPin[] = [];
  const seen = new Map<string, string>();
  for (const unit of children(source, 'symbol')) {
    // Sub-symbols are named <name>_<unit>_<body style>; body style 2 is the De Morgan drawing of the same pins.
    const [, unitText, style] = /_(\d+)_(\d+)$/.exec(String(unit[1])) ?? [];
    if (unitText === undefined || style === '2') continue;
    for (const pin of children(unit, 'pin')) {
      const at = child(pin, 'at') ?? [];
      const number = String(child(pin, 'number')?.[1] ?? '');
      const name = cleanName(String(child(pin, 'name')?.[1] ?? ''));
      if (seen.has(number)) {
        if (seen.get(number) !== name) throw new Error(`${id}: pin ${number} appears twice, as "${seen.get(number)}" and "${name}"`);
        continue;
      }
      seen.set(number, name);
      pins.push({ number, name, type: String(pin[1]), x: Number(at[1]), y: Number(at[2]), angle: Number(at[3] ?? 0), unit: Number(unitText) });
    }
  }
  return pins;
}

/** Pins of one side, top to bottom, with one empty row (`null`) where the KiCad drawing leaves a gap. */
function side(pins: readonly KicadPin[]): (string | null)[] {
  const out: (string | null)[] = [];
  let last: number | undefined;
  for (const pin of [...pins].sort((a, b) => b.y - a.y || a.number.localeCompare(b.number, 'en', { numeric: true }))) {
    const row = Math.round(-pin.y / PITCH_MM);
    if (last !== undefined && row > last + 1) out.push(null);
    out.push(pin.number);
    last = last === undefined ? row : Math.max(row, last + 1);
  }
  return out;
}

/** West and east sides of a unit, as KiCad draws it; top and bottom pins go to the side with fewer rows. */
function unitSides(pins: readonly KicadPin[]) {
  const west = side(pins.filter((pin) => pin.angle === 0));
  const east = side(pins.filter((pin) => pin.angle === 180));
  const across = (angle: number) => [...pins.filter((pin) => pin.angle === angle)].sort((a, b) => a.x - b.x).map((pin) => pin.number);
  for (const [group, first] of [[across(270), true], [across(90), false]] as const) {
    if (group.length === 0) continue;
    const target = west.length <= east.length ? west : east;
    if (first) target.unshift(...group, ...(target.length > 0 ? [null] : []));
    else target.push(...(target.length > 0 ? [null] : []), ...group);
  }
  return { W: west, E: east };
}

/** KiCad's unit letters: A … Z, then AA, AB… */
function unitLetters(index: number): string {
  return (index >= 26 ? unitLetters(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + (index % 26));
}

/** One line of printable text, as wire's text fields require. */
const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();

const valid = <T>(schema: { safeParse: (value: unknown) => { success: boolean } }, value: T): T | undefined =>
  value !== '' && schema.safeParse(value).success ? value : undefined;

/** A KiCad symbol (`Library:Name`) as a wire block, with its `source`. Throws on a symbol that does not fit. */
export function kicadBlock(id: string): Block {
  const { node, pinSource } = readSymbol(id);
  if (child(node, 'power') || child(pinSource, 'power')) throw new Error(`${id} is a power symbol: use the built-in PWR, GND and PWR_FLAG`);
  const props = new Map<string, string>();
  for (const source of [pinSource, node]) {
    for (const prop of children(source, 'property')) if (prop[2]) props.set(String(prop[1]), String(prop[2]));
  }
  const pins = pinsOf(pinSource, id);
  if (pins.length === 0) throw new Error(`${id} has no pins`);
  for (const pin of pins) {
    if (!PinNumberSchema.safeParse(pin.number).success) throw new Error(`${id}: pin number "${pin.number}" cannot be a pad number`);
    if (!PinTypeSchema.safeParse(pin.type).success) throw new Error(`${id}: pin ${pin.number} has the unknown type "${pin.type}"`);
  }

  // KiCad units 1, 2… become A, B… (or their KiCad unit names); pins common to every unit (unit 0) go to the first.
  const unitNumbers = [...new Set(pins.map((pin) => pin.unit).filter((unit) => unit > 0))].sort((a, b) => a - b);
  const kicadNames = new Map(
    children(pinSource, 'symbol').flatMap((unit) => {
      const name = child(unit, 'unit_name')?.[1];
      const number = Number(/_(\d+)_\d+$/.exec(String(unit[1]))?.[1]);
      return typeof name === 'string' && UnitNameSchema.safeParse(name).success ? [[number, name] as const] : [];
    }),
  );
  const names = unitNumbers.length === 0 ? ['A'] : unitNumbers.map((unit, index) => kicadNames.get(unit) ?? unitLetters(index));
  const units: Block['units'] = {};
  (unitNumbers.length === 0 ? [0] : unitNumbers).forEach((unit, index) => {
    units[names[index]!] = unitSides(pins.filter((pin) => pin.unit === unit || (pin.unit === 0 && index === 0)));
  });

  const block = {
    kind: 'block',
    source: id,
    ref: valid(RefPrefixSchema, props.get('Reference') ?? '') ?? 'U',
    value: oneLine(props.get('Value') ?? '').slice(0, 64) || id.slice(id.indexOf(':') + 1, id.indexOf(':') + 65),
    description: oneLine(props.get('Description') ?? '').slice(0, 1000) || id,
    ...(props.get('ki_keywords') ? { keywords: props.get('ki_keywords')!.split(/\s+/).filter(Boolean).slice(0, 32).map((word) => word.slice(0, 32)) } : {}),
    ...(valid(FootprintIdSchema, props.get('Footprint') ?? '') && { footprint: props.get('Footprint') }),
    ...(valid(DatasheetSchema, props.get('Datasheet') ?? '') && { datasheet: props.get('Datasheet') }),
    pins: Object.fromEntries(pins.map((pin) => [pin.number, { name: pin.name, type: pin.type as PinType }])),
    units,
  };
  const result = BlockSchema.safeParse(block);
  if (!result.success) throw new Error(`${id} does not fit a wire block: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  return result.data;
}

/**
 * Differences between a block's pin table and its KiCad source: names and numbers must be the same; a
 * different type is reported apart, since a datasheet may justify it.
 */
export function compareWithSource(block: Block): { errors: string[]; types: string[] } {
  if (!block.source) return { errors: [], types: [] };
  const kicad = kicadBlock(block.source).pins;
  const errors: string[] = [];
  const types: string[] = [];
  for (const [number, pin] of Object.entries(kicad)) {
    const own = block.pins[number];
    if (!own) errors.push(`pin ${number} (${pin.name}) of ${block.source} is missing`);
    else if (own.name !== pin.name) errors.push(`pin ${number} is named "${own.name}", "${pin.name}" in ${block.source}`);
    else if (own.type !== pin.type) types.push(`pin ${number} (${pin.name}) is ${own.type}, ${pin.type} in ${block.source}`);
  }
  for (const number of Object.keys(block.pins)) if (!Object.hasOwn(kicad, number)) errors.push(`pin ${number} is not in ${block.source}`);
  return { errors, types };
}
