import { z } from 'zod';
import { BlockCellSchema, LabelCellSchema, RunCellSchema, TextCellSchema, TileCellSchema, WireCellSchema, type CellItem } from './cells.ts';
import { FrameSchema, SheetSchema, type Sheet } from './project.ts';
import { KeySchema } from './primitives.ts';

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Each kind of cell, recognised by the key naming it. */
const CELL_SCHEMAS = {
  tile: TileCellSchema,
  block: BlockCellSchema,
  wire: WireCellSchema,
  run: RunCellSchema,
  label: LabelCellSchema,
  text: TextCellSchema,
} as const;

function format(error: z.ZodError, prefix: string): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.reduce<string>((out, key) => (typeof key === 'number' ? `${out}[${key}]` : `${out}${out ? '.' : ''}${String(key)}`), prefix);
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/** Validates any file kind, with errors as `path: message` lines. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): Result<z.infer<S>> {
  const result = schema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: format(result.error, '') };
}

const SheetShellSchema = SheetSchema.extend({
  frames: z.record(KeySchema, FrameSchema.extend({ cells: z.array(z.unknown()).max(5_000) })),
});

/** Validates one cell against the schema of its kind, recognised by its key. */
function parseCell(cell: unknown, where: string): Result<CellItem> {
  const kinds = typeof cell === 'object' && cell !== null ? Object.keys(CELL_SCHEMAS).filter((key) => Object.hasOwn(cell, key)) : [];
  if (kinds.length !== 1) return { ok: false, errors: [`${where}: a cell has exactly one of the keys ${Object.keys(CELL_SCHEMAS).join(', ')}`] };
  const result = CELL_SCHEMAS[kinds[0] as keyof typeof CELL_SCHEMAS].safeParse(cell);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: format(result.error, where) };
}

/**
 * Validates a sheet file. Each cell is checked against the schema of its kind (`tile`, `block`, `wire`,
 * `run`, `label`, `text`), so an error names what is wrong in that kind of cell instead of listing every
 * kind it could have been.
 */
export function parseSheet(value: unknown): Result<Sheet> {
  const shell = SheetShellSchema.safeParse(value);
  if (!shell.success) return { ok: false, errors: format(shell.error, '') };
  const errors: string[] = [];
  const frames: Sheet['frames'] = {};
  for (const [key, frame] of Object.entries(shell.data.frames)) {
    const cells: CellItem[] = [];
    frame.cells.forEach((cell, index) => {
      const result = parseCell(cell, `frames.${key}.cells[${index}]`);
      if (result.ok) cells.push(result.value);
      else errors.push(...result.errors);
    });
    frames[key] = { ...frame, cells };
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { ...shell.data, frames } };
}
