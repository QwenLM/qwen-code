/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSkillFromFile } from '@qwen-code/resource';
import { parse as parseShellArguments } from 'shell-quote';
import type {
  BundledSkillRegistration,
  BundledSkillRegistrar,
} from './index.js';

async function renderBundledSkill(
  register: (registrar: BundledSkillRegistrar) => void,
): Promise<string> {
  let definition: BundledSkillRegistration | undefined;
  register({
    registerBundledSkill(candidate) {
      definition = candidate;
    },
  });

  expect(definition?.getBody).toBeTypeOf('function');
  return definition!.getBody!();
}

describe('bundled skill config directory paths', () => {
  beforeEach(() => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'QWEN_');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the configured project directory in run and verification prompts', async () => {
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('QWEN_CONFIG_DIR', '/tmp/full-root');
    vi.resetModules();

    const [{ registerRunSkill }, { registerVerifySkill }, generator] =
      await Promise.all([
        import('./run.js'),
        import('./verify.js'),
        import('./run-skill-generator.js'),
      ]);
    const bodies = await Promise.all([
      renderBundledSkill(registerRunSkill),
      renderBundledSkill(registerVerifySkill),
      renderBundledSkill(generator.registerRunSkillGeneratorSkill),
    ]);

    for (const body of bodies) {
      expect(body).toContain('abc/skills');
      expect(body).not.toContain('.qwen/skills');
    }
  });

  it('quotes a configured project skill directory containing spaces', async () => {
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', 'team config');
    vi.resetModules();

    const { registerRunSkill } = await import('./run.js');
    const body = await renderBundledSkill(registerRunSkill);

    expect(body).toContain(
      `grep -Hm1 '^description:' "$d/team config/skills"/*/SKILL.md`,
    );
  });

  it('uses the complete user root and configured project directory in settings prompts', async () => {
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('QWEN_CONFIG_DIR', '/tmp/full-root');
    vi.resetModules();

    const [{ registerDebugSkill }, { registerMcpConfigSkill }] =
      await Promise.all([import('./debug.js'), import('./mcp-config.js')]);
    const [debugBody, mcpBody] = await Promise.all([
      renderBundledSkill(registerDebugSkill),
      renderBundledSkill(registerMcpConfigSkill),
    ]);

    expect(debugBody).toContain('/tmp/full-root/settings.json');
    expect(debugBody).toContain('abc/settings.json');
    expect(mcpBody).toContain('/tmp/full-root/settings.json');
    expect(mcpBody).toContain('<repo>/abc/settings.json');
    expect(mcpBody).toContain('<repo>/abc/settings.local.json');
    expect(mcpBody).toContain('Configured locations');
    expect(mcpBody).not.toContain('Shared `abc` directory name');
    expect(mcpBody).not.toContain('<repo>/.qwen/');
  });

  it('keeps the agent creator template on the configured resource roots', async () => {
    const source = await fs.readFile(
      new URL('../builtin/agent-creator/SKILL.md', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('.agents/');
    expect(source).toContain('${QWEN_CONFIG_DIR}/agents/');
    expect(source).toContain('~/${QWEN_USER_CONFIG_DIR}/agents/');
  });

  it.each([
    ['agent-creator', 'Creating Custom Agents'],
    ['hook-config', 'Creating Hooks'],
    ['skill-creator', 'Skill Creator'],
  ])(
    'ships Qwen branding and branded configuration paths in %s',
    async (name, heading) => {
      const skillPath = fileURLToPath(
        new URL(`../builtin/${name}/SKILL.md`, import.meta.url),
      );
      const skill = await loadSkillFromFile(skillPath);

      expect(skill).not.toBeNull();
      expect(skill?.body).not.toMatch(/\$\{QODER_/);
      expect(skill?.body).toContain('${QWEN_CONFIG_DIR}');
      expect(skill?.body).toContain('${QWEN_USER_CONFIG_DIR}');
      expect(skill?.body).not.toContain('${BRAND_');
      const { substituteSkillBody } = await import(
        '../../utils/argumentSubstitution.js'
      );
      const body = substituteSkillBody(
        { ...skill!, isBuiltin: true },
        { skillDir: `/builtin/${name}`, sessionId: 'test-session' },
      );
      const cliName = 'Qwen Code';

      expect(body.split('\n')[0]).toBe(`# ${heading} for ${cliName}`);
      expect(body).not.toContain('${BRAND_CLI_NAME');
      expect(body).not.toContain('${BRAND_ENV_');
      expect(body).not.toMatch(/\$\{(?:PROJECT_CONFIG_DIR|USER_CONFIG_DIR)\}/);
      expect(body).not.toMatch(/\$\{(?:QWEN|QODER)_(?:USER_)?CONFIG_DIR\}/);
      expect(body).not.toMatch(/\$\{QODER_/);
      if (name === 'hook-config') {
        for (const variable of [
          'QWEN_PROJECT_DIR',
          'QWEN_PLUGIN_ROOT',
          'QWEN_PLUGIN_DATA',
        ]) {
          expect(body).toContain('${' + variable + '}');
        }
        const args = body.match(
          /jq -r (--arg product .* '\.title \/\/ \$product')/,
        );
        expect(args).not.toBeNull();
        expect(parseShellArguments(args![1])).toEqual([
          '--arg',
          'product',
          cliName,
          '.title // $product',
        ]);
      }
    },
  );
});
