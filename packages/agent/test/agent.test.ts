import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { kicadCli } from '@wire/kicad';
import { skillBody, systemPrompt, TOOLS } from '../src/prompt.ts';

const extension = fileURLToPath(new URL('../src/extension.ts', import.meta.url));
const skill = fileURLToPath(new URL('../skills/wire/', import.meta.url));
const example = fileURLToPath(new URL('../../../examples/ldo-indicator', import.meta.url));
const hasKicad = (() => {
  try {
    return Boolean(kicadCli());
  } catch {
    return false;
  }
})();

describe('pi integration', () => {
  const home = mkdtempSync(join(tmpdir(), 'wire-agent-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  async function load() {
    const loader = new DefaultResourceLoader({
      cwd: example,
      agentDir: home,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [extension],
      additionalSkillPaths: [skill],
    });
    await loader.reload();
    return loader;
  }

  it('loads the extension and the skill', async () => {
    const loader = await load();
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect([...extensions[0]!.tools.keys()].sort()).toEqual(['web_search', 'wire_check', 'wire_datasheet', 'wire_erc', 'wire_import', 'wire_netlist', 'wire_parts', 'wire_render', 'wire_show']);
    const { skills, diagnostics } = loader.getSkills();
    expect(diagnostics).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(['wire']);
  });

  it('declares every tool of the extension, and includes the whole skill in the system prompt', async () => {
    const tools = [...(await load()).getExtensions().extensions[0]!.tools.keys()];
    expect(TOOLS.filter((tool) => !['read', 'bash', 'edit', 'write'].includes(tool)).sort()).toEqual(tools.sort());
    const prompt = systemPrompt();
    for (const tool of tools) expect(prompt).toContain(tool);
    expect(prompt).toContain(skillBody());
    expect(skillBody().startsWith('# Designing a schematic with wire')).toBe(true);
  });

  it('runs the tools in the session folder', async () => {
    const tools = (await load()).getExtensions().extensions[0]!.tools;
    const call = (name: string, params: object) => tools.get(name)!.definition.execute('id', params, undefined, undefined, { cwd: example } as never);
    expect(await call('wire_check', {})).toMatchObject({ content: [{ type: 'text', text: expect.stringMatching(/OK$/) }] });
    expect((await call('wire_show', { name: 'R' })).content[0]).toMatchObject({ text: expect.stringContaining('rot 90 : 1: E, 2: W') });
    if (hasKicad) {
      const rendered = await call('wire_render', {});
      expect(rendered.content.map((c) => c.type)).toEqual(['text', 'image']);
    }
  });
});
