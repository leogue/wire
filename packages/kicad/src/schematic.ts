import { CELL_MM, HALF_CELL_MM, type Cell, type Project, type Side } from '@wire/format';
import { FONT_MM, ORIGIN_MM, type Element, type PlacedBlock, type PlacedPower, type PlacedTile, type ProjectLayout, type SheetLayout } from '@wire/core';
import { dump as dumpNode, q, uuidFor, type Node, type Quoted } from './sexpr.ts';
import {
  BLOCK_REF_FIELD,
  BLOCK_VALUE_FIELD,
  LIBRARY,
  blockSymbol,
  blockSymbolNode,
  effects,
  instanceProperties,
  tileSymbol,
  tileSymbolNode,
  type BlockSymbol,
  type TileSymbol,
} from './symbols.ts';

const MARGIN_MM = 1.27;
/** From a cell centre to the middle of one of its sides, on the sheet (y down). */
const EDGE: Record<Side, readonly [number, number]> = { N: [0, -HALF_CELL_MM], S: [0, HALF_CELL_MM], E: [HALF_CELL_MM, 0], W: [-HALF_CELL_MM, 0] };

const corner = (cell: Cell): [number, number] => [ORIGIN_MM + cell[0] * CELL_MM, ORIGIN_MM + cell[1] * CELL_MM];
const center = (cell: Cell): [number, number] => [ORIGIN_MM + cell[0] * CELL_MM + HALF_CELL_MM, ORIGIN_MM + cell[1] * CELL_MM + HALF_CELL_MM];
const add = (a: Cell, b: Cell): Cell => [a[0] + b[0], a[1] + b[1]];

export interface KicadFile {
  readonly path: string;
  readonly text: string;
}

/** Footprint, fields and DNP of a part: its own values over the project defaults for its reference prefix. */
function production(project: Project, part: PlacedTile | PlacedBlock) {
  const defaults = project.defaults?.[part.ref.replace(/[0-9]+$/, '')] ?? {};
  return {
    footprint: part.footprint ?? defaults.footprint ?? (part.kind === 'block' ? (part.block.footprint ?? '') : ''),
    fields: { ...defaults.fields, ...part.fields },
    dnp: part.dnp ?? defaults.dnp ?? false,
  };
}

