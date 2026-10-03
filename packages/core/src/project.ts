import type { Project, Sheet } from '@wire/format';
import type { Diagnostic, PartLookup, PlacedBlock, PlacedTile } from './frame.ts';
import { projectNets, type Net } from './nets.ts';
import { layoutSheet, type SheetLayout } from './sheet.ts';

export interface ProjectLayout {
  readonly sheets: readonly SheetLayout[];
  readonly nets: readonly Net[];
  readonly diagnostics: readonly Diagnostic[];
}

type Located<T> = { readonly part: T; readonly where: string };

/**
 * Lays out every sheet and checks what spans them: unique references, block units each placed once and
 * agreeing, net names used only once (probably a typo). Sheets are given in project order.
 */
export function layoutProject(project: Project, sheets: ReadonlyMap<string, Sheet>, lookup: PartLookup): ProjectLayout {
  const layouts = project.sheets.flatMap((name) => {
    const sheet = sheets.get(name);
    return sheet ? [layoutSheet(name, sheet, lookup)] : [];
  });
  const diagnostics: Diagnostic[] = layouts.flatMap((sheet) => sheet.diagnostics);
  const frames = layouts.flatMap((sheet) => sheet.frames.map((frame) => ({ frame, where: `${sheet.name}/${frame.key}` })));

  const parts: Located<PlacedTile | PlacedBlock>[] = frames.flatMap(({ frame, where }) =>
    frame.elements.flatMap((element) => (element.kind === 'tile' || element.kind === 'block' ? [{ part: element, where }] : [])),
  );
  diagnostics.push(...checkReferences(parts));

  // A name given by labels and label-mode pins once only, and by no power symbol, joins nothing.
  const powerNets = new Set(frames.flatMap(({ frame }) => frame.elements.flatMap((element) => (element.kind === 'power' && element.net ? [element.net] : []))));
  const named = new Map<string, string[]>();
  for (const { frame, where } of frames) for (const name of frame.names) named.set(name, [...(named.get(name) ?? []), where]);
  for (const [name, wheres] of named) {
    if (wheres.length === 1 && !powerNets.has(name)) {
      diagnostics.push({ severity: 'warning', message: `${wheres[0]}: net ${name} is named only once in the project: check its spelling, or connect it` });
    }
  }

  return { sheets: layouts, nets: projectNets(frames.flatMap(({ frame }) => frame.groups)), diagnostics };
}

/** References are unique, except the units of one block: each placed once, anywhere, all agreeing. */
function checkReferences(parts: readonly Located<PlacedTile | PlacedBlock>[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string) => diagnostics.push({ severity: 'error', message });
  const byRef = new Map<string, Located<PlacedTile | PlacedBlock>[]>();
  for (const located of parts) byRef.set(located.part.ref, [...(byRef.get(located.part.ref) ?? []), located]);

  for (const [ref, placed] of byRef) {
    const first = placed[0]!.part;
    const wheres = placed.map(({ where }) => where).join(', ');
    if (placed.some(({ part }) => part.kind !== 'block' || part.name !== first.name)) {
      if (placed.length > 1) error(`${ref} is used ${placed.length} times (${wheres}): references are unique, units of one block excepted`);
      continue;
    }
    const units = placed.map(({ part }) => (part as PlacedBlock).unit);
    for (const unit of new Set(units)) {
      const at = placed.filter(({ part }) => (part as PlacedBlock).unit === unit).map(({ where }) => where);
      if (at.length > 1) error(`${ref}: unit ${unit} is placed ${at.length} times (${at.join(', ')})`);
    }
    const missing = Object.keys((first as PlacedBlock).block.units).filter((unit) => !units.includes(unit));
    if (missing.length > 0) error(`${ref}: unit${missing.length > 1 ? 's' : ''} ${missing.join(', ')} not placed: every unit of a block is placed once, in any frame`);
    for (const field of ['value', 'footprint', 'dnp'] as const) {
      if (new Set(placed.map(({ part }) => part[field])).size > 1) error(`${ref}: units disagree on "${field}" (${wheres}): set it on every unit, or on none`);
    }
    if (new Set(placed.map(({ part }) => JSON.stringify(part.fields ?? {}))).size > 1) error(`${ref}: units disagree on "fields" (${wheres})`);
  }
  return diagnostics;
}
