import { describe, expect, it } from 'vitest';
import type { Block, CellItem } from '@wire/format';
import { builtinParts } from '@wire/library';
import { layoutFrame, projectNets, turnSide } from '../src/index.ts';

const builtin = builtinParts();

const LDO: Block = {
  kind: 'block',
  ref: 'U',
  value: 'AP2112K-3.3',
  description: 'LDO',
  pins: {
    '1': { name: 'VIN', type: 'power_in' },
    '2': { name: 'GND', type: 'power_in' },
    '3': { name: 'EN', type: 'input' },
    '4': { name: 'NC', type: 'no_connect' },
    '5': { name: 'VOUT', type: 'power_out' },
  },
  units: { A: { W: ['1', '3', null, '2'], E: ['5', '4'] } },
};

const MCU: Block = {
  kind: 'block',
  ref: 'U',
  value: 'MCU',
  description: 'two units',
  pins: {
    '1': { name: 'VDD', type: 'power_in' },
    '2': { name: 'VSS', type: 'power_in' },
    '3': { name: 'VDD', type: 'power_in' },
    '4': { name: 'PA0', type: 'bidirectional' },
    '5': { name: 'PA1', type: 'bidirectional' },
  },
  units: { PWR: { W: ['1', '3'], E: ['2'] }, PA: { W: [], E: ['4', '5'] } },
};

const lookup = (name: string) => ({ LDO, MCU })[name as 'LDO'] ?? builtin.get(name);
const layout = (cells: CellItem[]) => layoutFrame({ title: 'Test', at: [0, 0], cells }, lookup);
const errors = (cells: CellItem[]) => layout(cells).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
const netsOf = (cells: CellItem[]) =>
  projectNets(layout(cells).groups).map((net) => `${net.name ?? '-'}: ${net.pins.map((pin) => `${pin.ref}.${pin.pin}`).join(' ')}`);

/** +3V3, a resistor and an LED to ground, in a column. */
const indicator: CellItem[] = [
  { at: [0, 1], tile: 'PWR', net: '+3V3' },
  { at: [0, 2], tile: 'R', ref: 'R1', value: '1k' },
  { at: [0, 3], tile: 'LED', ref: 'D1', value: 'RED' },
  { at: [0, 4], tile: 'GND' },
];

describe('ports', () => {
  it('connects facing ports without a wire', () => {
    expect(layout(indicator).diagnostics).toEqual([]);
    expect(netsOf(indicator)).toEqual(['+3V3: R1.1', 'GND: D1.1', '-: D1.2 R1.2']);
  });

  it('reports a port that touches nothing, or a cell without a facing port', () => {
    expect(errors([{ at: [0, 2], tile: 'R', ref: 'R1' }])).toEqual(['R1.1 at [0, 2]: side N touches nothing', 'R1.2 at [0, 2]: side S touches nothing']);
    // Turned by 90°, pin 1 faces east and pin 2 west.
    expect(errors([{ at: [0, 1], tile: 'R', ref: 'R1', rot: 90 }, { at: [1, 1], tile: 'R', ref: 'R2' }])).toEqual([
      'R1.1 at [0, 1]: side E hits R2, which has no port there',
      'R1.2 at [0, 1]: side W touches nothing',
      'R2.1 at [1, 1]: side N touches nothing',
      'R2.2 at [1, 1]: side S touches nothing',
    ]);
  });

  it('turns and flips tiles', () => {
    expect(turnSide('N', 90)).toBe('E');
    expect(turnSide('W', 270)).toBe('S');
    expect(turnSide('N', 0, 'NS')).toBe('S');
    expect(turnSide('W', 0, 'NS')).toBe('W');
    expect(turnSide('N', 90, 'NS')).toBe('W');
    // The LED upside down: its cathode (1) now faces the resistor.
    const flipped = indicator.map((cell) => ('ref' in cell && cell.ref === 'D1' ? { ...cell, flip: 'NS' as const } : cell));
    expect(netsOf(flipped)).toEqual(['+3V3: R1.1', 'GND: D1.2', '-: D1.1 R1.2']);
  });

  it('joins the sides of a wire, and keeps a crossing apart', () => {
    const tee: CellItem[] = [
      { at: [0, 1], tile: 'PWR', net: '+5V' },
      { at: [0, 2], wire: 'NSE' },
      { at: [1, 2], tile: 'R', ref: 'R1', rot: 90 },
      { at: [2, 2], tile: 'GND', rot: 270 },
      { at: [0, 3], tile: 'C', ref: 'C1' },
      { at: [0, 4], tile: 'GND' },
    ];
    expect(errors(tee)).toEqual([]);
    expect(netsOf(tee)).toEqual(['+5V: C1.1 R1.2', 'GND: C1.2 R1.1']);

    const crossing: CellItem[] = [
      { at: [1, 1], tile: 'PWR', net: '+5V' },
      { at: [0, 2], tile: 'R', ref: 'R1', rot: 90 },
      { at: [1, 2], wire: 'NS|EW' },
      { at: [2, 2], tile: 'R', ref: 'R2', rot: 90 },
      { at: [1, 3], tile: 'C', ref: 'C1' },
      { at: [1, 4], tile: 'GND' },
    ];
    expect(netsOf(crossing)).toEqual([
      '+5V: C1.1',
      'GND: C1.2',
      '-: R1.1 R2.2',
      '-: R1.2',
      '-: R2.1',
    ]);
  });

  it('fills a run with straight wires', () => {
    const run: CellItem[] = [
      { at: [0, 1], tile: 'PWR', net: '+5V', rot: 270 },
      { run: [[1, 1], [3, 1]] },
      { at: [4, 1], tile: 'R', ref: 'R1', rot: 90 },
      { at: [5, 1], tile: 'GND', rot: 270 },
    ];
    expect(errors(run)).toEqual([]);
    expect(netsOf(run)).toEqual(['+5V: R1.2', 'GND: R1.1']);
  });
});

