import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { kicadCli, symbolDir } from '@wire/kicad';
import { build, check, ercCommand, importPart, netlist, parts, render, schema, show } from '../src/commands.ts';

const example = fileURLToPath(new URL('../../../examples/ldo-indicator', import.meta.url));
const hasKicad = (() => {
  try {
    return Boolean(kicadCli());
  } catch {
    return false;
  }
})();

describe('commands without KiCad', () => {
  it('check prints where frames and blocks lie', () => {
    const output = check(example);
    expect(output.code).toBe(0);
    expect(output.text).toContain('frame ldo "LDO 3.3 V": at [0, 0], 6 x 7 cells (columns 0-5, rows 0-6)');
    expect(output.text).toContain('U1 (wired): local [3, 1], 2 x 5 cells');
    expect(output.text.endsWith('OK')).toBe(true);
  });

  it('check reports a missing project', () => {
    expect(check(tmpdir())).toMatchObject({ code: 1 });
  });

  it('netlist prints pins with their names', () => {
    expect(netlist(example).text).toContain('+5V: C1.1 R1.1 U1.1(VIN) U1.3(EN)');
  });

  it('show gives pin sides per rotation, and block sizes', async () => {
    expect((await show('LED', '.')).text).toContain('rot 90 : 2 A: E, 1 K: W');
    expect((await show('AP2112K-3.3', example)).text).toContain('wired: 2 x 5 cells');
    expect(await show('NOPE', '.')).toMatchObject({ code: 1 });
  });

  it('parts searches names, descriptions and keywords', async () => {
    expect((await parts('schottky', '.')).text).toContain('D_Schottky');
    expect((await parts('regulator', example)).text).toContain('AP2112K-3.3');
  });

  it('schema prints a JSON Schema', () => {
    expect(JSON.parse(schema('sheet').text).$id).toBe('sheet.schema.json');
    expect(schema('module')).toMatchObject({ code: 1 });
  });
});

describe.skipIf(!hasKicad)('commands with KiCad', () => {
  const out = mkdtempSync(join(tmpdir(), 'wire-cli-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('build, render and erc the example', () => {
    expect(build(example, out)).toMatchObject({ code: 0 });
    expect(existsSync(join(out, 'schematic.pdf'))).toBe(true);
    expect(render(example, undefined, out).text).toContain('power.png');
    expect(existsSync(join(out, 'power.png'))).toBe(true);
    expect(ercCommand(example, out)).toEqual({ code: 0, text: 'ERC: no violation' });
  });
});

describe.skipIf(!symbolDir())('KiCad symbols (needs KiCad)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wire-import-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('parts searches KiCad after the local parts, show reads a KiCad symbol', async () => {
    const output = (await parts('ap2112k 3.3', example)).text;
    expect(output.indexOf('AP2112K-3.3      block parts/')).toBeLessThan(output.indexOf('Regulator_Linear:AP2112K-3.3'));
    expect((await show('Amplifier_Operational:LM358', '.')).text).toContain('unit C: W 8 V+ | E 4 V-');
  });

  it('import writes the block once, and refuses to overwrite it', () => {
    expect(importPart('Amplifier_Operational:LM358', dir)).toMatchObject({ code: 0, text: expect.stringContaining('parts/LM358.json') });
    expect(JSON.parse(readFileSync(join(dir, 'parts', 'LM358.json'), 'utf8'))).toMatchObject({ source: 'Amplifier_Operational:LM358' });
    expect(importPart('Amplifier_Operational:LM358', dir)).toMatchObject({ code: 1 });
    expect(importPart('Amplifier_Operational:LM358', dir, undefined, true)).toMatchObject({ code: 0 });
    expect(importPart('Device:R', dir)).toMatchObject({ code: 1, text: expect.stringContaining('built-in part') });
    expect(importPart('MCU_ST_STM32G0:STM32G031F6Px', dir).text).toContain('unit A has 20 pins');
  });

  it('check reports a pin table changed since the import', () => {
    const project = join(dir, 'project');
    cpSync(example, project, { recursive: true });
    const path = join(project, 'parts', 'AP2112K-3.3.json');
    const block = JSON.parse(readFileSync(path, 'utf8'));
    block.pins['3'].name = 'ENABLE';
    writeFileSync(path, JSON.stringify(block));
    expect(check(project).text).toContain('parts/AP2112K-3.3.json: pin 3 is named "ENABLE", "EN" in Regulator_Linear:AP2112K-3.3 (only "units" may change)');
  });
});
