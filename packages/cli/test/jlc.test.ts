import { afterEach, describe, expect, it, vi } from 'vitest';
import { symbolDir } from '@wire/kicad';
import { chipFootprint, kicadSymbolsFor, searchJlc, type JlcPart } from '../src/jlc.ts';
import { webSearch } from '../src/web.ts';

const component = (code: string, type: string, stock: number, describe: string, extra: object = {}) => ({
  componentCode: code,
  componentModelEn: `MPN-${code}`,
  componentBrandEn: 'Maker',
  componentSpecificationEn: '0402',
  componentTypeEn: 'Multilayer Ceramic Capacitors MLCC - SMD/SMT',
  describe,
  stockCount: stock,
  componentLibraryType: type,
  componentPrices: [{ startNumber: 100, productPrice: 0.002 }, { startNumber: 1, productPrice: 0.004 }],
  ...extra,
});

function answer(body: unknown) {
  return vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('JLCPCB search', () => {
  it('keeps parts in stock that contain every word, basic first, then preferred, then by stock', async () => {
    const fetch = answer({
      code: 200,
      data: {
        componentPageInfo: {
          total: 5,
          list: [
            component('C1', 'expand', 900, '100nF 16V 0402'),
            component('C2', 'base', 10, '100nF 50V 0402'),
            component('C3', 'expand', 5000, '100nF 25V 0402', { preferredComponentFlag: true }),
            component('C4', 'base', 99, '100nF 50V 0603', { componentSpecificationEn: '0603' }),
            component('C5', 'expand', 0, '100nF 16V 0402'),
            { componentCode: 'not a code' },
          ],
        },
      },
    });
    vi.stubGlobal('fetch', fetch);
    const found = await searchJlc('100nF 0402', false);
    expect(found.map((part) => `${part.code} ${part.kind}`)).toEqual(['C2 basic', 'C3 preferred', 'C1 extended']);
    expect(found[0]!.prices).toEqual([{ from: 1, price: 0.004 }, { from: 100, price: 0.002 }]);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({ keyword: '100nF 0402', stockFlag: true });
  });

  it('asks for basic parts only with basic', async () => {
    const fetch = answer({ data: { componentPageInfo: { total: 0, list: [] } } });
    vi.stubGlobal('fetch', fetch);
    expect(await searchJlc('100nF', true)).toEqual([]);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({ componentLibraryType: 'base' });
  });

  it('reports an answer it does not understand', async () => {
    vi.stubGlobal('fetch', answer({ unexpected: true }));
    await expect(searchJlc('x', false)).rejects.toThrow('unexpected format');
  });
});

describe('what to place for a JLCPCB part', () => {
  const part = (category: string, pkg: string): JlcPart => ({
    code: 'C1', mpn: 'X', brand: '', package: pkg, category, description: '', stock: 1, kind: 'basic', prices: [],
  });

  it('gives the KiCad footprint of common chip passives', () => {
    expect(chipFootprint(part('Chip Resistor - Surface Mount', '0603'))).toBe('Resistor_SMD:R_0603_1608Metric');
    expect(chipFootprint(part('Multilayer Ceramic Capacitors MLCC - SMD/SMT', '0402'))).toBe('Capacitor_SMD:C_0402_1005Metric');
    expect(chipFootprint(part('LED Indication - Discrete', '0805'))).toBe('LED_SMD:LED_0805_2012Metric');
    expect(chipFootprint(part('Voltage Regulators', 'SOT-23-5'))).toBeUndefined();
  });

  it.skipIf(!symbolDir())('finds the KiCad symbols named after the start of an MPN (needs KiCad)', () => {
    expect(kicadSymbolsFor('AP2112K-3.3TRG1')[0]).toBe('Regulator_Linear:AP2112K-3.3');
    expect(kicadSymbolsFor('STM32G031F6P6')).toContain('MCU_ST_STM32G0:STM32G031F6Px');
  });
});

describe('web search', () => {
  it('needs an Exa key', async () => {
    vi.stubEnv('EXA_API_KEY', '');
    expect(await webSearch('AO3400A datasheet')).toMatchObject({ code: 1, text: expect.stringContaining('EXA_API_KEY') });
  });

  it('lists titles, URLs and the start of the text, restricted to domains', async () => {
    vi.stubEnv('EXA_API_KEY', 'key');
    const fetch = answer({ results: [{ title: 'AO3400A', url: 'https://www.aosmd.com/AO3400A.pdf', text: '### 30V  N-Channel MOSFET' }] });
    vi.stubGlobal('fetch', fetch);
    expect((await webSearch('AO3400A datasheet', ['aosmd.com'])).text).toBe('AO3400A\n  https://www.aosmd.com/AO3400A.pdf\n  30V N-Channel MOSFET');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({ includeDomains: ['aosmd.com'] });
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ 'x-api-key': 'key' });
  });
});
