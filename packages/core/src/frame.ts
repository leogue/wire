import type { Block, BlockCell, Cell, Frame, Part, Power, Side, Tile, TileCell, TilePin } from '@wire/format';
import {
  OPPOSITE,
  STEP,
  labelCells,
  labelGeometry,
  maxTileText,
  noteSize,
  titleCells,
  wiredGeometry,
  type BlockGeometry,
} from './geometry.ts';
import { frameGroups, type NetGroup } from './nets.ts';

export interface Diagnostic {
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

/** Finds a part by name: the project's `parts/` first, then the built-in library. */
export type PartLookup = (name: string) => Part | undefined;

type Production = Pick<TileCell, 'footprint' | 'fields' | 'dnp'>;

export interface PlacedTile extends Production {
  readonly kind: 'tile';
  readonly at: Cell;
  readonly name: string;
  readonly part: Tile;
  readonly ref: string;
  readonly value: string;
  readonly rot: 0 | 90 | 180 | 270;
  readonly flip?: 'NS' | 'EW';
  readonly pinmap?: Readonly<Record<string, string>>;
  /** Pin on each side, after flip and rotation. */
  readonly sides: ReadonlyMap<Side, TilePin>;
}

export interface PlacedPower {
  readonly kind: 'power';
  readonly at: Cell;
  readonly name: string;
  readonly part: Power;
  /** Net it joins; absent for a power flag, which joins whatever it touches. */
  readonly net?: string;
  readonly rot: 0 | 90 | 180 | 270;
  readonly flip?: 'NS' | 'EW';
  readonly sides: ReadonlyMap<Side, TilePin>;
}

export interface PlacedBlock extends Production {
  readonly kind: 'block';
  readonly at: Cell;
  readonly name: string;
  readonly block: Block;
  readonly unit: string;
  readonly ref: string;
  readonly value: string;
  readonly mode: 'wired' | 'label';
  readonly geometry: BlockGeometry;
  /** Pin number → net name, or `NC`. In wired mode only `NC` pins appear: the others are wired. */
  readonly nets: ReadonlyMap<string, string>;
}

export interface PlacedWire {
  readonly kind: 'wire';
  readonly at: Cell;
  /** `["NSE"]`, or `["NS", "EW"]` for two wires crossing without connection. */
  readonly groups: readonly string[];
}

export interface PlacedLabel {
  readonly kind: 'label';
  readonly at: Cell;
  readonly name: string;
  readonly side: 'W' | 'E';
  readonly cols: number;
}

export interface PlacedText {
  readonly kind: 'text';
  readonly at: Cell;
  readonly text: string;
  readonly size: readonly [number, number];
}

export type Element = PlacedTile | PlacedPower | PlacedBlock | PlacedWire | PlacedLabel | PlacedText;

/**
 * A port: the middle of a cell side, where an element connects. `node` names what it belongs to, for the
 * netlist: `pin:<ref>:<number>`, `name:<net>` (labels, power symbols), `wire:<index>` (one wire group).
 */
export interface Port {
  readonly cell: Cell;
  readonly side: Side;
  readonly node: string;
  /** How messages name it: `R1.1`, `wire`, `label PGOOD`. */
  readonly what: string;
}

interface Occupant {
  readonly element: Element;
  readonly what: string;
  readonly ports: Map<Side, Port>;
}

export interface FrameLayout {
  readonly elements: readonly Element[];
  /** Columns and rows, title row included. */
  readonly size: readonly [number, number];
  /** What each connected set of ports joins: net names and pins. */
  readonly groups: readonly NetGroup[];
  /** Every name given by a label or a label-mode pin, once per use, to spot names used once. */
  readonly names: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

const ROTATE: Record<Side, Side> = { N: 'E', E: 'S', S: 'W', W: 'N' };

/** Side of a tile pin once the tile is flipped, then turned clockwise. */
export function turnSide(side: Side, rot: number, flip?: 'NS' | 'EW'): Side {
  let out = flip && (flip === 'NS') === (side === 'N' || side === 'S') ? OPPOSITE[side] : side;
  for (let turn = 0; turn < rot; turn += 90) out = ROTATE[out];
  return out;
}

const cellText = (cell: Cell) => `[${cell[0]}, ${cell[1]}]`;
const key = (cell: Cell) => `${cell[0]},${cell[1]}`;

/**
 * Places a frame's cells on its own grid and checks them: every cell holds one element, every port touches
 * a facing port, parts and their fields are valid. Problems are reported, never thrown: the layout is always
 * returned, with its diagnostics. Messages do not say which frame: the sheet adds that.
 */
export function layoutFrame(frame: Frame, lookup: PartLookup): FrameLayout {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string) => diagnostics.push({ severity: 'error', message });
  const elements: Element[] = [];
  const cells = new Map<string, Occupant>();

