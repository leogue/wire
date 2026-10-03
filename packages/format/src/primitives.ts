import { z } from 'zod';

/** One grid cell is a square of 4 × 2.54 mm, the standard KiCad pitch. */
export const CELL_MM = 10.16;
export const HALF_CELL_MM = CELL_MM / 2;

/** Control and invisible formatting characters (including bidi overrides and zero-width characters). */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}]/u;
const UNSAFE_CHARS_EXCEPT_NEWLINE = /[^\P{Cc}\n]|\p{Cf}/u;

/** Printable single-line text, without leading or trailing whitespace. */
export function text(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !UNSAFE_CHARS.test(value), 'must not contain control or formatting characters')
    .refine((value) => value.trim() === value, 'must not start or end with whitespace');
}

/** Printable text that may span several lines (`\n`). */
export function multilineText(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !UNSAFE_CHARS_EXCEPT_NEWLINE.test(value), 'must not contain control or formatting characters');
}

/** `[column, row]`: columns grow to the right, rows grow downwards, `[0, 0]` is the top-left cell. */
export const CoordinateSchema = z.int().min(0).max(1_000);
export const CellSchema = z.tuple([CoordinateSchema, CoordinateSchema]);
export type Cell = z.infer<typeof CellSchema>;

export const SideSchema = z.enum(['N', 'E', 'S', 'W']);
export type Side = z.infer<typeof SideSchema>;

/** Clockwise rotation of a 1-cell symbol, in degrees. */
export const RotationSchema = z.literal([0, 90, 180, 270]);

/**
 * Mirror of a 1-cell symbol, applied before the rotation: `NS` swaps its north and south sides (an LED with
 * its anode at the bottom), `EW` swaps east and west (a transistor with its base on the other side).
 */
export const FlipSchema = z.enum(['NS', 'EW']);

/** A point inside a cell, in millimetres from its centre, x to the right, y up (as in KiCad symbols). */
const LocalCoordinateSchema = z.number().min(-HALF_CELL_MM).max(HALF_CELL_MM);
export const PointSchema = z.tuple([LocalCoordinateSchema, LocalCoordinateSchema]);

/** Name of a library file without `.json`: a built-in tile (`R`) or a project part (`AP2112K-3.3`). */
export const PartNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/, 'invalid part name');

/** Name of a sheet file without `.json`, or key of a frame: `power`, `usb-input`. */
export const KeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'invalid name: lowercase letters, digits, _ and -');

/** Reference prefix of a part: `R`, `C`, `U`, `SW`. */
export const RefPrefixSchema = z.string().regex(/^[A-Z]{1,4}$/, 'invalid reference prefix');

/** Reference: unique across the project, except for the units of one block, which share it. */
export const RefSchema = z.string().regex(/^[A-Z]{1,4}[1-9][0-9]{0,3}$/, 'invalid reference: a prefix and a number, e.g. R1');

/** Pin number, which is also the pad number of the footprint: `1`, `A3`, `EP`, `2+`. */
export const PinNumberSchema = z.string().regex(/^[A-Za-z0-9+-]{1,8}$/, 'invalid pin number');

/** Pin name as printed on a block: `VIN`, `~{RESET}`, `PA13`. */
export const PinNameSchema = z.string().max(64).regex(/^[^\p{Cc}\p{Cf}]*$/u, 'invalid pin name');

/** KiCad's electrical pin types. A `no_connect` pin must be left unconnected. */
export const PinTypeSchema = z.enum([
  'passive',
  'input',
  'output',
  'bidirectional',
  'tri_state',
  'power_in',
  'power_out',
  'open_collector',
  'open_emitter',
  'unspecified',
  'free',
  'no_connect',
]);
export type PinType = z.infer<typeof PinTypeSchema>;

/** Net name: `GND`, `+3V3`, `I2C_SDA`. `NC` is reserved for unconnected pins. */
export const NetNameSchema = z
  .string()
  .regex(/^[^\s\p{Cc}\p{Cf}]{1,64}$/u, 'invalid net name')
  .refine((name) => name !== 'NC', '"NC" is reserved for unconnected pins');

/** KiCad footprint `Library:Footprint`. */
export const FootprintIdSchema = z
  .string()
  .max(256)
  .regex(/^[^\s:\p{Cc}\p{Cf}]+:[^\s:\p{Cc}\p{Cf}]+$/u, 'expected "Library:Footprint"');

export const DatasheetSchema = z.url({ protocol: /^https?$/ }).max(2048);

/** Names KiCad gives a dedicated property: they cannot be custom fields. */
const RESERVED_FIELD_NAMES = new Set(['reference', 'value', 'footprint', 'datasheet', 'description']);

/** Custom field name: `MPN`, `Manufacturer`, `Spec`. */
export const FieldNameSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z]([A-Za-z0-9 _.-]*[A-Za-z0-9_.])?$/, 'invalid field name')
  .refine((name) => !RESERVED_FIELD_NAMES.has(name.toLowerCase()), 'reserved field name');

/** Hidden properties of a part, written to the KiCad netlist and the BOM. */
export const FieldsSchema = z.record(FieldNameSchema, text(256));

/** Production data any placed part accepts, also given per reference prefix in the project `defaults`. */
export const ProductionSchema = {
  footprint: FootprintIdSchema.optional(),
  fields: FieldsSchema.optional(),
  /** Do not populate: crossed out in KiCad, flagged in the BOM. */
  dnp: z.boolean().optional(),
};

/** Lets editors find the JSON Schema of a file; ignored otherwise. */
export const SchemaHintSchema = z.string().max(512).optional();
