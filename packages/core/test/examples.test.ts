import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layoutProject, loadProject } from '../src/index.ts';

const examples = new URL('../../../examples/', import.meta.url);

describe('examples', () => {
  for (const name of readdirSync(examples).filter((entry) => existsSync(new URL(`${entry}/project.json`, examples)))) {
    it(`${name} loads and lays out without diagnostics`, () => {
      const loaded = loadProject(new URL(`${name}/`, examples));
      if (!loaded.ok) throw new Error(loaded.errors.join('\n'));
      const { project, sheets, lookup } = loaded.value;
      expect(layoutProject(project, sheets, lookup).diagnostics).toEqual([]);
    });
  }

  it('ldo-indicator has the nets of its circuit', () => {
    const loaded = loadProject(new URL('ldo-indicator/', examples));
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'));
    const { project, sheets, lookup } = loaded.value;
    const nets = layoutProject(project, sheets, lookup).nets.map((net) => `${net.name ?? '-'}: ${net.pins.map((pin) => `${pin.ref}.${pin.pin}`).join(' ')}`);
    expect(nets).toEqual(['+3V3: C2.1 R2.1 U1.5', '+5V: C1.1 R1.1 U1.1 U1.3', 'GND: C1.2 C2.2 D1.1 D2.1 U1.2', '-: D1.2 R1.2', '-: D2.2 R2.2']);
  });
});
