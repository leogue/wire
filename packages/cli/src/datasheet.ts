import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Output } from './commands.ts';

/**
 * Datasheets are read as images: pin assignments, tables and application circuits do not survive text
 * extraction. A short PDF comes whole, as images. A longer one comes as an index of its pages, from its
 * bookmarks or else from the first lines of each page, so that the pages that matter can be asked for.
 */

/** Up to this many pages, a datasheet comes as images straight away; also the most pages per request. */
export const MAX_PAGES = 8;
const PAGE_WIDTH_PX = 1400;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_INDEX_LINES = 150;

function tool(command: string): string {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`${command} not found: install poppler (brew install poppler, apt install poppler-utils)`);
  }
}

/** The PDF in the project's `datasheets/`: downloaded once from a URL, or copied there from a local file. */
async function fetchPdf(source: string, dir: string): Promise<string> {
  const folder = join(dir, 'datasheets');
  mkdirSync(folder, { recursive: true });
  if (!/^https?:\/\//i.test(source)) {
    const path = resolve(source);
    if (!existsSync(path)) throw new Error(`no file ${path}`);
    if (resolve(path, '..') === resolve(folder)) return path;
    const copy = join(folder, basename(path));
    copyFileSync(path, copy);
    return copy;
  }
  const url = new URL(source);
  const stem = decodeURIComponent(basename(url.pathname)).replace(/\.pdf$/i, '').replace(/[^\w.+-]/g, '_').slice(0, 80) || 'datasheet';
  const path = join(folder, `${stem}.pdf`);
  if (existsSync(path)) return path;
  let bytes = await download(url);
  if (!isPdf(bytes)) {
    // A viewer page (LCSC's, for one) embeds the PDF: follow the PDF it shows, once.
    const embedded = /\bsrc=["'](https:\/\/[^"']+?\.pdf(?:\?[^"']*)?)["']/i.exec(new TextDecoder().decode(bytes))?.[1];
    if (embedded) bytes = await download(new URL(embedded));
  }
  if (!isPdf(bytes)) throw new Error(`${source} is not a PDF (a web page? look for the PDF link on it)`);
  writeFileSync(path, bytes);
  return path;
}

const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';

async function download(url: URL): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (wire datasheet reader)' }, signal: AbortSignal.timeout(60_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`${url.href}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) throw new Error(`${url.href}: larger than ${MAX_PDF_BYTES / 1024 / 1024} MB`);
  return bytes;
}

interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineItem[];
}

/** The PDF's bookmarks as `p<page>  <title>` lines, indented by level; deep levels are dropped to stay short. */
async function outlineLines(pdf: Awaited<ReturnType<typeof getDocument>['promise']>): Promise<string[]> {
  const outline = ((await pdf.getOutline()) ?? []) as OutlineItem[];
  const entries: { depth: number; line: string }[] = [];
  async function walk(items: OutlineItem[], depth: number) {
    for (const item of items) {
      let page = '?';
      try {
        const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest) && dest[0]) page = String((await pdf.getPageIndex(dest[0] as never)) + 1);
      } catch {
        // A broken bookmark keeps its title, without a page.
      }
      entries.push({ depth, line: `${'  '.repeat(depth)}p${page.padEnd(4)} ${item.title.replace(/\s+/g, ' ').trim()}` });
      await walk(item.items ?? [], depth + 1);
    }
  }
  await walk(outline, 0);
  let depth = Math.max(0, ...entries.map((entry) => entry.depth));
  while (depth > 0 && entries.filter((entry) => entry.depth <= depth).length > MAX_INDEX_LINES) depth--;
  return entries.filter((entry) => entry.depth <= depth).slice(0, MAX_INDEX_LINES).map((entry) => entry.line);
}

