import { z } from 'zod';
import {
  CellSchema,
  FlipSchema,
  NetNameSchema,
  PartNameSchema,
  PinNumberSchema,
  ProductionSchema,
  RefSchema,
  RotationSchema,
  multilineText,
  text,
} from './primitives.ts';
import { UnitNameSchema } from './part.ts';

/**
 * The cells of a frame, in the frame's own coordinates: `[0, 0]` is its top-left cell and row 0 holds its
 * title, so content starts at row 1. Neighbouring cells whose facing sides both carry a port are connected
 * (no wire needed); a port facing nothing is an error.
 */

/** A basic component (`tile` part) or a power symbol (`power` part), in one cell. */
export const TileCellSchema = z.strictObject({
  at: CellSchema,
  tile: PartNameSchema,
  /** Required for a component, absent for a power symbol. */
  ref: RefSchema.optional(),
  /** Short displayed value (`4.7k`, `100n`); the full specification goes in a field. */
  value: text(64).optional(),
  /** Net of a power symbol (`+3V3`); defaults to the symbol's own (`GND`). */
  net: NetNameSchema.optional(),
  rot: RotationSchema.optional(),
  flip: FlipSchema.optional(),
  /** Symbol pin → footprint pad, when they differ (`{"B": "1", "E": "2", "C": "3"}` for a SOT-23 transistor). */
  pinmap: z.record(PinNumberSchema, PinNumberSchema).optional(),
  ...ProductionSchema,
});

/** Pin of a block in `nets`: a pin number (wins) or a pin name, which applies to every pin with that name. */
const PinKeySchema = z.string().min(1).max(64);

/** One unit of a block (an IC or connector), `at` being its top-left cell. */
export const BlockCellSchema = z.strictObject({
  at: CellSchema,
  block: PartNameSchema,
  /** Required when the block has several units; each unit is placed once, with the same `ref`. */
  unit: UnitNameSchema.optional(),
  ref: RefSchema,
  value: text(64).optional(),
  /**
   * `wired`: one pin per row, on the cell edges, connected like a tile's pins (small ICs and local wiring).
   * `label`: pins on a 2.54 mm pitch, each with the net name given in `nets` (many pins going far away).
   */
  mode: z.enum(['wired', 'label']),
  /** Net of each pin, or `NC` to leave it unconnected. In wired mode, only `NC` is accepted. */
  nets: z.record(PinKeySchema, z.union([z.literal('NC'), NetNameSchema])).optional(),
  /** `NC` marks every pin not listed in `nets` as unconnected; without it, a forgotten pin is an error. */
  unused: z.literal('NC').optional(),
  ...ProductionSchema,
});

/** Sides joined by a wire at the cell centre: `NS`, `EW` (straight), `NE` (corner), `NSE` (junction). */
const WireSidesSchema = z
  .string()
  .regex(/^[NESW]{2,4}$/, 'expected 2 to 4 of N, E, S, W')
  .refine((sides) => new Set(sides).size === sides.length, 'a side appears twice');

/** A wire inside one cell. `NS|EW` is two wires crossing without connection. */
export const WireCellSchema = z.strictObject({
  at: CellSchema,
  wire: z.union([WireSidesSchema, z.literal('NS|EW')]),
});

/** Straight wires filling every cell from one end to the other, both included, along a row or a column. */
export const RunCellSchema = z.strictObject({
  run: z
    .tuple([CellSchema, CellSchema])
    .refine(([a, b]) => (a[0] === b[0]) !== (a[1] === b[1]), 'a run is horizontal or vertical, between two different cells'),
});

/**
 * A net name, with its single port on `side`; the text runs the other way, over as many cells as it needs.
 * Same name, same net, everywhere in the project.
 */
export const LabelCellSchema = z.strictObject({
  at: CellSchema,
  label: NetNameSchema,
  side: z.enum(['W', 'E']),
});

/** A design note (`\n` for new lines), over the cells it needs from `at`. */
export const TextCellSchema = z.strictObject({
  at: CellSchema,
  text: multilineText(1_000),
});

export const CellItemSchema = z.union([TileCellSchema, BlockCellSchema, WireCellSchema, RunCellSchema, LabelCellSchema, TextCellSchema]);

export type TileCell = z.infer<typeof TileCellSchema>;
export type BlockCell = z.infer<typeof BlockCellSchema>;
export type WireCell = z.infer<typeof WireCellSchema>;
export type RunCell = z.infer<typeof RunCellSchema>;
export type LabelCell = z.infer<typeof LabelCellSchema>;
export type TextCell = z.infer<typeof TextCellSchema>;
export type CellItem = z.infer<typeof CellItemSchema>;
