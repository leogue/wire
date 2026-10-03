import { readdirSync, readFileSync } from 'node:fs';
import { PartSchema, type Part } from '@wire/format';

const BUILTIN_DIR = new URL('../builtin/', import.meta.url);

/** Parts of a folder of `<name>.json` files, validated. Throws on an invalid file, naming it. */
export function loadParts(dir: URL): ReadonlyMap<string, Part> {
  const parts = new Map<string, Part>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const result = PartSchema.safeParse(JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
    if (!result.success) throw new Error(`${file}: ${result.error.message}`);
    parts.set(file.slice(0, -'.json'.length), result.data);
  }
  return parts;
}

/** The built-in basic components: hand-drawn tiles (passives, diodes, transistors…) and power symbols. */
export function builtinParts(): ReadonlyMap<string, Part> {
  return loadParts(BUILTIN_DIR);
}
