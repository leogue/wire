import { parseArgs } from 'node:util';
import { build, check, datasheet, ercCommand, importPart, netlist, parsePages, parts, render, schema, show, webSearch, type Output } from './commands.ts';

/** The `wire` commands; anything else on the command line goes to the agent. */
export const COMMANDS = new Set(['check', 'netlist', 'build', 'render', 'erc', 'parts', 'show', 'import', 'datasheet', 'web', 'schema', 'help']);

const HELP = `wire: the AI harness for electronics design.

usage:
  wire [pi options] [prompt]  start the design agent in this folder (pi: /login and /model choose the model)
  wire --print "PROMPT"       run the agent on one request, without the terminal interface
  wire agent --help           the agent's options (pi's)
  wire <command> [arguments]  the commands below, which the agent's tools also run

project commands (DIR: the project folder, default "."):
  check [DIR]                 check everything; print where each frame and block lies
  netlist [DIR]               wire's nets (no KiCad needed)
  build [DIR] [--out OUT]     check, write OUT/kicad/schematic.kicad_sch (default OUT: DIR/out) and its PDF;
                              the nets are verified against KiCad's own netlist
  render [DIR] [--page N]     build, then one PNG per sheet in OUT (OUT/<sheet>.png)
  erc [DIR]                   build, then KiCad's electrical rules check

library commands (--dir DIR: the project whose parts/ to include, default "."):
  parts [QUERY]               built-in and project parts, then KiCad symbols, matching every word of QUERY
  parts QUERY --jlc [--basic] JLCPCB parts in stock (MPN, LCSC code, or value and package), basic first
  show NAME                   a part's pins and their sides on the grid (per rotation, per block mode);
                              NAME may be a KiCad symbol (Library:Name) or a JLCPCB part (C51118)
  import Lib:Name [DIR]       write a KiCad symbol as DIR/parts/<Name>.json (--as NAME, --force to replace)
  datasheet SOURCE [DIR]      a datasheet (URL or PDF) kept in DIR/datasheets/: every page as a PNG when it has
                              8 pages or fewer, else an index of its pages; --pages 1,2,5-7 renders those pages

  web QUERY [--domain D]      web search (Exa: EXA_API_KEY), restricted to the sites D if given
  schema part|sheet|project   JSON Schema of a file kind
  help                        this text

KiCad 10 is needed by build, render, erc and the KiCad symbols (kicad-cli: PATH, /Applications/KiCad or KICAD_CLI);
render and datasheet also need poppler (pdftoppm, pdftotext).`;

/** Runs a `wire` command (`argv` without the program name). */
export async function runCli(argv: string[]): Promise<Output> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      page: { type: 'string' },
      dir: { type: 'string' },
      as: { type: 'string' },
      pages: { type: 'string' },
      force: { type: 'boolean' },
      jlc: { type: 'boolean' },
      basic: { type: 'boolean' },
      domain: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  const dir = rest[0] ?? '.';
  const page = values.page === undefined ? undefined : Number(values.page);
  if (page !== undefined && !Number.isInteger(page)) return { code: 2, text: '--page takes a page number' };
  switch (values.help ? 'help' : command) {
    case 'check':
      return check(dir);
    case 'netlist':
      return netlist(dir);
    case 'build':
      return build(dir, values.out);
    case 'render':
      return render(dir, page, values.out);
    case 'erc':
      return ercCommand(dir, values.out);
    case 'parts':
      return parts(rest.join(' '), values.dir ?? '.', values.jlc || values.basic ? { basic: values.basic ?? false } : undefined);
    case 'show':
      return rest[0] ? show(rest[0], values.dir ?? '.') : { code: 2, text: 'usage: wire show NAME' };
    case 'import':
      return rest[0] ? importPart(rest[0], rest[1] ?? '.', values.as, values.force) : { code: 2, text: 'usage: wire import Lib:Name [DIR] [--as NAME] [--force]' };
    case 'datasheet': {
      if (!rest[0]) return { code: 2, text: 'usage: wire datasheet URL|PDF [DIR] [--pages 1,2,5-7]' };
      const pages = values.pages === undefined ? undefined : parsePages(values.pages);
      if (values.pages !== undefined && !pages) return { code: 2, text: '--pages takes page numbers and ranges: 1,2,5-7' };
      return datasheet(rest[0], rest[1] ?? '.', pages);
    }
    case 'web':
      return rest.length > 0 ? webSearch(rest.join(' '), values.domain ?? []) : { code: 2, text: 'usage: wire web QUERY [--domain example.com]' };
    case 'schema':
      return schema(rest[0] ?? '');
    case undefined:
    case 'help':
      return { code: 0, text: HELP };
    default:
      return { code: 2, text: `unknown command "${command}"\n\n${HELP}` };
  }
}
