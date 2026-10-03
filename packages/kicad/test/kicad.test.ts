import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Block, Sheet } from '@wire/format';
import { builtinParts } from '@wire/library';
import { layoutProject, loadProject } from '@wire/core';
import { dump, exportProject, kicadCli, kicadFiles, parse, q, uuidFor } from '../src/index.ts';

const hasKicad = (() => {
  try {
    return Boolean(kicadCli());
  } catch {
    return false;
  }
})();

const builtin = builtinParts();
const MCU: Block = {
  kind: 'block',
  ref: 'U',
  value: 'MCU',
  description: 'test MCU',
  footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',
  pins: {
    '1': { name: 'VDD', type: 'power_in' },
    '2': { name: 'PA0', type: 'bidirectional' },
    '3': { name: 'PA1', type: 'bidirectional' },
    '4': { name: 'VSS', type: 'power_in' },
    '5': { name: 'PA2', type: 'bidirectional' },
    '6': { name: 'NRST', type: 'input' },
  },
  units: { PWR: { W: ['1'], E: ['4'] }, IO: { W: ['6'], E: ['2', '3', '5'] } },
};
const lookup = (name: string) => (name === 'MCU' ? MCU : builtin.get(name));

/** Two sheets: turned and flipped tiles, a crossing, a junction, a block with a wired and a label unit, a pinmap. */
const sheets: Record<string, Sheet> = {
  power: {
    title: 'Power',
    frames: {
      supply: {
        title: 'MCU supply',
        at: [0, 0],
        cells: [
          { at: [0, 1], tile: 'PWR', net: '+3V3' },
          { at: [0, 2], wire: 'NSE' },
          { at: [1, 1], block: 'MCU', unit: 'PWR', ref: 'U1', mode: 'wired' },
          { at: [0, 3], tile: 'C', ref: 'C1', value: '100n' },
          { at: [0, 4], tile: 'GND' },
          { at: [3, 1], tile: 'PWR_FLAG' },
          { at: [3, 2], wire: 'WNS' },
          { at: [3, 3], tile: 'GND' },
        ],
      },
      cross: {
        title: 'Crossing',
        at: [8, 0],
        cells: [
          { at: [0, 2], tile: 'GND', rot: 90 },
          { at: [1, 2], tile: 'R', ref: 'R1', value: '330', rot: 90 },
          { at: [2, 1], tile: 'PWR', net: '+3V3' },
          { at: [2, 2], wire: 'NS|EW' },
          { at: [2, 3], tile: 'R', ref: 'R2', value: '10k' },
          { at: [2, 4], tile: 'GND' },
          { at: [3, 2], tile: 'LED', ref: 'D1', rot: 270, flip: 'NS' },
          { at: [4, 2], label: 'LED_A', side: 'W' },
        ],
      },
    },
  },
  mcu: {
    title: 'MCU',
    paper: 'A3',
    frames: {
      core: {
        title: 'MCU',
        at: [0, 0],
        cells: [{ at: [0, 1], block: 'MCU', unit: 'IO', ref: 'U1', mode: 'label', nets: { PA0: 'LED_A', PA1: 'BASE', NRST: 'NC' }, unused: 'NC' }],
      },
      driver: {
        title: 'Driver',
        at: [12, 0],
        cells: [
          { at: [0, 1], tile: 'PWR', net: '+3V3' },
          { at: [0, 2], tile: 'Q_NPN', ref: 'Q1', value: 'NPN', flip: 'EW', pinmap: { B: '1', E: '2', C: '3' } },
          { at: [0, 3], tile: 'GND' },
          { at: [1, 2], tile: 'R', ref: 'R3', value: '1k', rot: 90 },
          { at: [2, 2], label: 'BASE', side: 'W' },
        ],
      },
    },
  },
};

