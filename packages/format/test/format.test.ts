import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlockSchema, CellItemSchema, SheetSchema, jsonSchemas, parseSheet } from '../src/index.ts';

const block = {
  kind: 'block',
  ref: 'U',
  value: 'X',
  description: 'test',
  pins: { '1': { name: 'A', type: 'input' }, '2': { name: 'B', type: 'output' } },
  units: { A: { W: ['1'], E: ['2'] } },
};

const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe('blocks', () => {
  it('accepts every pin in exactly one unit', () => {
    expect(BlockSchema.safeParse(block).success).toBe(true);
    expect(BlockSchema.safeParse({ ...block, units: { PWR: { W: ['1'], E: [] }, IO: { W: [], E: ['2'] } } }).success).toBe(true);
  });

  it('names a missing, repeated or unknown pin', () => {
    expect(issues(BlockSchema.safeParse({ ...block, units: { A: { W: ['1'], E: [] } } }))).toContain('pins missing from units: 2');
    expect(issues(BlockSchema.safeParse({ ...block, units: { A: { W: ['1', '2'], E: ['2'] } } }))).toContain('pin "2" appears twice in units');
    expect(issues(BlockSchema.safeParse({ ...block, units: { A: { W: ['1', '3'], E: ['2'] } } }))).toContain(
      'unit "A" names pin "3", which is not in pins',
    );
  });

  it('refuses a side starting or ending with an empty row', () => {
    expect(BlockSchema.safeParse({ ...block, units: { A: { W: ['1', null], E: ['2'] } } }).success).toBe(false);
  });
});

describe('cells', () => {
  it('accepts wires joining distinct sides, and the crossing', () => {
    for (const wire of ['NS', 'NE', 'NSE', 'NESW', 'NS|EW']) expect(CellItemSchema.safeParse({ at: [0, 0], wire }).success).toBe(true);
    for (const wire of ['N', 'NN', 'NSX', 'EW|NS']) expect(CellItemSchema.safeParse({ at: [0, 0], wire }).success).toBe(false);
  });

  it('accepts straight runs only', () => {
    expect(CellItemSchema.safeParse({ run: [[1, 0], [6, 0]] }).success).toBe(true);
    expect(CellItemSchema.safeParse({ run: [[1, 0], [6, 2]] }).success).toBe(false);
    expect(CellItemSchema.safeParse({ run: [[1, 0], [1, 0]] }).success).toBe(false);
  });

  it('requires a mode on blocks and reserves NC', () => {
    expect(CellItemSchema.safeParse({ at: [0, 0], block: 'X', ref: 'U1' }).success).toBe(false);
    expect(CellItemSchema.safeParse({ at: [0, 0], block: 'X', ref: 'U1', mode: 'label', nets: { '1': 'NC' } }).success).toBe(true);
    expect(CellItemSchema.safeParse({ at: [0, 0], label: 'NC', side: 'W' }).success).toBe(false);
  });

  it('refuses unknown keys', () => {
    expect(SheetSchema.safeParse({ title: 'x', frames: { a: { title: 'A', at: [0, 0], cells: [{ at: [0, 1], tile: 'R', ref: 'R1', colour: 'red' }] } } }).success).toBe(false);
  });
});

describe('parseSheet', () => {
  it('reports errors for the kind of cell it recognises, with their frame', () => {
    const sheet = {
      title: 'Power',
      frames: { buck: { title: 'Buck', at: [0, 0], cells: [{ at: [0, 1], wire: 'NX' }, { at: [0, 2], tile: 'R', ref: 'r1' }, { at: [0, 3] }] } },
    };
    expect(parseSheet(sheet)).toEqual({
      ok: false,
      errors: [
        'frames.buck.cells[0].wire: expected 2 to 4 of N, E, S, W',
        'frames.buck.cells[1].ref: invalid reference: a prefix and a number, e.g. R1',
        'frames.buck.cells[2]: a cell has exactly one of the keys tile, block, wire, run, label, text',
      ],
    });
  });

  it('refuses an invalid frame key', () => {
    expect(parseSheet({ title: 'x', frames: { Buck: { title: 'B', at: [0, 0], cells: [] } } })).toMatchObject({ ok: false });
  });
});

describe('JSON Schema files', () => {
  it('are up to date (run `npm run schema`)', () => {
    for (const [name, text] of Object.entries(jsonSchemas())) {
      expect(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8')).toBe(text);
    }
  });
});