  function occupy(element: Element, what: string, from: Cell, size: readonly [number, number], ports: readonly Port[] = []) {
    for (let dc = 0; dc < size[0]; dc++) {
      for (let dr = 0; dr < size[1]; dr++) {
        const cell: Cell = [from[0] + dc, from[1] + dr];
        const other = cells.get(key(cell));
        if (other) {
          error(`${what} at ${cellText(from)}: cell ${cellText(cell)} is already occupied by ${other.what}`);
          continue;
        }
        cells.set(key(cell), { element, what, ports: new Map(ports.filter((port) => key(port.cell) === key(cell)).map((port) => [port.side, port])) });
      }
    }
    if (from[1] === 0) error(`${what} at ${cellText(from)}: row 0 is the frame's title row, content starts at row 1`);
    elements.push(element);
  }

  for (const cell of frame.cells) {
    if ('run' in cell) {
      const [[c1, r1], [c2, r2]] = cell.run;
      const sides = r1 === r2 ? 'EW' : 'NS';
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) addWire([c, r], sides);
      }
    } else if ('wire' in cell) addWire(cell.at, cell.wire);
    else if ('label' in cell) {
      const cols = labelCells(cell.label);
      const from: Cell = cell.side === 'W' ? cell.at : [cell.at[0] - cols + 1, cell.at[1]];
      const what = `label ${cell.label}`;
      occupy({ kind: 'label', at: cell.at, name: cell.label, side: cell.side, cols }, what, from, [cols, 1], [
        { cell: cell.at, side: cell.side, node: `name:${cell.label}`, what },
      ]);
    } else if ('text' in cell) {
      const size = noteSize(cell.text);
      occupy({ kind: 'text', at: cell.at, text: cell.text, size }, 'text', cell.at, size);
    } else if ('tile' in cell) addTile(cell);
    else addBlock(cell);
  }

  function addWire(at: Cell, spec: string) {
    const index = elements.length;
    const groups = spec.split('|');
    const ports = groups.flatMap((group, g) => [...group].map((side) => ({ cell: at, side: side as Side, node: `wire:${index}:${g}`, what: 'wire' })));
    occupy({ kind: 'wire', at, groups }, `wire ${spec}`, at, [1, 1], ports);
  }

  function sidesOf(pins: readonly TilePin[], rot: number, flip?: 'NS' | 'EW') {
    return new Map(pins.map((pin) => [turnSide(pin.side, rot, flip), pin] as const));
  }

  function addTile(cell: TileCell) {
    const part = lookup(cell.tile);
    const where = `${cell.ref ?? cell.tile} at ${cellText(cell.at)}`;
    if (!part) return error(`${where}: unknown tile "${cell.tile}"`);
    if (part.kind === 'block') return error(`${where}: "${cell.tile}" is a block: place it with "block", not "tile"`);
    const rot = cell.rot ?? 0;
    const sides = sidesOf(part.pins, rot, cell.flip);
    if (part.kind === 'power') {
      for (const field of ['ref', 'value', 'pinmap', 'footprint', 'fields', 'dnp'] as const) {
        if (cell[field] !== undefined) error(`${where}: "${field}" does not apply to a power symbol`);
      }
      if (part.flag && cell.net) error(`${where}: a power flag takes no "net": it joins the net it touches`);
      const net = part.flag ? undefined : (cell.net ?? part.net);
      if (!part.flag && !net) error(`${where}: "net" is required, e.g. "+3V3"`);
      const centred = part.fields.value === 'N' || part.fields.value === 'S';
      const limit = maxTileText(centred, part.textSize ?? 1);
      if (net && part.fields.value !== 'hidden' && net.length > limit) error(`${where}: net name "${net}" is longer than ${limit} characters: use a label`);
      const what = net ?? cell.tile;
      const node = net ? `name:${net}` : `flag:${elements.length}`;
      const ports = [...sides.keys()].map((side) => ({ cell: cell.at, side, node, what }));
      return occupy({ kind: 'power', at: cell.at, name: cell.tile, part, ...(net && { net }), rot, ...(cell.flip && { flip: cell.flip }), sides }, what, cell.at, [1, 1], ports);
    }
    if (cell.net !== undefined) error(`${where}: "net" only applies to power symbols`);
    if (!cell.ref) return error(`${where}: "ref" is required, e.g. "${part.ref}1"`);
    const ref = cell.ref;
    if (ref.replace(/[0-9]+$/, '') !== part.ref) error(`${where}: "${cell.tile}" takes references ${part.ref}1, ${part.ref}2…`);
    const value = cell.value ?? part.value;
    for (const [what, text, anchor] of [['reference', ref, part.fields.ref], ['value', value, part.fields.value]] as const) {
      const limit = maxTileText(anchor === 'N' || anchor === 'S', part.textSize ?? 1);
      if (anchor !== 'hidden' && text.length > limit) error(`${where}: ${what} "${text}" is longer than ${limit} characters (write "100n", not "100nF"; the full specification goes in "fields")`);
    }
    for (const pin of Object.keys(cell.pinmap ?? {})) {
      if (!part.pins.some((p) => p.number === pin)) error(`${where}: pinmap names pin "${pin}", not a pin of ${cell.tile} (${part.pins.map((p) => p.number).join(', ')})`);
    }
    const ports = [...sides].map(([side, pin]) => ({ cell: cell.at, side, node: `pin:${ref}:${pin.number}`, what: `${ref}.${pin.number}` }));
    occupy(
      {
        kind: 'tile',
        at: cell.at,
        name: cell.tile,
        part,
        ref,
        value,
        rot,
        sides,
        ...(cell.flip && { flip: cell.flip }),
        ...(cell.pinmap && { pinmap: cell.pinmap }),
        ...production(cell),
      },
      ref,
      cell.at,
      [1, 1],
      ports,
    );
  }

  function addBlock(cell: BlockCell) {
    const part = lookup(cell.block);
    const where = `${cell.ref} at ${cellText(cell.at)}`;
    if (!part) return error(`${where}: unknown block "${cell.block}"`);
    if (part.kind !== 'block') return error(`${where}: "${cell.block}" is a 1-cell ${part.kind}: place it with "tile", not "block"`);
    const unitNames = Object.keys(part.units);
    const unitName = cell.unit ?? (unitNames.length === 1 ? unitNames[0]! : undefined);
    if (unitName === undefined) return error(`${where}: "${cell.block}" has several units: "unit" is required, one of ${unitNames.join(', ')}`);
    if (!Object.hasOwn(part.units, unitName)) return error(`${where}: "${cell.block}" has no unit "${unitName}" (units: ${unitNames.join(', ')})`);
    const unit = part.units[unitName]!;
    if (cell.ref.replace(/[0-9]+$/, '') !== part.ref) error(`${where}: "${cell.block}" takes references ${part.ref}1, ${part.ref}2…`);
    const value = cell.value ?? part.value;

    const numbers = [...unit.W, ...unit.E].filter((number) => number !== null);
    const given = cell.nets ?? {};
    for (const pinKey of Object.keys(given)) {
      if (!numbers.includes(pinKey) && !numbers.some((number) => part.pins[number]!.name === pinKey)) {
        error(`${where}: no pin "${pinKey}" on ${cell.block}${unitNames.length > 1 ? ` unit ${unitName}` : ''}`);
      }
    }
    const nets = new Map<string, string>();
    const missing: string[] = [];
    for (const number of numbers) {
      const pin = part.pins[number]!;
      const net = Object.hasOwn(given, number) ? given[number] : Object.hasOwn(given, pin.name) ? given[pin.name] : undefined;
      if (net !== undefined) {
        if (cell.mode === 'wired' && net !== 'NC') error(`${where}: wired block, pin ${pin.name} (${number}) is connected by wire: only "NC" is accepted in "nets"`);
        nets.set(number, net);
      } else if (pin.type === 'no_connect' || cell.unused === 'NC') nets.set(number, 'NC');
      else if (cell.mode === 'label') missing.push(`${pin.name} (${number})`);
    }
    if (missing.length > 0) {
      error(`${where}: pins without a net (add "unused": "NC" if intended): ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`);
    }
    if (cell.mode === 'wired') for (const [number, net] of nets) if (net !== 'NC') nets.delete(number);

    const geometry = cell.mode === 'wired' ? wiredGeometry(part, unit) : labelGeometry(part, unit, nets, cell.ref, value);
    const ports: Port[] =
      cell.mode === 'wired'
        ? geometry.pins
            .filter((pin) => nets.get(pin.number) !== 'NC')
            .map((pin) => ({
              cell: [cell.at[0] + (pin.side === 'W' ? 0 : geometry.cols - 1), cell.at[1] + 1 + pin.row],
              side: pin.side,
              node: `pin:${cell.ref}:${pin.number}`,
              what: `${cell.ref}.${pin.number} (${part.pins[pin.number]!.name})`,
            }))
        : [];
    occupy(
      { kind: 'block', at: cell.at, name: cell.block, block: part, unit: unitName, ref: cell.ref, value, mode: cell.mode, geometry, nets, ...production(cell) },
      cell.ref,
      cell.at,
      [geometry.cols, geometry.rows],
      ports,
    );
  }

  // Every port touches a facing port.
  const touching: [Port, Port][] = [];
  for (const occupant of cells.values()) {
    for (const port of occupant.ports.values()) {
      const [dc, dr] = STEP[port.side];
      const next: Cell = [port.cell[0] + dc, port.cell[1] + dr];
      const other = cells.get(key(next));
      const facing = other?.ports.get(OPPOSITE[port.side]);
      if (facing) touching.push([port, facing]);
      else if (!other) error(`${port.what} at ${cellText(port.cell)}: side ${port.side} touches nothing`);
      else {
        const hint =
          other.element.kind === 'block' && other.element.mode === 'label'
            ? ` (${other.element.ref} is in label mode: connect its pins through "nets", or make it "mode": "wired")`
            : '';
        error(`${port.what} at ${cellText(port.cell)}: side ${port.side} hits ${other.what}, which has no port there${hint}`);
      }
    }
  }

  const { groups, names, diagnostics: netDiagnostics } = frameGroups(elements, touching);
  diagnostics.push(...netDiagnostics);

  let cols = titleCells(frame.title);
  let rows = 2;
  for (const cell of cells.keys()) {
    const [c, r] = cell.split(',').map(Number) as [number, number];
    cols = Math.max(cols, c + 1);
    rows = Math.max(rows, r + 1);
  }
  return { elements, size: [cols, rows], groups, names, diagnostics };
}

function production(cell: Production): Production {
  return {
    ...(cell.footprint !== undefined && { footprint: cell.footprint }),
    ...(cell.fields !== undefined && { fields: cell.fields }),
    ...(cell.dnp !== undefined && { dnp: cell.dnp }),
  };
}
