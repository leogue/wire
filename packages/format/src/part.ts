import { z } from 'zod';
import {
  DatasheetSchema,
  FootprintIdSchema,
  HALF_CELL_MM,
  NetNameSchema,
  PinNameSchema,
  PinNumberSchema,
  PinTypeSchema,
  PointSchema,
  RefPrefixSchema,
  SchemaHintSchema,
  SideSchema,
  text,
} from './primitives.ts';

/**
 * A library file `<name>.json` describes one part, of one of three kinds:
 * - `tile`: a basic component drawn by hand inside one cell (resistor, capacitor, diode, transistor…);
 * - `power`: a power or ground symbol, one cell, whose pin joins a global net;
 * - `block`: an IC or connector, spanning several cells; it is not drawn, only its pins are listed.
 *
 * The file name is the part name. Built-in tiles live in `@wire/library`; a project's own parts in `parts/`.
 */

const StrokeWidthSchema = z.number().positive().max(2);
const FillSchema = z.enum(['none', 'outline', 'background']);

/** One shape of a tile's drawing, in millimetres from the cell centre (y up). Everything stays inside the cell. */
export const ShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('rect'),
    from: PointSchema,
    to: PointSchema,
    width: StrokeWidthSchema.optional(),
    fill: FillSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('polyline'),
    /** Repeat the first point to close the shape. */
    points: z.array(PointSchema).min(2).max(64),
    width: StrokeWidthSchema.optional(),
    fill: FillSchema.optional(),
  }),
  /** Circular arc through three points, as in KiCad. */
  z.strictObject({
    kind: z.literal('arc'),
    start: PointSchema,
    mid: PointSchema,
    end: PointSchema,
    width: StrokeWidthSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('circle'),
    center: PointSchema,
    radius: z.number().positive().max(HALF_CELL_MM),
    width: StrokeWidthSchema.optional(),
    fill: FillSchema.optional(),
  }),
]);

/** A pin of a 1-cell symbol: it starts at the middle of the cell side `side` (its port) and runs `length` mm inwards. */
export const TilePinSchema = z.strictObject({
  number: PinNumberSchema,
  name: PinNameSchema,
  side: SideSchema,
  type: PinTypeSchema,
  length: z.number().min(0).max(HALF_CELL_MM),
});

/** Corner or edge of the cell where a text is written; `hidden` does not show it. */
export const AnchorSchema = z.enum(['NW', 'NE', 'SW', 'SE', 'N', 'S', 'hidden']);

const TilePinsSchema = z
  .array(TilePinSchema)
  .min(1)
  .max(4)
  .refine((pins) => new Set(pins.map((pin) => pin.side)).size === pins.length, 'at most one pin per side')
  .refine((pins) => new Set(pins.map((pin) => pin.number)).size === pins.length, 'pin numbers must be unique');

const drawing = {
  $schema: SchemaHintSchema,
  description: text(256),
  keywords: z.array(text(32)).max(32).optional(),
  /** Size of the reference and value texts in mm (default 1). */
  textSize: z.number().min(0.5).max(2.54).optional(),
  graphics: z.array(ShapeSchema).max(256),
};

/**
 * A basic component drawn in one cell, at rotation 0. Its value (`10k`, `100n`) is not part of it: it is given
 * when placing it, so one `R` serves every resistor. Pin numbers are the footprint's pad numbers; a generic
 * transistor whose pins are named `B`/`C`/`E` needs a `pinmap` once it gets a footprint.
 */
export const TileSchema = z.strictObject({
  ...drawing,
  kind: z.literal('tile'),
  ref: RefPrefixSchema,
  /** Value shown when none is given at placement. */
  value: text(64),
  /** KiCad footprint filters, e.g. `R_*`. */
  footprintFilters: z.array(text(64)).max(16).optional(),
  fields: z.strictObject({ ref: AnchorSchema, value: AnchorSchema }),
  pins: TilePinsSchema,
});

/**
 * A power symbol: its single pin joins the global net named at placement (`PWR` + `+3V3`), or `net` by default
 * (`GND`). A `flag` (`PWR_FLAG`) tells KiCad's ERC that the net it touches is driven; it names no net.
 */
