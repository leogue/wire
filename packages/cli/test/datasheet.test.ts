import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { datasheet, parsePages } from '../src/commands.ts';

const hasPoppler = (() => {
  try {
    execFileSync('which', ['pdftoppm', 'pdftotext']);
    return true;
  } catch {
    return false;
  }
})();

/** A minimal PDF: one page per list of text lines, and optional bookmarks (title → page). */
function makePdf(pages: string[][], bookmarks: [string, number][] = []): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1;
  const catalog = add('');
  const pagesObject = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = pages.map((lines) => {
    const stream = lines.map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 20} Td (${line}) Tj ET`).join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  let outlines = '';
  if (bookmarks.length > 0) {
    const outlineRoot = add('');
    const items = bookmarks.map(() => add(''));
    bookmarks.forEach(([title, page], index) => {
      objects[items[index]! - 1] = `<< /Title (${title}) /Parent ${outlineRoot} 0 R /Dest [${pageIds[page - 1]} 0 R /Fit]${index > 0 ? ` /Prev ${items[index - 1]} 0 R` : ''}${index < items.length - 1 ? ` /Next ${items[index + 1]} 0 R` : ''} >>`;
    });
    objects[outlineRoot - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items.at(-1)} 0 R /Count ${items.length} >>`;
    outlines = ` /Outlines ${outlineRoot} 0 R`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R${outlines} >>`;
  objects[pagesObject - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const page = (n: number, title: string) => ['ACME LDO1234', title, `Body text of page ${n}`, `Page ${n} of 12`];

describe('parsePages', () => {
  it('reads numbers and ranges', () => {
    expect(parsePages('1,2,5-7')).toEqual([1, 2, 5, 6, 7]);
    expect(parsePages('x')).toBeUndefined();
    expect(parsePages('')).toBeUndefined();
  });
});

describe.skipIf(!hasPoppler)('datasheet (needs poppler)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wire-datasheet-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, pdf: Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, pdf);
    return path;
  };

  it('gives every page of a short datasheet as images, kept in datasheets/', async () => {
    const output = await datasheet(write('short.pdf', makePdf([page(1, 'Pin Assignments'), page(2, 'Typical Application')])), dir);
    expect(output.code).toBe(0);
    expect(output.images).toHaveLength(2);
    expect(output.images!.every(existsSync)).toBe(true);
    expect(existsSync(join(dir, 'datasheets', 'short.pdf'))).toBe(true);
  });

  it('indexes a long datasheet by the first lines of its pages, running headers and footers left out', async () => {
    const titles = ['Pin Assignments', 'Typical Application', 'Absolute Maximum Ratings', 'Electrical Characteristics', 'Electrical Characteristics', 'Performance', 'Performance', 'Ordering Information', 'Marking', 'Package Outline', 'Pad Layout', 'Notice'];
    const output = await datasheet(write('long.pdf', makePdf(titles.map((title, index) => page(index + 1, title)))), dir);
    expect(output.images).toBeUndefined();
    expect(output.text).toContain('12 pages. No bookmarks: the first lines of each page:');
    expect(output.text).toContain('  p2    Typical Application\n');
    expect(output.text).not.toContain('ACME LDO1234');
    expect(output.text).not.toContain('of 12');
  });

  it("indexes a long datasheet by its bookmarks when it has some", async () => {
    const pages = Array.from({ length: 10 }, (_, index) => page(index + 1, `Section ${index + 1}`));
    const output = await datasheet(write('bookmarks.pdf', makePdf(pages, [['1. Pinout', 2], ['2. Application', 5]])), dir);
    expect(output.text).toContain('Its bookmarks:');
    expect(output.text).toContain('p2    1. Pinout');
    expect(output.text).toContain('p5    2. Application');
  });

  it('renders the pages asked for, 8 at most', async () => {
    const path = join(dir, 'datasheets', 'long.pdf');
    expect((await datasheet(path, dir, [2, 10])).images).toHaveLength(2);
    expect(await datasheet(path, dir, [13])).toMatchObject({ code: 1, text: expect.stringContaining('no page 13') });
    expect(await datasheet(path, dir, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toMatchObject({ code: 1 });
  });

  it('follows the PDF a viewer page embeds, and keeps it under the name of the URL', async () => {
    const pdf = makePdf([page(1, 'Pin Assignments')]);
    vi.stubGlobal('fetch', vi.fn(async (url: URL) =>
      url.href.endsWith('/viewer.pdf')
        ? new Response('<html><iframe src="https://cdn.example.com/files/real.pdf?id=1"></iframe></html>', { headers: { 'content-type': 'text/html' } })
        : new Response(new Uint8Array(pdf)),
    ));
    try {
      const output = await datasheet('https://example.com/datasheet/viewer.pdf', dir);
      expect(output.text).toContain('datasheets/viewer.pdf: 1 page, all as images');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a file that does not exist', async () => {
    await expect(datasheet(join(dir, 'nope.pdf'), dir)).rejects.toThrow('no file');
  });
});
