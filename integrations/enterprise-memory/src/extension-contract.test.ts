/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface HookCommand {
  type: string;
  command: string;
  timeout: number;
  async?: boolean;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

describe('Qwen extension contract', () => {
  it('uses only the reviewed deterministic hook surface', async () => {
    const hooks = JSON.parse(
      await readFile(new URL('../hooks/hooks.json', import.meta.url), 'utf8'),
    ) as Record<string, HookGroup[]>;

    expect(Object.keys(hooks).sort()).toEqual(
      [
        'PostToolUse',
        'PostToolUseFailure',
        'SessionStart',
        'Stop',
        'StopFailure',
        'UserPromptSubmit',
      ].sort(),
    );
    expect(hooks['PostToolBatch']).toBeUndefined();
    expect(hooks['SessionEnd']).toBeUndefined();
    for (const groups of Object.values(hooks)) {
      for (const hook of groups.flatMap((group) => group.hooks)) {
        expect(hook.type).toBe('command');
        expect(hook.command).toMatch(/^qwen-memory-agent-launcher /);
        expect(hook.command).toContain('${CLAUDE_PLUGIN_ROOT}');
        expect(hook.command).not.toMatch(/token|secret|api.?key/i);
        expect(hook.timeout).toBeGreaterThan(0);
        expect(hook.timeout).toBeLessThanOrEqual(5_000);
      }
    }
    expect(hooks['Stop']?.[0]?.hooks[0]?.async).not.toBe(true);
    expect(hooks['PostToolUse']?.[0]?.hooks[0]?.async).toBe(true);
    expect(hooks['PostToolUseFailure']?.[0]?.hooks[0]?.async).toBe(true);
  });

  it('exposes one bounded MCP server from the extension manifest', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../qwen-extension.json', import.meta.url),
        'utf8',
      ),
    ) as {
      hooks: string;
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    expect(manifest.hooks).toBe('hooks/hooks.json');
    expect(Object.keys(manifest.mcpServers)).toEqual(['enterprise-memory']);
    expect(manifest.mcpServers['enterprise-memory']).toEqual({
      command: 'qwen-memory-agent-launcher',
      args: ['node', '${extensionPath}${/}dist${/}agent${/}main.js', 'mcp'],
      cwd: '${extensionPath}',
    });
  });
});
