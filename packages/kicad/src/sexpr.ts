import { createHash } from 'node:crypto';

/**
 * KiCad's S-expressions. A node is an array: its atoms come first on its line, its child nodes go on the
 * following lines, indented. Strings are written in double quotes when wrapped in `q()`, bare otherwise.
 */
export type Atom = string | number | Quoted;
export type Node = readonly (Atom | Node)[];

export class Quoted {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export const q = (text: string) => new Quoted(text);

function number(value: number): string {
  const text = value.toFixed(4).replace(/\.?0+$/, '');
  return text === '-0' || text === '' ? '0' : text;
}

function atom(value: Atom): string {
  if (value instanceof Quoted) return `"${value.text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
  return typeof value === 'number' ? number(value) : value;
}

export function dump(node: Node, depth = 0): string {
  const atoms = node.filter((item): item is Atom => !Array.isArray(item)).map(atom).join(' ');
  const children = node.filter((item): item is Node => Array.isArray(item));
  if (children.length === 0) return `(${atoms})`;
  const indent = '\t'.repeat(depth + 1);
  return `(${atoms}\n${children.map((child) => indent + dump(child, depth + 1)).join('\n')}\n${'\t'.repeat(depth)})`;
}

/** A parsed node: atoms are strings (quotes removed). */
export type Parsed = readonly (string | Parsed)[];

const TOKEN = /\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))/gy;

/** Reads the first S-expression of a text. */
export function parse(text: string): Parsed {
  const stack: (string | Parsed)[][] = [[]];
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
    const [, open, close, quoted, bare] = match;
    if (open) stack.push([]);
    else if (close) {
      const node = stack.pop()!;
      stack.at(-1)!.push(node);
      if (stack.length === 1) return node;
    } else if (quoted !== undefined) stack.at(-1)!.push(quoted.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c)));
    else if (bare !== undefined) stack.at(-1)!.push(bare);
  }
  throw new Error('incomplete S-expression');
}

/** Children of `node` of the form `(key …)`. */
export function children(node: Parsed, key: string): Parsed[] {
  return node.filter((item): item is Parsed => Array.isArray(item) && item[0] === key);
}

export function child(node: Parsed, key: string): Parsed | undefined {
  return children(node, key)[0];
}

/** A UUID derived from a name (version 5 layout), so the same project always gives the same files. */
export function uuidFor(name: string): Quoted {
  const hex = createHash('sha1').update(`wire/${name}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return q(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}
