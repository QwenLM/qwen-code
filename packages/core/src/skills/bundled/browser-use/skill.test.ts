/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
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
    expect(skill).toContain('@qwen-code/node-repl-mcp@latest');
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

  it('passes the complete screenshot and metadata to emitImage', async () => {
    const example = [...skill.matchAll(/```js\n([\s\S]*?)```/g)].find(
      ([, code]) => code.includes('tab.screenshot()'),
    )?.[1];
    expect(example).toBeDefined();

    const shot = {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/jpeg',
      metadata: {
        width: 1280,
        height: 720,
        viewport: { width: 1280, height: 720 },
        devicePixelRatio: 2,
        coordinateSpace: 'css-pixels',
      },
    };
    const screenshot = vi.fn().mockResolvedValue(shot);
    const output: unknown[] = [];

    await runInNewContext(`(async () => {\n${example}\n})()`, {
      tab: { screenshot },
      nodeRepl: {
        write: (text: string) => output.push({ text }),
        emitImage: async (image: unknown) => {
          output.push({ image });
        },
      },
    });

    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(output).toEqual([{ image: shot }]);
  });
});
