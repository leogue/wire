import { HALF_CELL_MM, type Anchor, type Block, type Power, type Shape, type Tile } from '@wire/format';
import { FONT_MM, labelGeometry, turnSide, wiredGeometry, type BlockGeometry } from '@wire/core';
import { q, type Node } from './sexpr.ts';

/** Name of the project's symbol library: symbols are `wire:<name>`. */
export const LIBRARY = 'wire';

const LINE_MM = 0.254;
/** Text column, 0.5 mm from the cell edge, and top/bottom text lines. */
const TEXT_X = HALF_CELL_MM - 0.508;
const TEXT_Y = HALF_CELL_MM - FONT_MM;

type Point = readonly [number, number];
type Justify = 'left' | 'right' | undefined;

export function effects(size = FONT_MM, justify?: string, hidden = false): Node {
  return ['effects', ['font', ['size', size, size]], ...(justify ? [['justify', justify]] : []), ...(hidden ? [['hide', 'yes']] : [])];
}

/** Where a text anchor sits in a cell (y up), and how the text is justified. */
type Place = 'NW' | 'NE' | 'SW' | 'SE' | 'N' | 'S' | 'E' | 'W';
const PLACES: Record<Place, readonly [number, number, Justify]> = {
  NW: [-TEXT_X, TEXT_Y, 'left'],
  NE: [TEXT_X, TEXT_Y, 'right'],
  SW: [-TEXT_X, -TEXT_Y, 'left'],
  SE: [TEXT_X, -TEXT_Y, 'right'],
  N: [0, TEXT_Y, undefined],
  S: [0, -TEXT_Y, undefined],
  // A centred text turned sideways (a power symbol pointing east or west) runs outwards, past the symbol.
  E: [TEXT_X, 0, 'left'],
  W: [-TEXT_X, 0, 'right'],
};
const TURN: Record<Place, Place> = { NW: 'NE', NE: 'SE', SE: 'SW', SW: 'NW', N: 'E', E: 'S', S: 'W', W: 'N' };
const MIRROR: Record<'NS' | 'EW', Record<Place, Place>> = {
  NS: { NW: 'SW', SW: 'NW', NE: 'SE', SE: 'NE', N: 'S', S: 'N', E: 'E', W: 'W' },
  EW: { NW: 'NE', NE: 'NW', SW: 'SE', SE: 'SW', N: 'N', S: 'S', E: 'W', W: 'E' },
};

/** A text field of a symbol: offset from the symbol origin (y up), justification, visibility, size. */
export interface Field {
  readonly at: Point;
  readonly justify?: string;
  readonly hidden: boolean;
  readonly size: number;
}

/** A tile's text anchor once the tile is flipped and turned: texts stay upright and move round the cell with the drawing. */
function tileField(anchor: Anchor, rot: number, flip: 'NS' | 'EW' | undefined, size: number): Field {
  if (anchor === 'hidden') return { at: [0, 0], hidden: true, size };
  let place: Place = flip ? MIRROR[flip][anchor] : anchor;
  for (let turn = 0; turn < rot; turn += 90) place = TURN[place];
  const [x, y, justify] = PLACES[place];
  return { at: [x, y], ...(justify && { justify }), hidden: false, size };
}

const HIDDEN: Field = { at: [0, 0], hidden: true, size: FONT_MM };

/** One drawing of a tile or power symbol, after its flip, rotation and pin renumbering. */
export interface TileSymbol {
  readonly name: string;
  readonly part: Tile | Power;
  readonly rot: number;
  readonly flip?: 'NS' | 'EW';
  /** Symbol pin → pad, renumbering the drawn pins. */
  readonly pinmap?: Readonly<Record<string, string>>;
  readonly refField: Field;
  readonly valueField: Field;
}

