/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';

const loadSkill = () => {
  const file = fileURLToPath(new URL('./SKILL.md', import.meta.url));
  return parseSkillContent(fs.readFileSync(file, 'utf8'), file);
};

describe('bundled computer-use skill', () => {
  it.each([true, false])(
    'runs the forwarding example with desktop relay available=%s',
    async (desktopAvailable) => {
      const { body } = loadSkill();
      const example = body.match(/```js\n([\s\S]*?)\n```/)?.[1];
      expect(example).toBeDefined();
      const screenshot = {
        type: 'image',
        data: 'screenshot',
        mimeType: 'image/png',
      };
      const result = {
        content: [{ type: 'text', text: 'macos' }, screenshot],
      };
      const desktop = vi.fn().mockResolvedValue(result);
      const regular = vi.fn().mockResolvedValue(result);
      const text = vi.fn();
      const image = vi.fn();
      // Mirror the code-mode host (host.ts): a Proxy that throws on an
      // unknown key, so an unbound desktop tool must be probed with `in`.
      const toolTarget = Object.assign(Object.create(null), {
        mcp__node_repl__node_repl: regular,
        ...(desktopAvailable
          ? { mcp__desktop_node_repl__node_repl: desktop }
          : {}),
      }) as Record<string, unknown>;
      const tools = new Proxy(toolTarget, {
        get(target, property) {
          if (typeof property === 'string' && !(property in target)) {
            throw new Error(
              `Unknown or unavailable code mode tool: ${property}`,
            );
          }
          return Reflect.get(target, property) as unknown;
        },
      });
      await runInNewContext(`(async () => {${example}})()`, {
        tools,
        ALL_TOOLS: desktopAvailable
          ? [{ name: 'mcp__desktop_node_repl__node_repl' }]
          : [],
        code: 'return platform',
        text,
        image,
      });
      expect(desktopAvailable ? desktop : regular).toHaveBeenCalledWith({
        code: 'return platform',
      });
      expect(desktopAvailable ? regular : desktop).not.toHaveBeenCalled();
      expect(text).toHaveBeenCalledWith('macos');
      expect(image).toHaveBeenCalledWith(screenshot);
    },
  );

  it('loads a self-contained App workflow for every connected platform', () => {
    const config = loadSkill();
    const { body } = config;
    expect(config.name).toBe('computer-use');
    expect(config.allowedTools).toBeUndefined();
    expect(body).toContain('`desktop-node-repl` MCP server');
    expect(body).toContain('mcp__desktop_node_repl__node_repl');
    expect(body).toContain('skip the installation commands below');
    expect(body).toContain('ComputerUse.create()');
    expect(body).toContain('await computer.getPlatform()');
    expect(body).toContain('computer.getApp(');
    expect(body).toContain('app.getState(');
    expect(body).toContain('app.click(37)');
    expect(body).not.toMatch(
      /references\/|computer\.observeWindow\(|computer\.listWindows\(|elementToken|windowId/,
    );
  });

  it('requires current observations and keeps uncertain actions from blind retry', () => {
    const { body } = loadSkill();
    expect(body).toContain('Only currently captured actionable IDs');
    expect(body).toContain(
      'Partial, unconfirmed or cancelled actions must not be blindly repeated',
    );
    expect(body).toContain('Observe state before');
    expect(body).toContain('ambiguous matches fail');
    expect(body).toContain('newer external clipboard change');
  });
});
