import { describe, expect, it } from 'vitest';
import type { Block, BlockCell, Frame, Sheet } from '@wire/format';
import { builtinParts } from '@wire/library';
import { layoutProject, layoutSheet, sheetArea } from '../src/index.ts';

const builtin = builtinParts();

const MCU: Block = {
  kind: 'block',
  ref: 'U',
  value: 'MCU',
  description: 'two units',
  pins: {
    '1': { name: 'VDD', type: 'power_in' },
    '2': { name: 'VSS', type: 'power_in' },
    '3': { name: 'PA0', type: 'bidirectional' },
  },
  units: { PWR: { W: ['1'], E: ['2'] }, PA: { W: [], E: ['3'] } },
};
const lookup = (name: string) => (name === 'MCU' ? MCU : builtin.get(name));

const indicator = (at: [number, number], n: number, net: string): Frame => ({
  title: `LED ${n}`,
  at,
  cells: [
    { at: [0, 1], tile: 'PWR', net },
    { at: [0, 2], tile: 'R', ref: `R${n}`, value: '1k' },
    { at: [0, 3], tile: 'LED', ref: `D${n}`, value: 'RED' },
    { at: [0, 4], tile: 'GND' },
  ],
});

const project = (sheets: Record<string, Sheet>) =>
  layoutProject({ name: 'Test', sheets: Object.keys(sheets) }, new Map(Object.entries(sheets)), lookup);
const messages = (sheets: Record<string, Sheet>) => project(sheets).diagnostics.map((d) => `${d.severity}: ${d.message}`);

describe('sheets', () => {
  it('gives the usable cells of each paper', () => {
    expect(sheetArea('A4')).toEqual({ cols: 25, rows: 16, titleBlock: [14, 13] });
    expect(sheetArea('A3')).toEqual({ cols: 37, rows: 25, titleBlock: [26, 22] });
  });

  it('places frames by their top-left cell, sized by their content', () => {
    const sheet = layoutSheet('power', { title: 'Power', frames: { a: indicator([3, 2], 1, '+5V') } }, lookup);
    expect(sheet.diagnostics).toEqual([]);
    expect(sheet.frames[0]).toMatchObject({ key: 'a', at: [3, 2], size: [1, 5] });
  });

  it('refuses overlapping frames, frames off the sheet or over the title block', () => {
    expect(messages({ power: { title: 'Power', frames: { a: indicator([0, 0], 1, '+5V'), b: indicator([0, 3], 2, '+5V') } } })).toEqual([
      'error: power: frame a (columns 0-0, rows 0-4) overlaps frame b (columns 0-0, rows 3-7)',
    ]);
    expect(messages({ power: { title: 'Power', frames: { a: indicator([24, 12], 1, '+5V') } } })).toEqual([
      'error: power: frame a covers columns 24-24, rows 12-16, off the A4 sheet: usable columns 0-24, rows 0-15 (or a larger paper)',
    ]);
    expect(messages({ power: { title: 'Power', frames: { a: indicator([20, 10], 1, '+5V') } } })).toEqual([
      'error: power: frame a covers columns 20-20, rows 10-14, over the title block (columns >= 14 and rows >= 13)',
    ]);
    expect(messages({ power: { title: 'Power', frames: { a: indicator([0, 0], 1, '+5V') }, notes: [{ at: [0, 2], text: 'hi' }] } })).toEqual([
      'error: power: frame a (columns 0-0, rows 0-4) overlaps note at [0, 2] (columns 0-0, rows 2-2)',
    ]);
  });

  it('names the sheet and frame of an error', () => {
    expect(messages({ power: { title: 'Power', frames: { led: { title: 'LED', at: [0, 0], cells: [{ at: [0, 1], tile: 'R', ref: 'R1' }] } } } })).toEqual([
      'error: power/led: R1.1 at [0, 1]: side N touches nothing',
      'error: power/led: R1.2 at [0, 1]: side S touches nothing',
    ]);
  });
});

describe('project', () => {
  it('joins nets by name across frames and sheets', () => {
    const result = project({
      power: { title: 'Power', frames: { a: indicator([0, 0], 1, '+5V') } },
      io: { title: 'IO', frames: { b: indicator([0, 0], 2, '+5V') } },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.nets.map((net) => `${net.name ?? '-'}: ${net.pins.map((pin) => `${pin.ref}.${pin.pin}`).join(' ')}`)).toEqual([
      '+5V: R1.1 R2.1',
      'GND: D1.1 D2.1',
      '-: D1.2 R1.2',
      '-: D2.2 R2.2',
    ]);
  });

  it('keeps references unique across the project', () => {
    expect(messages({ power: { title: 'Power', frames: { a: indicator([0, 0], 1, '+5V'), b: indicator([2, 0], 1, '+5V') } } })).toEqual([
      'error: R1 is used 2 times (power/a, power/b): references are unique, units of one block excepted',
      'error: D1 is used 2 times (power/a, power/b): references are unique, units of one block excepted',
    ]);
  });

  it('places the units of a block once each, in any frame, agreeing', () => {
    const pwr: BlockCell = { at: [0, 1], block: 'MCU', unit: 'PWR', ref: 'U1', mode: 'label', nets: { VDD: 'VCC', VSS: 'VCC' } };
    const pa: BlockCell = { at: [0, 1], block: 'MCU', unit: 'PA', ref: 'U1', mode: 'label', nets: { PA0: 'LED' } };
    const frame = (cells: Frame['cells'], at: [number, number] = [0, 0]): Frame => ({ title: 'F', at, cells });
    expect(
      messages({
        power: { title: 'Power', frames: { supply: frame([pwr]) } },
        mcu: { title: 'MCU', frames: { core: frame([pa]), led: frame([{ at: [0, 1], tile: 'GND', rot: 90 }, { at: [1, 1], tile: 'R', ref: 'R1', rot: 90 }, { at: [2, 1], label: 'LED', side: 'W' }], [10, 0]) } },
      }),
    ).toEqual([]);
    expect(messages({ power: { title: 'Power', frames: { supply: frame([pwr]) } } })).toContain(
      'error: U1: unit PA not placed: every unit of a block is placed once, in any frame',
    );
    expect(messages({ power: { title: 'Power', frames: { a: frame([pwr]), b: frame([pwr], [10, 0]), c: frame([{ ...pa, value: 'X' }], [20, 0]) } } })).toEqual(
      expect.arrayContaining([
        'error: U1: unit PWR is placed 2 times (power/a, power/b)',
        'error: U1: units disagree on "value" (power/a, power/b, power/c): set it on every unit, or on none',
      ]),
    );
  });

  it('warns about a net named only once', () => {
    const frame: Frame = { title: 'F', at: [0, 0], cells: [{ at: [0, 1], tile: 'PWR', net: '+3V3', rot: 270 }, { at: [1, 1], tile: 'R', ref: 'R1', rot: 90 }, { at: [2, 1], label: 'SDA', side: 'W' }] };
    expect(messages({ io: { title: 'IO', frames: { i2c: frame } } })).toEqual([
      'warning: io/i2c: net SDA is named only once in the project: check its spelling, or connect it',
    ]);
  });
});