/** The symbol a placed tile uses: `R`, or a variant such as `R__r90`, `LED__fNS`, `Q_NPN__p2-1-3`. */
export function tileSymbol(name: string, part: Tile | Power, rot: number, flip?: 'NS' | 'EW', pinmap?: Readonly<Record<string, string>>): TileSymbol {
  const pads = pinmap && part.pins.map((pin) => pinmap[pin.number] ?? pin.number).join('-');
  const variant = `${name}${rot ? `__r${rot}` : ''}${flip ? `__f${flip}` : ''}${pads ? `__p${pads}` : ''}`;
  const size = part.textSize ?? 1;
  return {
    name: variant,
    part,
    rot,
    ...(flip && { flip }),
    ...(pinmap && { pinmap }),
    refField: part.kind === 'tile' ? tileField(part.fields.ref, rot, flip, size) : HIDDEN,
    valueField: tileField(part.fields.value, rot, flip, size),
  };
}

function transform(point: Point, rot: number, flip?: 'NS' | 'EW'): Point {
  let [x, y] = point;
  if (flip === 'NS') y = -y;
  if (flip === 'EW') x = -x;
  for (let turn = 0; turn < rot; turn += 90) [x, y] = [y, -x];
  return [x, y];
}

function shapeNode(shape: Shape, move: (point: Point) => Point): Node {
  const stroke: Node = ['stroke', ['width', shape.width ?? LINE_MM], ['type', 'default']];
  const fill: Node = ['fill', ['type', 'fill' in shape && shape.fill ? shape.fill : 'none']];
  switch (shape.kind) {
    case 'rect':
      return ['rectangle', ['start', ...move(shape.from)], ['end', ...move(shape.to)], stroke, fill];
    case 'polyline':
      return ['polyline', ['pts', ...shape.points.map((point) => ['xy', ...move(point)])], stroke, fill];
    case 'arc':
      return ['arc', ['start', ...move(shape.start)], ['mid', ...move(shape.mid)], ['end', ...move(shape.end)], stroke, fill];
    case 'circle':
      return ['circle', ['center', ...move(shape.center)], ['radius', shape.radius], stroke, fill];
  }
}

/** Pin end on a cell side, and the direction from there towards the centre (KiCad pin angle). */
const PIN_AT = { N: [[0, HALF_CELL_MM], 270], S: [[0, -HALF_CELL_MM], 90], E: [[HALF_CELL_MM, 0], 180], W: [[-HALF_CELL_MM, 0], 0] } as const;

function property(key: string, value: string, field: Field, origin: Point = [0, 0], flipY = 1): Node {
  return ['property', q(key), q(value), ['at', origin[0] + field.at[0], origin[1] + flipY * field.at[1], 0], effects(field.size, field.justify, field.hidden)];
}

/** Properties shared by a symbol definition and its instances. */
export interface Properties {
  readonly ref: string;
  readonly value: string;
  readonly footprint: string;
  readonly datasheet: string;
  readonly description: string;
}

function propertyNodes(props: Properties, refField: Field, valueField: Field, origin?: Point, flipY?: number): Node[] {
  return [
    property('Reference', props.ref, refField, origin, flipY),
    property('Value', props.value, valueField, origin, flipY),
    property('Footprint', props.footprint, HIDDEN, origin, flipY),
    property('Datasheet', props.datasheet, HIDDEN, origin, flipY),
    property('Description', props.description, HIDDEN, origin, flipY),
  ];
}

export function tileSymbolNode(symbol: TileSymbol, prefix = ''): Node {
  const { part, rot, flip, pinmap } = symbol;
  const power = part.kind === 'power';
  const move = (point: Point) => transform(point, rot, flip);
  const props: Properties = {
    ref: power ? (part.flag ? '#FLG' : '#PWR') : part.ref,
    value: power ? (part.net ?? (part.flag ? 'PWR_FLAG' : '')) : part.value,
    footprint: '',
    datasheet: power ? '' : '~',
    description: part.description,
  };
  const pins = part.pins.map((pin) => {
    const [at, angle] = PIN_AT[turnSide(pin.side, rot, flip)];
    return ['pin', pin.type, 'line', ['at', ...at, angle], ['length', pin.length], ['name', q(pin.name), effects()], ['number', q(pinmap?.[pin.number] ?? pin.number), effects()]] as Node;
  });
  return [
    'symbol',
    q(prefix + symbol.name),
    ...(power ? [['power']] : []),
    ['pin_numbers', ['hide', 'yes']],
    ['pin_names', ['offset', 0], ['hide', 'yes']],
    ['exclude_from_sim', 'no'],
    ['in_bom', power ? 'no' : 'yes'],
    ['on_board', power ? 'no' : 'yes'],
    ...propertyNodes(props, symbol.refField, symbol.valueField),
    ...(part.keywords ? [property('ki_keywords', part.keywords.join(' '), HIDDEN)] : []),
    ...(part.kind === 'tile' && part.footprintFilters ? [property('ki_fp_filters', part.footprintFilters.join(' '), HIDDEN)] : []),
    ['symbol', q(`${symbol.name}_0_1`), ...part.graphics.map((shape) => shapeNode(shape, move))],
    ['symbol', q(`${symbol.name}_1_1`), ...pins],
    ['embedded_fonts', 'no'],
  ];
}

