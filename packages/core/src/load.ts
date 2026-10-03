import { existsSync, readFileSync } from 'node:fs';
import { ProjectSchema, parseSheet, parseWith, type Part, type Project, type Result, type Sheet } from '@wire/format';
import { builtinParts, loadParts } from '@wire/library';
import type { PartLookup } from './frame.ts';

export interface LoadedProject {
  readonly project: Project;
  /** Sheets by name, in project order. */
  readonly sheets: ReadonlyMap<string, Sheet>;
  /** The project's `parts/` first, then the built-in parts. */
  readonly lookup: PartLookup;
}

function readJson(dir: URL, path: string): Result<unknown> {
  const url = new URL(path, dir);
  if (!existsSync(url)) return { ok: false, errors: [`${path}: file not found`] };
  try {
    return { ok: true, value: JSON.parse(readFileSync(url, 'utf8')) };
  } catch (error) {
    return { ok: false, errors: [`${path}: invalid JSON: ${(error as Error).message}`] };
  }
}

/** Reads and validates a project folder: `project.json`, its sheets and its `parts/`. Every file error is reported. */
export function loadProject(dir: URL): Result<LoadedProject> {
  const root = readJson(dir, 'project.json');
  const project = root.ok ? parseWith(ProjectSchema, root.value) : root;
  if (!project.ok) return { ok: false, errors: project.errors.map((e) => (e.startsWith('project.json') ? e : `project.json: ${e}`)) };

  const errors: string[] = [];
  const sheets = new Map<string, Sheet>();
  for (const name of project.value.sheets) {
    const path = `sheets/${name}.json`;
    const json = readJson(dir, path);
    const sheet = json.ok ? parseSheet(json.value) : json;
    if (sheet.ok) sheets.set(name, sheet.value);
    else errors.push(...sheet.errors.map((e) => (e.startsWith(path) ? e : `${path}: ${e}`)));
  }

  const builtin = builtinParts();
  let parts: ReadonlyMap<string, Part> = new Map();
  const partsDir = new URL('parts/', dir);
  if (existsSync(partsDir)) {
    try {
      parts = loadParts(partsDir);
    } catch (error) {
      errors.push(`parts/${(error as Error).message}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { project: project.value, sheets, lookup: (name) => parts.get(name) ?? builtin.get(name) } };
}
