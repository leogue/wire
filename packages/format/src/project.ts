import { z } from 'zod';
import { CellItemSchema } from './cells.ts';
import { CellSchema, KeySchema, ProductionSchema, RefPrefixSchema, SchemaHintSchema, multilineText, text } from './primitives.ts';

/**
 * A project folder:
 *
 *   project.json        name, sheet order, production defaults
 *   sheets/<name>.json  one page each, made of frames
 *   parts/<Name>.json   the project's own tiles and blocks (see part.ts)
 *
 * Nets are named by labels, power symbols and the `nets` of label-mode blocks: the same name is the same
 * net everywhere in the project. References are unique across the project, except for the units of one
 * block, which may sit in different frames or sheets.
 */

/**
 * One function of the design (buck converter, input protection, MCU core) on its own grid, placed on the
 * sheet by its top-left cell: moving the frame moves its content. Row 0 holds the title; the size comes
 * from the content. No wire leaves a frame: frames connect through labels and power symbols.
 */
export const FrameSchema = z.strictObject({
  title: text(64),
  at: CellSchema,
  /** `false` draws neither the border nor the title (a small group such as an indicator LED). Default `true`. */
  border: z.boolean().optional(),
  cells: z.array(CellItemSchema).max(5_000),
});

/** A note written on the sheet, outside the frames. */
export const SheetNoteSchema = z.strictObject({
  at: CellSchema,
  text: multilineText(1_000),
});

export const SheetSchema = z.strictObject({
  $schema: SchemaHintSchema,
  title: text(64),
  /** Landscape paper; A4 by default. */
  paper: z.enum(['A4', 'A3', 'A2']).optional(),
  /** Frames by key (`buck`, `usb-input`), the name messages and tools use. */
  frames: z.record(KeySchema, FrameSchema),
  notes: z.array(SheetNoteSchema).max(256).optional(),
});

export const ProjectSchema = z.strictObject({
  $schema: SchemaHintSchema,
  name: text(128),
  description: multilineText(2_000).optional(),
  /** Sheet files, in page order: `["power", "mcu"]` for `sheets/power.json`, `sheets/mcu.json`. */
  sheets: z
    .array(KeySchema)
    .min(1)
    .max(64)
    .refine((sheets) => new Set(sheets).size === sheets.length, 'a sheet is listed twice'),
  /** Production data per reference prefix (`{"C": {"footprint": "Capacitor_SMD:C_0402_1005Metric"}}`); a part's own values win. */
  defaults: z.record(RefPrefixSchema, z.strictObject(ProductionSchema)).optional(),
});

export type Frame = z.infer<typeof FrameSchema>;
export type SheetNote = z.infer<typeof SheetNoteSchema>;
export type Sheet = z.infer<typeof SheetSchema>;
export type Project = z.infer<typeof ProjectSchema>;
