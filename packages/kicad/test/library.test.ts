import { describe, expect, it } from 'vitest';
import { compareWithSource, kicadBlock, searchSymbols, symbolDir } from '../src/index.ts';

describe.skipIf(!symbolDir())('KiCad symbol library (needs KiCad)', () => {
  it('converts a symbol: pins, footprint, datasheet and sides as KiCad draws them', () => {
    expect(kicadBlock('Regulator_Linear:AP2112K-3.3')).toMatchObject({
      kind: 'block',
      source: 'Regulator_Linear:AP2112K-3.3',
      ref: 'U',
      value: 'AP2112K-3.3',
      footprint: 'Package_TO_SOT_SMD:SOT-23-5',
      datasheet: 'https://www.diodes.com/assets/Datasheets/AP2112.pdf',
      pins: { '1': { name: 'VIN', type: 'power_in' }, '4': { name: 'NC', type: 'no_connect' }, '5': { name: 'VOUT', type: 'power_out' } },
      units: { A: { W: ['1', '3', null, '2'], E: ['5', '4'] } },
    });
  });

  it("keeps KiCad's units, folding top and bottom pins onto a side", () => {
    expect(kicadBlock('Amplifier_Operational:LM358').units).toEqual({
      A: { W: ['3', null, '2'], E: ['1'] },
      B: { W: ['5', null, '6'], E: ['7'] },
      C: { W: ['8'], E: ['4'] },
    });
  });

  it('follows derived symbols to the pins of the symbol they extend', () => {
    expect(Object.keys(kicadBlock('Amplifier_Current:INA281A2').pins).length).toBeGreaterThan(0);
  });

  it('imports a large IC whole, every pin in one unit', () => {
    const block = kicadBlock('MCU_ST_STM32G0:STM32G031F6Px');
    expect(Object.keys(block.units)).toEqual(['A']);
    expect(Object.keys(block.pins)).toHaveLength(20);
  });

  it('refuses power symbols and unknown symbols', () => {
    expect(() => kicadBlock('power:GND')).toThrow('is a power symbol');
    expect(() => kicadBlock('Regulator_Linear:NOPE')).toThrow('no symbol "NOPE" in KiCad library Regulator_Linear');
    expect(() => kicadBlock('NOPE')).toThrow('expected Library:Name');
  });

  it('searches every word, exact names first, power symbols left out', () => {
    expect(searchSymbols('AP2112K-3.3')[0]?.id).toBe('Regulator_Linear:AP2112K-3.3');
    const found = searchSymbols('ldo 3.3 sot-23-5');
    expect(found.length).toBeGreaterThan(5);
    expect(found.every((symbol) => /ldo|regulator/i.test(`${symbol.id} ${symbol.description} ${symbol.keywords}`))).toBe(true);
    expect(searchSymbols('gnd').some((symbol) => symbol.id === 'power:GND')).toBe(false);
  });

  it('compares a block with its source: names and numbers are errors, types are reported apart', () => {
    const block = kicadBlock('Regulator_Linear:AP2112K-3.3');
    expect(compareWithSource(block)).toEqual({ errors: [], types: [] });
    const changed = { ...block, pins: { ...block.pins, '3': { name: 'ENABLE', type: 'input' as const }, '5': { name: 'VOUT', type: 'output' as const } } };
    expect(compareWithSource(changed)).toEqual({
      errors: ['pin 3 is named "ENABLE", "EN" in Regulator_Linear:AP2112K-3.3'],
      types: ['pin 5 (VOUT) is output, power_out in Regulator_Linear:AP2112K-3.3'],
    });
  });
});
