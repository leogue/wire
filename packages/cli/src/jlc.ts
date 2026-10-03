import { z } from 'zod';
import { searchSymbols } from '@wire/kicad';

/**
 * JLCPCB's parts (LCSC codes), through the public API of jlcpcb.com's parts library: unofficial, so every
 * answer is validated, and a failure is reported without stopping anything else. These are commercial data
 * (stock, price, assembly class), never pins: pins come from KiCad's symbols or the datasheet.
 */

const API = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
const TIMEOUT_MS = 20_000;
/** Parts asked from JLCPCB per search, before keeping those that contain every word. */
const PAGE = 100;

const PartSchema = z.object({
  componentCode: z.string().regex(/^C\d+$/),
  componentModelEn: z.string().nullish(),
  componentBrandEn: z.string().nullish(),
  componentSpecificationEn: z.string().nullish(),
  componentTypeEn: z.string().nullish(),
  describe: z.string().nullish(),
  stockCount: z.number().int().nonnegative().nullish(),
  componentLibraryType: z.string().nullish(),
  preferredComponentFlag: z.boolean().nullish(),
  componentPrices: z.array(z.object({ startNumber: z.number(), productPrice: z.number() })).nullish(),
  dataManualUrl: z.string().nullish(),
  lcscGoodsUrl: z.string().nullish(),
});
const ResponseSchema = z.object({ data: z.object({ componentPageInfo: z.object({ total: z.number(), list: z.array(z.unknown()) }) }) });

export interface JlcPart {
  readonly code: string;
  readonly mpn: string;
  readonly brand: string;
  readonly package: string;
  readonly category: string;
  readonly description: string;
  readonly stock: number;
  /** JLCPCB assembly class: basic parts and preferred ones need no extra feeder fee. */
  readonly kind: 'basic' | 'preferred' | 'extended';
  /** Unit price from each quantity, in USD. */
  readonly prices: readonly { readonly from: number; readonly price: number }[];
  readonly datasheet?: string;
  readonly url?: string;
}

function toPart(value: unknown): JlcPart | undefined {
  const parsed = PartSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const c = parsed.data;
  const https = (url: string | null | undefined) => (url && /^https:\/\//.test(url) ? url : undefined);
  return {
    code: c.componentCode,
    mpn: c.componentModelEn ?? '',
    brand: c.componentBrandEn ?? '',
    package: c.componentSpecificationEn ?? '',
    category: c.componentTypeEn ?? '',
    description: (c.describe ?? '').replace(/\s+/g, ' ').trim(),
    stock: c.stockCount ?? 0,
    kind: c.componentLibraryType === 'base' ? 'basic' : c.preferredComponentFlag ? 'preferred' : 'extended',
    prices: (c.componentPrices ?? []).map((p) => ({ from: p.startNumber, price: p.productPrice })).sort((a, b) => a.from - b.from),
    ...(https(c.dataManualUrl) && { datasheet: https(c.dataManualUrl) }),
    ...(https(c.lcscGoodsUrl) && { url: https(c.lcscGoodsUrl) }),
  };
}

async function query(body: Record<string, unknown>): Promise<{ total: number; parts: JlcPart[] }> {
  let response: Response;
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (wire)' },
      body: JSON.stringify({ currentPage: 1, pageSize: PAGE, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`JLCPCB does not answer (${(error as Error).message}): try again later`);
  }
  if (!response.ok) throw new Error(`JLCPCB answered HTTP ${response.status}: try again later`);
  const parsed = ResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error('JLCPCB answered in an unexpected format: its API may have changed');
  const { total, list } = parsed.data.data.componentPageInfo;
  return { total, parts: list.flatMap((item) => toPart(item) ?? []) };
}

const rank = { basic: 0, preferred: 1, extended: 2 } as const;

/**
 * Parts in stock whose code, MPN, brand, package, category or description contain every word of `text`
 * (JLCPCB's own matching is loose), basic first, then preferred, then by stock.
 */
export async function searchJlc(text: string, basicOnly: boolean): Promise<JlcPart[]> {
  const { parts } = await query({ keyword: text, stockFlag: true, ...(basicOnly && { componentLibraryType: 'base' }) });
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return parts
    .filter((part) => part.stock > 0 && (!basicOnly || part.kind === 'basic'))
    .filter((part) => {
      const haystack = [part.code, part.mpn, part.brand, part.package, part.category, part.description].join(' ').toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.stock - a.stock);
}

/** One part by its LCSC code (`C51118`), in stock or not. */
export async function jlcPart(code: string): Promise<JlcPart | undefined> {
  const { parts } = await query({ keyword: code });
  return parts.find((part) => part.code === code);
}

/**
 * KiCad symbols for a manufacturer part number: those whose name starts the MPN (`AP2112K-3.3` for
 * `AP2112K-3.3TRG1`; KiCad's `x` stands for any character, `STM32G031F6Px` for `STM32G031F6P6`), longest first.
 */
export function kicadSymbolsFor(mpn: string): string[] {
  const upper = mpn.toUpperCase();
  if (upper.length < 3) return [];
  const matches = (name: string) => name.length <= upper.length && [...name].every((char, i) => char === 'x' || char.toUpperCase() === upper[i]);
  return searchSymbols(upper.slice(0, Math.min(5, upper.length)))
    .map((symbol) => symbol.id)
    .filter((id) => matches(id.slice(id.indexOf(':') + 1)))
    .sort((a, b) => b.length - a.length);
}

/** KiCad footprint of a common chip package (`0402` resistor → `Resistor_SMD:R_0402_1005Metric`), from the part's category. */
export function chipFootprint(part: JlcPart): string | undefined {
  const metric: Record<string, string> = { '0201': '0603', '0402': '1005', '0603': '1608', '0805': '2012', '1206': '3216', '1210': '3225' };
  const size = metric[part.package];
  if (!size) return undefined;
  const category = part.category.toLowerCase();
  const [library, prefix] = /resistor/.test(category)
    ? ['Resistor_SMD', 'R']
    : /capacitor/.test(category)
      ? ['Capacitor_SMD', 'C']
      : /inductor|ferrite/.test(category)
        ? ['Inductor_SMD', 'L']
        : /led|light emitting/.test(category)
          ? ['LED_SMD', 'LED']
          : [];
  return library ? `${library}:${prefix}_${part.package}_${size}Metric` : undefined;
}