/** Fields of a block, above its body (y up from the body's top-left corner). */
export const BLOCK_REF_FIELD: Field = { at: [0, 3.302], justify: 'left', hidden: false, size: FONT_MM };
export const BLOCK_VALUE_FIELD: Field = { at: [0, FONT_MM], justify: 'left', hidden: false, size: FONT_MM };

/** One drawing of a block: the mode of each of its units, in unit order (`w` wired, `l` label). */
export interface BlockSymbol {
  readonly name: string;
  readonly block: Block;
  readonly modes: readonly ('wired' | 'label')[];
}

export function blockSymbol(name: string, block: Block, modes: readonly ('wired' | 'label')[]): BlockSymbol {
  return { name: `${name}__${modes.map((mode) => mode[0]).join('')}`, block, modes };
}

/** Geometry of a unit in the symbol, which does not depend on the nets of a placement. */
export function unitGeometry(block: Block, unit: string, mode: 'wired' | 'label'): BlockGeometry {
  return mode === 'wired' ? wiredGeometry(block, block.units[unit]!) : labelGeometry(block, block.units[unit]!, new Map(), '', '');
}

export function blockSymbolNode(symbol: BlockSymbol, prefix = ''): Node {
  const { block } = symbol;
  const units = Object.keys(block.units).map((unit, index) => {
    const geometry = unitGeometry(block, unit, symbol.modes[index]!);
    const [x0, y0, width, height] = geometry.body;
    const pins = geometry.pins.map((pin) => {
      const { type } = block.pins[pin.number]!;
      return [
        'pin',
        type,
        'line',
        ['at', pin.tip[0] - x0, y0 - pin.tip[1], pin.side === 'W' ? 0 : 180],
        ['length', geometry.pinLength],
        ['name', q(pin.name), effects(1)],
        ['number', q(pin.number), effects(1)],
      ] as Node;
    });
    return ['symbol', q(`${symbol.name}_${index + 1}_1`), ['rectangle', ['start', 0, 0], ['end', width, -height], ['stroke', ['width', LINE_MM], ['type', 'default']], ['fill', ['type', 'background']]], ...pins] as Node;
  });
  const props: Properties = { ref: block.ref, value: block.value, footprint: block.footprint ?? '', datasheet: block.datasheet ?? '~', description: block.description };
  return [
    'symbol',
    q(prefix + symbol.name),
    ['pin_names', ['offset', 0.508]],
    ['exclude_from_sim', 'no'],
    ['in_bom', 'yes'],
    ['on_board', 'yes'],
    ...propertyNodes(props, BLOCK_REF_FIELD, BLOCK_VALUE_FIELD),
    ...(block.keywords ? [property('ki_keywords', block.keywords.join(' '), HIDDEN)] : []),
    ...units,
    ['embedded_fonts', 'no'],
  ];
}

/** Properties of a placed symbol: positions relative to its origin on the sheet (y down). */
export function instanceProperties(props: Properties, refField: Field, valueField: Field, origin: Point, fields: Readonly<Record<string, string>>): Node[] {
  return [...propertyNodes(props, refField, valueField, origin, -1), ...Object.entries(fields).map(([key, value]) => property(key, value, HIDDEN, origin, -1))];
}