describe('placement', () => {
  it('refuses two elements in one cell and content in the title row', () => {
    expect(errors([...indicator, { at: [0, 2], wire: 'NS' }])).toContain('wire NS at [0, 2]: cell [0, 2] is already occupied by R1');
    expect(errors([{ at: [3, 0], text: 'note' }])).toEqual(["text at [3, 0]: row 0 is the frame's title row, content starts at row 1"]);
  });

  it('checks references, values and the kind of part', () => {
    expect(errors([{ at: [0, 1], tile: 'R', ref: 'C1' }, { at: [0, 2], tile: 'R' }])).toEqual(
      expect.arrayContaining(['C1 at [0, 1]: "R" takes references R1, R2…', 'R at [0, 2]: "ref" is required, e.g. "R1"']),
    );
    expect(errors([{ at: [0, 1], tile: 'R', ref: 'R1', value: '100nF' }])).toContain(
      'R1 at [0, 1]: value "100nF" is longer than 4 characters (write "100n", not "100nF"; the full specification goes in "fields")',
    );
    expect(errors([{ at: [0, 1], tile: 'GND', ref: 'R1' }, { at: [0, 3], tile: 'PWR' }])).toEqual(
      expect.arrayContaining(['R1 at [0, 1]: "ref" does not apply to a power symbol', 'PWR at [0, 3]: "net" is required, e.g. "+3V3"']),
    );
    expect(errors([{ at: [0, 1], tile: 'LDO', ref: 'U1' }])).toEqual(['U1 at [0, 1]: "LDO" is a block: place it with "block", not "tile"']);
    expect(errors([{ at: [0, 1], tile: 'Q_NPN', ref: 'Q1', pinmap: { B: '1', X: '2' } }])).toContain(
      'Q1 at [0, 1]: pinmap names pin "X", not a pin of Q_NPN (C, B, E)',
    );
  });
});

describe('blocks', () => {
  /** The LDO of the reference example, wired, with its capacitors against its pins. */
  const ldo: CellItem[] = [
    { at: [1, 1], tile: 'PWR', net: 'VIN' },
    { at: [1, 2], wire: 'NSE' },
    { at: [2, 2], wire: 'WES' },
    { at: [2, 3], wire: 'NE' },
    { at: [1, 3], tile: 'C', ref: 'C1', value: '1u' },
    { at: [1, 4], tile: 'GND' },
    { at: [3, 1], block: 'LDO', ref: 'U1', mode: 'wired' },
    { at: [2, 5], wire: 'ES' },
    { at: [2, 6], tile: 'GND' },
    { at: [5, 1], tile: 'PWR', net: 'VOUT' },
    { at: [5, 2], wire: 'WNS' },
    { at: [5, 3], tile: 'C', ref: 'C2', value: '1u' },
    { at: [5, 4], tile: 'GND' },
  ];

  it('wires a block pin by pin, its no_connect pins left free', () => {
    const result = layout(ldo);
    expect(result.diagnostics).toEqual([]);
    expect(result.size).toEqual([6, 7]);
    expect(netsOf(ldo)).toEqual([
      'GND: C1.2 C2.2 U1.2',
      'VIN: C1.1 U1.1 U1.3',
      'VOUT: C2.1 U1.5',
    ]);
  });

  it('accepts only NC in the nets of a wired block', () => {
    expect(errors([{ at: [0, 1], block: 'LDO', ref: 'U1', mode: 'wired', nets: { VIN: '+5V' } }])).toContain(
      'U1 at [0, 1]: wired block, pin VIN (1) is connected by wire: only "NC" is accepted in "nets"',
    );
  });

  it('names every pin in label mode, by name or number', () => {
    expect(errors([{ at: [0, 1], block: 'LDO', ref: 'U1', mode: 'label', nets: { VIN: '+5V' } }])).toEqual([
      'U1 at [0, 1]: pins without a net (add "unused": "NC" if intended): EN (3), GND (2), VOUT (5)',
    ]);
    const mcu: CellItem[] = [
      { at: [0, 1], block: 'MCU', unit: 'PWR', ref: 'U1', mode: 'label', nets: { VDD: '+3V3', '3': 'VDDA', VSS: 'GND' } },
      { at: [0, 6], block: 'MCU', unit: 'PA', ref: 'U1', mode: 'label', nets: { PA0: 'LED' }, unused: 'NC' },
      { at: [6, 1], tile: 'GND' },
    ];
    const result = layout(mcu);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([
      { severity: 'error', message: 'GND at [6, 1]: side N touches nothing' },
    ]);
    expect(projectNets(result.groups).map((net) => `${net.name}: ${net.pins.map((pin) => pin.pin).join(' ')}`)).toEqual([
      '+3V3: 1',
      'GND: 2',
      'LED: 4',
      'VDDA: 3',
    ]);
  });

  it('explains a wire hitting a block in label mode', () => {
    expect(errors([{ at: [0, 1], block: 'LDO', ref: 'U1', mode: 'label', unused: 'NC' }, { at: [0, 4], tile: 'R', ref: 'R1' }])).toContain(
      'R1.1 at [0, 4]: side N hits U1, which has no port there (U1 is in label mode: connect its pins through "nets", or make it "mode": "wired")',
    );
  });
});

describe('frame nets', () => {
  it('reports two names connected together', () => {
    expect(errors([{ at: [0, 1], label: 'A', side: 'E' }, { at: [1, 1], label: 'B', side: 'W' }])).toEqual(['nets A and B are connected together']);
  });
});
