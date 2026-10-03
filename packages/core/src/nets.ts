import type { Diagnostic, Element, Port } from './frame.ts';

export interface NetPin {
  readonly ref: string;
  readonly pin: string;
  /** Pin name, empty for unnamed tile pins. */
  readonly name: string;
}

/** Ports of one frame connected together, and the net names they carry (none, or one). */
export interface NetGroup {
  readonly names: readonly string[];
  readonly pins: readonly NetPin[];
}

/** A net of the project: the same name is the same net everywhere. Unnamed nets stay inside one frame. */
export interface Net {
  readonly name?: string;
  readonly pins: readonly NetPin[];
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(node: string): string {
    let root = node;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(node, root);
    return root;
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }

  nodes(): string[] {
    return [...this.parent.keys()];
  }
}

const byPin = (a: NetPin, b: NetPin) => a.ref.localeCompare(b.ref, 'en', { numeric: true }) || a.pin.localeCompare(b.pin, 'en', { numeric: true });

/** Connected sets of a frame: facing ports, wire groups, and label-mode pins joined to their net name. */
export function frameGroups(elements: readonly Element[], touching: readonly [Port, Port][]) {
  const sets = new UnionFind();
  const pins = new Map<string, NetPin>();
  const names: string[] = [];

  for (const element of elements) {
    if (element.kind === 'tile') {
      for (const pin of element.sides.values()) pins.set(`pin:${element.ref}:${pin.number}`, { ref: element.ref, pin: pin.number, name: pin.name });
    } else if (element.kind === 'power' && element.net) sets.find(`name:${element.net}`);
    else if (element.kind === 'label') {
      names.push(element.name);
      sets.find(`name:${element.name}`);
    } else if (element.kind === 'block') {
      for (const pin of element.geometry.pins) {
        const net = element.nets.get(pin.number);
        if (net === 'NC') continue;
        const node = `pin:${element.ref}:${pin.number}`;
        pins.set(node, { ref: element.ref, pin: pin.number, name: pin.name });
        if (net !== undefined) {
          names.push(net);
          sets.union(node, `name:${net}`);
        }
      }
    }
  }
  for (const node of pins.keys()) sets.find(node);
  for (const [a, b] of touching) sets.union(a.node, b.node);

  const byRoot = new Map<string, { names: string[]; pins: NetPin[] }>();
  for (const node of sets.nodes()) {
    const root = sets.find(node);
    const group = byRoot.get(root) ?? { names: [], pins: [] };
    byRoot.set(root, group);
    if (node.startsWith('name:')) group.names.push(node.slice('name:'.length));
    const pin = pins.get(node);
    if (pin) group.pins.push(pin);
  }

  const diagnostics: Diagnostic[] = [];
  const groups: NetGroup[] = [];
  for (const group of byRoot.values()) {
    if (group.names.length > 1) diagnostics.push({ severity: 'error', message: `nets ${group.names.sort().join(' and ')} are connected together` });
    if (group.names.length > 0 || group.pins.length > 0) groups.push(group);
  }
  return { groups, names, diagnostics };
}

/** Joins the groups of every frame by name into the project's nets, named ones first. */
export function projectNets(groups: readonly NetGroup[]): Net[] {
  const sets = new UnionFind();
  groups.forEach((group, index) => {
    sets.find(`group:${index}`);
    for (const name of group.names) sets.union(`group:${index}`, `name:${name}`);
  });
  const byRoot = new Map<string, { names: Set<string>; pins: NetPin[] }>();
  groups.forEach((group, index) => {
    const root = sets.find(`group:${index}`);
    const net = byRoot.get(root) ?? { names: new Set(), pins: [] };
    byRoot.set(root, net);
    for (const name of group.names) net.names.add(name);
    net.pins.push(...group.pins);
  });
  const nets = [...byRoot.values()].map(({ names, pins }) => {
    const [name] = [...names].sort();
    return { ...(name !== undefined && { name }), pins: pins.sort(byPin) };
  });
  return nets.sort((a, b) => {
    if (a.name !== undefined && b.name !== undefined) return a.name.localeCompare(b.name);
    if (a.name !== undefined || b.name !== undefined) return a.name !== undefined ? -1 : 1;
    return a.pins[0] && b.pins[0] ? byPin(a.pins[0], b.pins[0]) : 0;
  });
}