/** Builds the files of a KiCad project: one `.kicad_sch` per sheet (under a root index when there are several), the symbol library and its table. */
export function kicadFiles(project: Project, layout: ProjectLayout, stem: string): KicadFile[] {
  // Every unit of a block is drawn by one symbol, chosen by the modes of all its units.
  const modes = new Map<string, Map<string, 'wired' | 'label'>>();
  for (const sheet of layout.sheets) {
    for (const frame of sheet.frames) {
      for (const element of frame.elements) {
        if (element.kind === 'block') modes.set(element.ref, (modes.get(element.ref) ?? new Map()).set(element.unit, element.mode));
      }
    }
  }
  const blockSymbolOf = (element: PlacedBlock) =>
    blockSymbol(element.name, element.block, Object.keys(element.block.units).map((unit) => modes.get(element.ref)?.get(unit) ?? 'label'));

  const symbols = new Map<string, TileSymbol | BlockSymbol>();
  const counters = { '#PWR': 0, '#FLG': 0 };
  const single = layout.sheets.length === 1;
  const root = uuidFor(`${stem}/root`);
  const rootPath = `/${root.text}`;

  const sheetFiles = layout.sheets.map((sheet, index): KicadFile => {
    const sheetUuid = single ? root : uuidFor(`${stem}/sheet/${sheet.name}`);
    const path = single ? rootPath : `${rootPath}/${uuidFor(`${stem}/sheet-symbol/${sheet.name}`).text}`;
    let n = 0;
    const uid = (key = '') => uuidFor(`${stem}/${sheet.name}/${key}/${++n}`);
    const body: Node[] = [];

    const instance = (libId: string, at: [number, number], unit: number, ref: string, dnp: boolean, inBom: boolean, props: Node[], pins: string[]): Node => [
      'symbol',
      ['lib_id', q(`${LIBRARY}:${libId}`)],
      ['at', at[0], at[1], 0],
      ['unit', unit],
      ['exclude_from_sim', 'no'],
      ['in_bom', inBom ? 'yes' : 'no'],
      ['on_board', inBom ? 'yes' : 'no'],
      ['dnp', dnp ? 'yes' : 'no'],
      ['uuid', uid(ref)],
      ...props,
      ...pins.map((pin) => ['pin', q(pin), ['uuid', uid()]] as Node),
      ['instances', ['project', q(stem), ['path', q(path), ['reference', q(ref)], ['unit', unit]]]],
    ];

    const wire = (a: readonly [number, number], b: readonly [number, number]): Node => [
      'wire',
      ['pts', ['xy', ...a], ['xy', ...b]],
      ['stroke', ['width', 0], ['type', 'default']],
      ['uuid', uid()],
    ];

    const globalLabel = (name: string, x: number, y: number, toLeft: boolean): Node => {
      const justify = toLeft ? 'right' : 'left';
      return [
        'global_label',
        q(name),
        ['shape', 'passive'],
        ['at', x, y, toLeft ? 180 : 0],
        ['fields_autoplaced', 'yes'],
        effects(FONT_MM, justify),
        ['uuid', uid()],
        ['property', q('Intersheetrefs'), q('${INTERSHEET_REFS}'), ['at', x, y, 0], effects(FONT_MM, justify, true)],
      ];
    };

    const tile = (element: PlacedTile | PlacedPower, cell: Cell) => {
      const symbol = tileSymbol(element.name, element.part, element.rot, element.flip, element.kind === 'tile' ? element.pinmap : undefined);
      symbols.set(symbol.name, symbol);
      const at = center(cell);
      if (element.kind === 'power') {
        const prefix = element.part.flag ? '#FLG' : '#PWR';
        const ref = `${prefix}${String(++counters[prefix]).padStart(2, '0')}`;
        const props = { ref, value: element.net ?? 'PWR_FLAG', footprint: '', datasheet: '', description: element.part.description };
        body.push(instance(symbol.name, at, 1, ref, false, false, instanceProperties(props, symbol.refField, symbol.valueField, at, {}), element.part.pins.map((pin) => pin.number)));
        return;
      }
      const { footprint, fields, dnp } = production(project, element);
      const props = { ref: element.ref, value: element.value, footprint, datasheet: '~', description: element.part.description };
      const pins = element.part.pins.map((pin) => element.pinmap?.[pin.number] ?? pin.number);
      body.push(instance(symbol.name, at, 1, element.ref, dnp, true, instanceProperties(props, symbol.refField, symbol.valueField, at, fields), pins));
    };

    const block = (element: PlacedBlock, cell: Cell) => {
      const symbol = blockSymbolOf(element);
      symbols.set(symbol.name, symbol);
      const [x0, y0] = corner(cell);
      const { geometry, block } = element;
      const at: [number, number] = [x0 + geometry.body[0], y0 + geometry.body[1]];
      const { footprint, fields, dnp } = production(project, element);
      const props = { ref: element.ref, value: element.value, footprint, datasheet: block.datasheet ?? '~', description: block.description };
      const unit = Object.keys(block.units).indexOf(element.unit) + 1;
      const pins = geometry.pins.map((pin) => pin.number);
      body.push(instance(symbol.name, at, unit, element.ref, dnp, true, instanceProperties(props, BLOCK_REF_FIELD, BLOCK_VALUE_FIELD, at, fields), pins));
      for (const pin of geometry.pins) {
        const net = element.nets.get(pin.number);
        const [x, y] = [x0 + pin.tip[0], y0 + pin.tip[1]];
        if (net === 'NC') body.push(['no_connect', ['at', x, y], ['uuid', uid()]]);
        else if (net !== undefined) body.push(globalLabel(net, x, y, pin.side === 'W'));
      }
    };

    const place = (element: Element, cell: Cell) => {
      switch (element.kind) {
        case 'tile':
        case 'power':
          return tile(element, cell);
        case 'block':
          return block(element, cell);
        case 'wire': {
          const [cx, cy] = center(cell);
          const end = (side: string): [number, number] => [cx + EDGE[side as Side][0], cy + EDGE[side as Side][1]];
          if (element.groups.length > 1) {
            // A crossing: two straight wires through the cell, no junction.
            for (const group of element.groups) body.push(wire(end(group[0]!), end(group[1]!)));
            return;
          }
          const sides = [...element.groups[0]!];
          for (const side of sides) body.push(wire([cx, cy], end(side)));
          if (sides.length >= 3) body.push(['junction', ['at', cx, cy], ['diameter', 0], ['color', 0, 0, 0, 0], ['uuid', uid()]]);
          return;
        }
        case 'label': {
          const [cx, cy] = center(cell);
          return body.push(globalLabel(element.name, cx + EDGE[element.side][0], cy, element.side === 'E'));
        }
        case 'text': {
          const [x, y] = corner(cell);
          return body.push(['text', q(element.text), ['exclude_from_sim', 'no'], ['at', x + MARGIN_MM, y + MARGIN_MM, 0], effects(FONT_MM, 'left top'), ['uuid', uid()]]);
        }
      }
    };

    for (const frame of sheet.frames) {
      for (const element of frame.elements) place(element, add(frame.at, element.at));
      if (!frame.border) continue;
      const [x, y] = corner(frame.at);
      body.push([
        'rectangle',
        ['start', x, y],
        ['end', x + frame.size[0] * CELL_MM, y + frame.size[1] * CELL_MM],
        ['stroke', ['width', 0], ['type', 'default']],
        ['fill', ['type', 'none']],
        ['uuid', uid()],
      ]);
      body.push(['text', q(frame.title), ['exclude_from_sim', 'no'], ['at', x + 1.905, y + HALF_CELL_MM, 0], effects(FONT_MM, 'left'), ['uuid', uid()]]);
    }
    for (const note of sheet.notes) {
      const [x, y] = corner(note.at);
      body.push(['text', q(note.text), ['exclude_from_sim', 'no'], ['at', x + MARGIN_MM, y + MARGIN_MM, 0], effects(FONT_MM, 'left top'), ['uuid', uid()]]);
    }

    return {
      path: single ? `${stem}.kicad_sch` : `${sheet.name}.kicad_sch`,
      text: schematic(sheetUuid, sheet.paper, sheet.title, body, single, index + 2),
    };
  });

  // The library symbols each sheet embeds are only known once every sheet is built: insert them now.
  const libSymbols = [...symbols.values()].sort((a, b) => a.name.localeCompare(b.name));
  const embedded = dumpNode(['lib_symbols', ...libSymbols.map((symbol) => symbolNode(symbol, `${LIBRARY}:`))], 1);
  const files = sheetFiles.map((file) => ({ ...file, text: file.text.replace(LIB_SYMBOLS, embedded) }));

  if (!single) files.unshift({ path: `${stem}.kicad_sch`, text: rootIndex(project, layout.sheets, stem, root) });
  files.push({ path: `${LIBRARY}.kicad_sym`, text: `${dumpNode(['kicad_symbol_lib', ['version', 20241209], ['generator', q('wire')], ['generator_version', q('0.1')], ...libSymbols.map((symbol) => symbolNode(symbol))])}\n` });
  files.push({
    path: 'sym-lib-table',
    text: `(sym_lib_table\n\t(version 7)\n\t(lib (name "${LIBRARY}") (type "KiCad") (uri "\${KIPRJMOD}/${LIBRARY}.kicad_sym") (options "") (descr "wire symbols"))\n)\n`,
  });
  return files;
}

