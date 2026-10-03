import { CELL_MM, HALF_CELL_MM, type Block, type BlockUnit, type Side } from '@wire/format';

/**
 * Sizes on the grid, in millimetres, as KiCad draws them (taken over from the wireai prototype). Inside an
 * element, positions are millimetres from the top-left corner of its first cell, y down.
 */

export const PITCH_MM = 2.54;
/** Default KiCad font size: labels, block pin texts' neighbours, notes. */
export const FONT_MM = 1.27;
/** KiCad character width / font size (measured). */
const CHAR_WIDTH = 0.94;
const MARGIN_MM = 1.27;
/** Length of a block pin in label mode. */
export const BLOCK_PIN_MM = 1.5 * PITCH_MM;
const BLOCK_PIN_TEXT_MM = 1.0;
/** Room for the reference and value above a block's body. */
const BLOCK_HEADER_MM = 2 * PITCH_MM;
const NOTE_LINE_MM = 1.7 * FONT_MM;

export const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };
export const STEP: Record<Side, readonly [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

export function textWidth(text: string, size = FONT_MM): number {
  return text.length * CHAR_WIDTH * size;
}

/** Number of cells covering `mm`. */
export function cellsFor(mm: number): number {
  return Math.ceil(mm / CELL_MM - 1e-9);
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step - 1e-9) * step;
}

/** Characters that fit in a tile's corner (`R12`, `4.7k`), and centred across it (`+3V3A`). */
export function maxTileText(centred: boolean, size: number): number {
  return centred ? Math.floor((CELL_MM - 1.016) / (CHAR_WIDTH * size)) : 4;
}

/** Length of a global label from its anchor. */
export function labelWidth(name: string): number {
  return textWidth(name) + 1.9;
}

/** Cells a label covers along its row. */
export function labelCells(name: string): number {
  return cellsFor(labelWidth(name) + MARGIN_MM);
}

/** Cells a note covers, from its top-left cell. */
export function noteSize(text: string): readonly [number, number] {
  const lines = text.split('\n');
  const cols = cellsFor(Math.max(...lines.map((line) => textWidth(line))) + 2 * MARGIN_MM);
  return [Math.max(cols, 1), cellsFor(lines.length * NOTE_LINE_MM + MARGIN_MM)];
}

/** Cells a module's title needs. */
export function titleCells(title: string): number {
  return cellsFor(textWidth(title) + PITCH_MM);
}

export interface PlacedPin {
  readonly number: string;
  readonly name: string;
  readonly side: 'W' | 'E';
  /** Row on its side, empty rows included (0 = top). */
  readonly row: number;
  /** End of the pin, where it connects. */
  readonly tip: readonly [number, number];
}

export interface BlockGeometry {
  readonly cols: number;
  readonly rows: number;
  /** `[x, y, width, height]` of the rectangle. */
  readonly body: readonly [number, number, number, number];
  readonly pinLength: number;
  readonly pins: readonly PlacedPin[];
}

function unitPins(block: Block, unit: BlockUnit) {
  return (['W', 'E'] as const).flatMap((side) =>
    unit[side].flatMap((number, row) => (number === null ? [] : [{ number, name: block.pins[number]!.name, side, row }])),
  );
}

/** Width of a unit's rectangle: room for the longest pin name on each side. */
function bodyWidth(pins: ReturnType<typeof unitPins>): number {
  const longest = (side: 'W' | 'E') => Math.max(0, ...pins.filter((pin) => pin.side === side).map((pin) => pin.name.length));
  return Math.max(4 * PITCH_MM, ceilTo((longest('W') + longest('E')) * CHAR_WIDTH * BLOCK_PIN_TEXT_MM + 2 * 0.508 + PITCH_MM, PITCH_MM));
}

/**
 * Wired mode: a header row for the reference and value, then one pin per row, its tip in the middle of the
 * west side of the first column or the east side of the last one, so it connects like a tile's pin.
 */
export function wiredGeometry(block: Block, unit: BlockUnit): BlockGeometry {
  const pins = unitPins(block, unit);
  const width = bodyWidth(pins);
  const cols = cellsFor(width + 2 * PITCH_MM);
  const pinRows = Math.max(unit.W.length, unit.E.length);
  const pinLength = (cols * CELL_MM - width) / 2;
  const first = HALF_CELL_MM - FONT_MM;
  return {
    cols,
    rows: pinRows + 1,
    body: [pinLength, CELL_MM + FONT_MM, width, 2 * first + (pinRows - 1) * CELL_MM],
    pinLength,
    pins: pins.map((pin) => ({ ...pin, tip: [pin.side === 'W' ? 0 : cols * CELL_MM, (pin.row + 1) * CELL_MM + HALF_CELL_MM] as const })),
  };
}

/**
 * Label mode: pins on the 2.54 mm pitch, each ending in a label with its net (`NC`: a cross, no label). The
 * element covers the rectangle, its pins and its labels, rounded up to whole cells; it has no grid port.
 */
export function labelGeometry(block: Block, unit: BlockUnit, nets: ReadonlyMap<string, string>, ref: string, value: string): BlockGeometry {
  const pins = unitPins(block, unit);
  const width = bodyWidth(pins);
  const pinRows = Math.max(unit.W.length, unit.E.length);
  const labels = (side: 'W' | 'E') =>
    Math.max(0, ...pins.filter((pin) => pin.side === side && nets.get(pin.number) !== 'NC').map((pin) => labelWidth(nets.get(pin.number) ?? '')));
  const x = ceilTo(BLOCK_PIN_MM + labels('W') + MARGIN_MM, PITCH_MM);
  const y = ceilTo(BLOCK_HEADER_MM + MARGIN_MM, PITCH_MM);
  const height = 2 * PITCH_MM + (pinRows - 1) * PITCH_MM;
  // References are numbered at export (U1 may become U12): leave room for 4 characters.
  const header = Math.max(textWidth(ref.padEnd(4)), textWidth(value));
  const w = Math.max(x + width + BLOCK_PIN_MM + labels('E'), x + header) + MARGIN_MM;
  return {
    cols: cellsFor(w),
    rows: cellsFor(y + height + MARGIN_MM),
    body: [x, y, width, height],
    pinLength: BLOCK_PIN_MM,
    pins: pins.map((pin) => ({
      ...pin,
      tip: [pin.side === 'W' ? x - BLOCK_PIN_MM : x + width + BLOCK_PIN_MM, y + PITCH_MM * (pin.row + 1)] as const,
    })),
  };
}