/** The first lines of each page, running headers and footers left out: they are usually its section titles. */
function pageTitles(path: string, pages: number): string[] {
  const pdftotext = tool('pdftotext');
  const texts = Array.from({ length: pages }, (_, index) => {
    try {
      return execFileSync(pdftotext, ['-layout', '-f', String(index + 1), '-l', String(index + 1), path, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  });
  // A line found on most pages (digits aside: "Page 3 of 18") is a running header or footer.
  const shape = (line: string) => line.replace(/\d+/g, '#').replace(/\s+/g, ' ');
  const count = new Map<string, number>();
  for (const lines of texts) for (const line of new Set(lines.map(shape))) count.set(line, (count.get(line) ?? 0) + 1);
  const running = (line: string) => pages > 2 && (count.get(shape(line)) ?? 0) > pages / 2;
  return texts.map((lines, index) => {
    const title = lines
      .filter((line) => !running(line) && /[A-Za-z]{3}/.test(line))
      .slice(0, 2)
      .map((line) => line.split(/\s{2,}/).join(' | '))
      .join(' / ');
    return `p${String(index + 1).padEnd(4)} ${title.slice(0, 140) || '(no text: a drawing or a scan)'}`;
  });
}

/** Pages as PNG files next to the PDF (`datasheets/<name>/page-<n>.png`), rendered once. */
function renderPages(path: string, pages: readonly number[]): string[] {
  const pdftoppm = tool('pdftoppm');
  const folder = path.replace(/\.pdf$/i, '');
  mkdirSync(folder, { recursive: true });
  return pages.map((page) => {
    const png = join(folder, `page-${page}.png`);
    if (!existsSync(png)) {
      execFileSync(pdftoppm, ['-f', String(page), '-l', String(page), '-singlefile', '-png', '-scale-to-x', String(PAGE_WIDTH_PX), '-scale-to-y', '-1', path, png.slice(0, -4)], { stdio: 'pipe' });
    }
    return png;
  });
}

/** `1,2,4-6` → [1, 2, 4, 5, 6]. */
export function parsePages(text: string): number[] | undefined {
  const pages: number[] = [];
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return undefined;
    const [from, to] = [Number(match[1]), Number(match[2] ?? match[1])];
    for (let page = from; page <= to && pages.length <= 100; page++) pages.push(page);
  }
  return pages.length > 0 ? pages : undefined;
}

/**
 * `wire datasheet SOURCE [DIR] [--pages 1,2,8]`: a datasheet (URL or PDF file), kept in DIR/datasheets/.
 * Without pages: every page as an image if it has at most 8, else an index of its pages. With pages: those
 * pages as images (8 at most).
 */
export async function datasheet(source: string, dir: string, pages?: readonly number[]): Promise<Output> {
  const path = await fetchPdf(source, dir);
  const loading = getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 });
  const pdf = await loading.promise;
  const count = pdf.numPages;
  const where = `datasheets/${basename(path)}: ${count} page${count > 1 ? 's' : ''}`;
  const READ = 'Read pin assignments, tables and application circuits on the page images, never on extracted text.';
  try {
    if (pages && pages.length > 0) {
      const wrong = pages.filter((page) => page < 1 || page > count);
      if (wrong.length > 0) return { code: 1, text: `${where}: no page ${wrong.join(', ')}` };
      if (pages.length > MAX_PAGES) return { code: 1, text: `${where}: at most ${MAX_PAGES} pages at a time` };
      const images = renderPages(path, pages);
      return { code: 0, text: [`${where}, pages ${pages.join(', ')} as images:`, ...images.map((png, i) => `  page ${pages[i]}: ${png}`), READ].join('\n'), images };
    }
    if (count <= MAX_PAGES) {
      const all = Array.from({ length: count }, (_, index) => index + 1);
      const images = renderPages(path, all);
      return { code: 0, text: [`${where}, all as images:`, ...images.map((png, i) => `  page ${all[i]}: ${png}`), READ].join('\n'), images };
    }
    const outline = await outlineLines(pdf);
    const index = outline.length > 0 ? outline : pageTitles(path, count);
    return {
      code: 0,
      text: [
        `${where}. ${outline.length > 0 ? 'Its bookmarks:' : 'No bookmarks: the first lines of each page:'}`,
        ...index.map((line) => `  ${line}`),
        `Ask for the pages you need as images with pages (at most ${MAX_PAGES} at a time). ${READ}`,
      ].join('\n'),
    };
  } finally {
    await loading.destroy();
  }
}
