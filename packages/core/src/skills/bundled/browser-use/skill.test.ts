/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '../../../test-utils/config.js';
import { SkillManager } from '../../skill-manager.js';

const skillUrl = new URL('./SKILL.md', import.meta.url);
const skill = fs.readFileSync(skillUrl, 'utf8');

describe('bundled browser-use skill', () => {
  it('is discovered without a Qwen extension', async () => {
    const manager = new SkillManager(makeFakeConfig());

    await expect(
      manager.loadSkill('browser-use', 'bundled'),
    ).resolves.toMatchObject({
      name: 'browser-use',
      level: 'bundled',
      filePath: fileURLToPath(skillUrl),
    });
  });

  it('loads its bundled runtime through the generic Node REPL', () => {
    expect(skill).toContain('If `node_repl` is unavailable');
    expect(skill).toContain('qwen mcp add --scope user node-repl');
    expect(skill).toContain('node_repl_add_node_module_dir');
    expect(skill).toContain('<skill-base>/runtime/node_modules');
    expect(skill).toContain('node_modules/playwright-core/package.json');
    expect(skill).toContain("import('/absolute/skill/base/runtime/index.js')");
    expect(skill).not.toContain('<extension-root>');
    expect(skill).not.toContain('qwen extensions install');
    expect(skill).not.toContain('npm install --no-save');
  });

  it('uses the current Browser SDK contract', () => {
    expect(skill).toContain('setupBrowserRuntime()');
    expect(skill).toContain('nodeRepl.write');
    expect(skill).toContain('browser.tabs.finalize');
    expect(skill).toContain('complete set');
    expect(skill).toContain('handoff in each later turn');
    expect(skill).toContain('node_id');
    expect(skill).not.toContain('setupBrowserRuntime(nodeRepl)');
    expect(skill).not.toContain('dev.network');
    expect(skill).not.toContain('markDeliverable');
    expect(skill).not.toContain('markHandoff');
    expect(skill).not.toContain('domSnapshot({ filter:');
  });
});