export const PowerSchema = z
  .strictObject({
    ...drawing,
    kind: z.literal('power'),
    net: NetNameSchema.optional(),
    flag: z.literal(true).optional(),
    fields: z.strictObject({ value: AnchorSchema }),
    pins: TilePinsSchema.refine((pins) => pins.length === 1, 'a power symbol has exactly one pin'),
  })
  .refine((power) => !(power.flag && power.net), 'a power flag names no net');

/** Name of a unit: `A`, `B`… or a function such as `PWR`, `SYS`, `PA`. */
export const UnitNameSchema = z.string().regex(/^[A-Za-z0-9_+-]{1,16}$/, 'invalid unit name');

/** Pin numbers down one side of a unit, top to bottom; `null` leaves an empty row to separate groups. */
const BlockSideSchema = z.array(PinNumberSchema.nullable()).max(512);

/** One rectangle of a block, placed on its own: the pins down its west and east sides. */
export const BlockUnitSchema = z.strictObject({ W: BlockSideSchema, E: BlockSideSchema });

/**
 * An IC or connector. `pins` is the pin table (number → name and type); `units` arrange those pins into one
 * or more rectangles. Rearranging pins or splitting a large IC by function is editing `units`; every pin of
 * the table must appear in exactly one unit. The drawing is computed, and each placement chooses its mode:
 * `wired` (one pin per cell, wires and tiles touch the pins) or `label` (2.54 mm pitch, a net name per pin).
 */
export const BlockSchema = z
  .strictObject({
    $schema: SchemaHintSchema,
    kind: z.literal('block'),
    /** KiCad symbol it was imported from (`Library:Name`): its pin table must stay KiCad's. */
    source: z.string().regex(/^[\w.+-]+:[^\s:]+$/, 'expected "Library:Name"').max(160).optional(),
    ref: RefPrefixSchema,
    value: text(64),
    description: text(1000),
    keywords: z.array(text(32)).max(32).optional(),
    footprint: FootprintIdSchema.optional(),
    datasheet: DatasheetSchema.optional(),
    pins: z.record(PinNumberSchema, z.strictObject({ name: PinNameSchema, type: PinTypeSchema })),
    units: z.record(UnitNameSchema, BlockUnitSchema),
  })
  .superRefine((block, ctx) => {
    const units = Object.entries(block.units);
    if (units.length === 0) ctx.addIssue({ code: 'custom', message: 'a block needs at least one unit', path: ['units'] });
    const seen = new Set<string>();
    for (const [name, unit] of units) {
      for (const side of ['W', 'E'] as const) {
        const slots = unit[side];
        if (slots[0] === null || slots.at(-1) === null) {
          ctx.addIssue({ code: 'custom', message: `unit "${name}" side ${side} must not start or end with an empty row`, path: ['units', name, side] });
        }
        for (const number of slots) {
          if (number === null) continue;
          if (!Object.hasOwn(block.pins, number)) {
            ctx.addIssue({ code: 'custom', message: `unit "${name}" names pin "${number}", which is not in pins`, path: ['units', name, side] });
          } else if (seen.has(number)) {
            ctx.addIssue({ code: 'custom', message: `pin "${number}" appears twice in units`, path: ['units', name, side] });
          }
          seen.add(number);
        }
      }
      if (unit.W.length + unit.E.length === 0) ctx.addIssue({ code: 'custom', message: `unit "${name}" has no pin`, path: ['units', name] });
    }
    const missing = Object.keys(block.pins).filter((number) => !seen.has(number));
    if (missing.length > 0) ctx.addIssue({ code: 'custom', message: `pins missing from units: ${missing.join(', ')}`, path: ['units'] });
  });

export const PartSchema = z.discriminatedUnion('kind', [TileSchema, PowerSchema, BlockSchema]);

export type Shape = z.infer<typeof ShapeSchema>;
export type TilePin = z.infer<typeof TilePinSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type Tile = z.infer<typeof TileSchema>;
export type Power = z.infer<typeof PowerSchema>;
export type BlockUnit = z.infer<typeof BlockUnitSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type Part = z.infer<typeof PartSchema>;
