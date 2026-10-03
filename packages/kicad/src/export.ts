import { join } from 'node:path';
import type { Project } from '@wire/format';
import type { ProjectLayout } from '@wire/core';
import { kicadNetlist, projectTemplate, writeFiles } from './cli.ts';
import { kicadFiles } from './schematic.ts';

/**
 * Writes the KiCad project `<dir>/<stem>.kicad_pro` and its schematics, then checks that KiCad computes the
 * same nets as wire. Returns the root schematic and the differences (none when the export is faithful).
 */
export function exportProject(project: Project, layout: ProjectLayout, dir: string, stem = 'schematic') {
  writeFiles(dir, [...kicadFiles(project, layout, stem), { path: `${stem}.kicad_pro`, text: projectTemplate() }]);
  const schematic = join(dir, `${stem}.kicad_sch`);
  return { schematic, differences: compareNets(layout, kicadNetlist(schematic)) };
}

const key = (pin: { ref: string; pin: string }) => `${pin.ref}.${pin.pin}`;

/**
 * Compares wire's nets with KiCad's: the same pins grouped the same way, and the same names on named nets.
 * Pins are compared by pad number (after a tile's `pinmap`). Pins KiCad leaves unconnected (NC) are skipped.
 */
export function compareNets(layout: ProjectLayout, kicad: readonly { name: string; pins: readonly { ref: string; pin: string }[] }[]): string[] {
  const pinmaps = new Map<string, Readonly<Record<string, string>>>();
  for (const sheet of layout.sheets) {
    for (const frame of sheet.frames) for (const element of frame.elements) if (element.kind === 'tile' && element.pinmap) pinmaps.set(element.ref, element.pinmap);
  }
  const ours = layout.nets.map((net) => ({
    name: net.name,
    pins: net.pins.map((pin) => key({ ref: pin.ref, pin: pinmaps.get(pin.ref)?.[pin.pin] ?? pin.pin })).sort(),
  }));
  const theirs = kicad.filter((net) => !net.name.startsWith('unconnected-') && net.pins.length > 0).map((net) => ({ name: net.name, pins: net.pins.map(key).sort() }));

  const differences: string[] = [];
  const byPins = new Map(theirs.map((net) => [net.pins.join(' '), net]));
  for (const net of ours.filter((n) => n.pins.length > 0)) {
    const match = byPins.get(net.pins.join(' '));
    if (!match) differences.push(`net ${net.name ?? '(unnamed)'} {${net.pins.join(' ')}} has no equal in KiCad`);
    else if (net.name !== undefined && match.name !== net.name) differences.push(`net ${net.name} is named ${match.name} in KiCad`);
    byPins.delete(net.pins.join(' '));
  }
  for (const net of byPins.values()) differences.push(`KiCad net ${net.name} {${net.pins.join(' ')}} has no equal in wire`);
  return differences;
}