describe('S-expressions', () => {
  it('writes and reads KiCad text', () => {
    const text = dump(['a', 1.5, q('x "y"'), ['b', -0], ['c', ['d', 0.12345]]]);
    expect(text).toBe('(a 1.5 "x \\"y\\""\n\t(b 0)\n\t(c\n\t\t(d 0.1235)\n\t)\n)');
    expect(parse(text)).toEqual(['a', '1.5', 'x "y"', ['b', '0'], ['c', ['d', '0.1235']]]);
  });

  it('derives the same UUID from the same name', () => {
    expect(uuidFor('a').text).toBe(uuidFor('a').text);
    expect(uuidFor('a').text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('KiCad files', () => {
  const layout = layoutProject({ name: 'Test', sheets: Object.keys(sheets) }, new Map(Object.entries(sheets)), lookup);

  it('starts from a valid project', () => {
    expect(layout.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('are the same for the same project', () => {
    const files = kicadFiles({ name: 'Test', sheets: Object.keys(sheets) }, layout, 'test');
    expect(files.map((file) => file.path)).toEqual(['test.kicad_sch', 'power.kicad_sch', 'mcu.kicad_sch', 'wire.kicad_sym', 'sym-lib-table']);
    expect(kicadFiles({ name: 'Test', sheets: Object.keys(sheets) }, layout, 'test')).toEqual(files);
    const library = files.find((file) => file.path === 'wire.kicad_sym')!.text;
    for (const symbol of ['"R__r90"', '"LED__r270__fNS"', '"Q_NPN__fEW__p3-1-2"', '"MCU__wl"', '"GND"', '"PWR_FLAG"']) expect(library).toContain(symbol);
  });
});

describe.skipIf(!hasKicad)('KiCad export (needs kicad-cli)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wire-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('gives KiCad the same nets, across sheets, turns, crossings and units', () => {
    const project = { name: 'Test', sheets: Object.keys(sheets) };
    const layout = layoutProject(project, new Map(Object.entries(sheets)), lookup);
    const { schematic, differences } = exportProject(project, layout, join(dir, 'test'), 'test');
    expect(differences).toEqual([]);
    expect(existsSync(schematic)).toBe(true);
    // The transistor's pins are its footprint pads: B=1, E=2, C=3.
    expect(layout.nets.find((net) => net.name === '+3V3')!.pins.map((pin) => `${pin.ref}.${pin.pin}`)).toContain('Q1.C');
  });

  it('exports every example faithfully', () => {
    const examples = new URL('../../../examples/', import.meta.url);
    const loaded = loadProject(new URL('ldo-indicator/', examples));
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'));
    const { project, sheets, lookup } = loaded.value;
    const result = exportProject(project, layoutProject(project, sheets, lookup), join(dir, 'ldo'));
    expect(result.differences).toEqual([]);
    expect(readFileSync(join(dir, 'ldo', 'schematic.kicad_sch'), 'utf8')).toContain('(lib_id "wire:AP2112K-3.3__w")');
  });
});

describe('frame borders', () => {
  it('draws a border and a title unless "border" is false', () => {
    const frame = (border?: boolean) => ({ title: 'LED', at: [0, 0] as [number, number], ...(border === undefined ? {} : { border }), cells: [
      { at: [0, 1] as [number, number], tile: 'PWR', net: '+5V' },
      { at: [0, 2] as [number, number], tile: 'R', ref: 'R1' },
      { at: [0, 3] as [number, number], tile: 'GND' },
    ] });
    const text = (border?: boolean) => {
      const sheets = new Map([['main', { title: 'Main', frames: { led: frame(border) } }]]);
      const project = { name: 'Test', sheets: ['main'] };
      return kicadFiles(project, layoutProject(project, sheets, lookup), 'test')[0]!.text;
    };
    expect(text()).toContain('\n\t(rectangle');
    expect(text()).toContain('(text "LED"');
    expect(text(false)).not.toContain('\n\t(rectangle');
    expect(text(false)).not.toContain('(text "LED"');
  });
});
