/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('browser-use skill', () => {
  it('uses Node REPL and the current Browser SDK contract', () => {
    const skill = fs.readFileSync(
      new URL('../skills/browser-use/SKILL.md', import.meta.url),
      'utf8',
    );
    expect(skill).toContain('setupBrowserRuntime()');
    expect(skill).toContain('node_repl_add_node_module_dir');
    expect(skill).toContain('/dist/index.js');
    expect(skill).toContain('published npm package');
    expect(skill).toContain('node_modules/playwright-core/package.json');
    expect(skill).toContain('node_repl');
    expect(skill).toContain('nodeRepl.write');
    expect(skill).toContain('browser.tabs.finalize');
    expect(skill).toContain('complete set');
    expect(skill).toContain('handoff in each later turn');
    expect(skill).toContain('node_id');
    expect(skill).not.toContain('setupBrowserRuntime(nodeRepl)');
    expect(skill).not.toContain('npm install --no-save');
    expect(skill).not.toContain('dev.network');
    expect(skill).not.toContain('markDeliverable');
    expect(skill).not.toContain('markHandoff');
    expect(skill).not.toContain('domSnapshot({ filter:');

    const manifest = JSON.parse(
      fs.readFileSync(
        new URL('../qwen-extension.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('mcpServers');
  });
});