const LIB_SYMBOLS = '\u0000lib_symbols\u0000';

function symbolNode(symbol: TileSymbol | BlockSymbol, prefix = ''): Node {
  return 'block' in symbol ? blockSymbolNode(symbol, prefix) : tileSymbolNode(symbol, prefix);
}

function schematic(uuid: Quoted, paper: string, title: string, body: Node[], root: boolean, page: number): string {
  const text = dumpNode([
    'kicad_sch',
    ['version', 20250114],
    ['generator', q('wire')],
    ['generator_version', q('0.1')],
    ['uuid', uuid],
    ['paper', q(paper)],
    ['title_block', ['title', q(title)], ...(root ? [] : [['comment', 1, q(`Page ${page}`)]])],
    ['lib_symbols'],
    ...body,
    ...(root ? [['sheet_instances', ['path', q('/'), ['page', q('1')]]]] : []),
    ['embedded_fonts', 'no'],
  ]);
  return `${text.replace('\t(lib_symbols)', `\t${LIB_SYMBOLS}`)}\n`;
}

/** Root sheet of a project with several pages: one sheet symbol per page, in order. */
function rootIndex(project: Project, sheets: readonly SheetLayout[], stem: string, root: Quoted): string {
  const body: Node[] = sheets.map((sheet, index) => {
    const [x, y] = [ORIGIN_MM, ORIGIN_MM + index * 15.24];
    const [width, height] = [50.8, 10.16];
    return [
      'sheet',
      ['at', x, y],
      ['size', width, height],
      ['exclude_from_sim', 'no'],
      ['in_bom', 'yes'],
      ['on_board', 'yes'],
      ['dnp', 'no'],
      ['fields_autoplaced', 'yes'],
      ['stroke', ['width', 0.1524], ['type', 'solid']],
      ['fill', ['color', 0, 0, 0, 0]],
      ['uuid', uuidFor(`${stem}/sheet-symbol/${sheet.name}`)],
      ['property', q('Sheetname'), q(sheet.title), ['at', x, y - 0.7112, 0], effects(FONT_MM, 'left bottom')],
      ['property', q('Sheetfile'), q(`${sheet.name}.kicad_sch`), ['at', x, y + height + 0.5946, 0], effects(FONT_MM, 'left top', true)],
      ['instances', ['project', q(stem), ['path', q(`/${root.text}`), ['page', q(String(index + 2))]]]],
    ];
  });
  return `${dumpNode([
    'kicad_sch',
    ['version', 20250114],
    ['generator', q('wire')],
    ['generator_version', q('0.1')],
    ['uuid', root],
    ['paper', q('A4')],
    ['title_block', ['title', q(project.name)]],
    ['lib_symbols'],
    ...body,
    ['sheet_instances', ['path', q('/'), ['page', q('1')]]],
    ['embedded_fonts', 'no'],
  ])}\n`;
}
