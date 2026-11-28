/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  normalizeMcpRuleName,
  normalizeMcpSegment,
  parseMcpToolName,
} from './mcp-names.js';

describe('Unicode MCP identities', () => {
  it('keeps different Chinese tools distinct even with the same ASCII slug', () => {
    const names = [
      '文档格式转换_查询',
      '文档格式转换_提交',
      '查询_query',
      '提交_query',
    ];
    const aliases = names.map(normalizeMcpSegment);
    // Persisted permissions rely on these IDs remaining stable across releases.
    expect(aliases.slice(0, 2)).toEqual(['u_611aec98eddc', 'u_6512fe996f7f']);
    expect(new Set(aliases).size).toBe(names.length);
    for (const alias of aliases) {
      expect(alias).toMatch(/^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/);
      expect(normalizeMcpSegment(alias)).toBe(alias);
      expect(parseMcpToolName(`mcp__server__${alias}`)).toEqual({
        serverName: 'server',
        toolName: alias,
      });
    }
  });

  it('is stable across discovery order and fresh module instances', async () => {
    const names = ['查询', '提交', '服务端', '工具😀', 'é', 'e\u0301'];
    const aliases = names.map(normalizeMcpSegment);
    vi.resetModules();
    const fresh = await import('./mcp-names.js');
    expect(
      [...names].reverse().map(fresh.normalizeMcpSegment).reverse(),
    ).toEqual(aliases);
    expect(new Set(aliases).size).toBe(names.length);
  });

  it.each([
    ['read_file', 'read_file'],
    ['my-server', 'my-server'],
    ['_my__tool_', 'my_tool'],
    ['tool with spaces', 'tool_with_spaces'],
    ['', ''],
    ['!@#', ''],
  ])('preserves existing ASCII normalization: %s', (name, expected) => {
    expect(normalizeMcpSegment(name)).toBe(expected);
  });

  it('normalizes exact Chinese rules and server wildcards with the same IDs', () => {
    const server = normalizeMcpSegment('转换服务');
    const tool = normalizeMcpSegment('文档格式转换_查询');
    expect(normalizeMcpRuleName('mcp__转换服务__文档格式转换_查询')).toBe(
      `mcp__${server}__${tool}`,
    );
    expect(normalizeMcpRuleName('mcp__转换服务__*')).toBe(`mcp__${server}__*`);
    expect(normalizeMcpRuleName('mcp__转换服务')).toBe(`mcp__${server}`);
    expect(normalizeMcpRuleName('mcp__*__文档格式转换_查询')).toBe(
      `mcp__*__${tool}`,
    );
    expect(normalizeMcpRuleName('mcp__*')).toBe('mcp__*');
    expect(normalizeMcpRuleName('mcp__srv__文档__查询')).toBe(
      `mcp__srv__${normalizeMcpSegment('文档__查询')}`,
    );
    expect(normalizeMcpRuleName('Read')).toBe('Read');
  });
});
