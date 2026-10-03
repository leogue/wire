import { CELL_MM, type Cell, type Sheet } from '@wire/format';
import { layoutFrame, type Diagnostic, type FrameLayout, type PartLookup } from './frame.ts';
import { noteSize } from './geometry.ts';

/** Landscape paper sizes, in mm. */
const PAPER_MM = { A4: [297, 210], A3: [420, 297], A2: [594, 420] } as const;
/** Cell [0, 0] sits this far from the top-left corner of the paper. */
export const ORIGIN_MM = 25.4;
/** KiCad's page frame: margin and double line. */
const BORDER_MM = 14;
/** KiCad's title block, bottom right, against the frame. */
const TITLE_BLOCK_MM = [112, 35] as const;

export type Paper = keyof typeof PAPER_MM;

/** Usable cells of a paper: columns `0 … cols - 1`, rows `0 … rows - 1`, minus the title block corner. */
export interface SheetArea {
  readonly cols: number;
  readonly rows: number;
  /** First column and first row covered by the title block. */
  readonly titleBlock: Cell;
}

export function sheetArea(paper: Paper): SheetArea {
  const [width, height] = PAPER_MM[paper];
  return {
    cols: Math.floor((width - BORDER_MM - ORIGIN_MM) / CELL_MM),
    rows: Math.floor((height - BORDER_MM - ORIGIN_MM) / CELL_MM),
    titleBlock: [Math.floor((width - 10 - TITLE_BLOCK_MM[0] - ORIGIN_MM) / CELL_MM), Math.floor((height - 10 - TITLE_BLOCK_MM[1] - ORIGIN_MM) / CELL_MM)],
  };
}

export interface PlacedFrame extends FrameLayout {
  readonly key: string;
  readonly title: string;
  /** Whether the border and title are drawn. */
  readonly border: boolean;
  /** Top-left cell on the sheet; the elements' cells are relative to it. */
  readonly at: Cell;
}

export interface PlacedNote {
  readonly at: Cell;
  readonly text: string;
  readonly size: readonly [number, number];
}

export interface SheetLayout {
  readonly name: string;
  readonly title: string;
  readonly paper: Paper;
  readonly frames: readonly PlacedFrame[];
  readonly notes: readonly PlacedNote[];
  readonly diagnostics: readonly Diagnostic[];
}

interface Rect {
  readonly what: string;
  readonly at: Cell;
  readonly size: readonly [number, number];
}

const overlap = (a: Rect, b: Rect) =>
  a.at[0] < b.at[0] + b.size[0] && b.at[0] < a.at[0] + a.size[0] && a.at[1] < b.at[1] + b.size[1] && b.at[1] < a.at[1] + a.size[1];

const span = (rect: Rect) =>
  `columns ${rect.at[0]}-${rect.at[0] + rect.size[0] - 1}, rows ${rect.at[1]}-${rect.at[1] + rect.size[1] - 1}`;

/** Lays out every frame of a sheet and checks that frames and notes fit the paper without overlapping. */
export function layoutSheet(name: string, sheet: Sheet, lookup: PartLookup): SheetLayout {
  const diagnostics: Diagnostic[] = [];
  const paper = sheet.paper ?? 'A4';
  const frames = Object.entries(sheet.frames).map(([key, frame]): PlacedFrame => {
    const layout = layoutFrame(frame, lookup);
    diagnostics.push(...layout.diagnostics.map((d) => ({ ...d, message: `${name}/${key}: ${d.message}` })));
    return { ...layout, key, title: frame.title, border: frame.border ?? true, at: frame.at };
  });
  const notes = (sheet.notes ?? []).map((note) => ({ ...note, size: noteSize(note.text) }));

  const rects: Rect[] = [
    ...frames.map((frame) => ({ what: `frame ${frame.key}`, at: frame.at, size: frame.size })),
    ...notes.map((note) => ({ what: `note at [${note.at[0]}, ${note.at[1]}]`, at: note.at, size: note.size })),
  ];
  const area = sheetArea(paper);
  const titleBlock: Rect = { what: 'the title block', at: area.titleBlock, size: [area.cols - area.titleBlock[0], area.rows - area.titleBlock[1]] };
  rects.forEach((rect, index) => {
    for (const other of rects.slice(index + 1)) {
      if (overlap(rect, other)) diagnostics.push({ severity: 'error', message: `${name}: ${rect.what} (${span(rect)}) overlaps ${other.what} (${span(other)})` });
    }
    if (rect.at[0] + rect.size[0] > area.cols || rect.at[1] + rect.size[1] > area.rows) {
      diagnostics.push({
        severity: 'error',
        message: `${name}: ${rect.what} covers ${span(rect)}, off the ${paper} sheet: usable columns 0-${area.cols - 1}, rows 0-${area.rows - 1} (or a larger paper)`,
      });
    } else if (overlap(rect, titleBlock)) {
      diagnostics.push({
        severity: 'error',
        message: `${name}: ${rect.what} covers ${span(rect)}, over the title block (columns >= ${area.titleBlock[0]} and rows >= ${area.titleBlock[1]})`,
      });
    }
  });
  return { name, title: sheet.title, paper, frames, notes, diagnostics };
}
