import { z } from 'zod';
import type { Output } from './commands.ts';

/** Web search through Exa (exa.ai), for anything: datasheets, application notes, reference designs… Needs EXA_API_KEY. */

const API = 'https://api.exa.ai/search';
const RESULTS = 8;

const ResponseSchema = z.object({
  results: z.array(z.object({ title: z.string().nullish(), url: z.string(), text: z.string().nullish() })),
});

/** `wire web QUERY [--domain example.com]`: pages matching the query, with the start of their text. */
export async function webSearch(query: string, domains: readonly string[] = []): Promise<Output> {
  const key = process.env.EXA_API_KEY;
  if (!key) return { code: 1, text: 'web search is not configured: set EXA_API_KEY (in the .env file at the root of wire)' };
  let response: Response;
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ query, numResults: RESULTS, ...(domains.length > 0 && { includeDomains: domains }), contents: { text: { maxCharacters: 300 } } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { code: 1, text: `Exa does not answer (${(error as Error).message})` };
  }
  if (!response.ok) return { code: 1, text: `Exa answered HTTP ${response.status}${response.status === 401 ? ': check EXA_API_KEY' : ''}` };
  const parsed = ResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return { code: 1, text: 'Exa answered in an unexpected format' };
  if (parsed.data.results.length === 0) return { code: 0, text: `no result for "${query}"` };
  return {
    code: 0,
    text: parsed.data.results
      .map((r) => `${r.title?.replace(/\s+/g, ' ').trim() || '(no title)'}\n  ${r.url}\n  ${(r.text ?? '').replace(/[#*]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 240)}`)
      .join('\n'),
  };
}
