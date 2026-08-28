/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildMcpClassifierInput,
  projectMcpArguments,
  MCP_CLASSIFIER_MAX_DEPTH,
  MCP_CLASSIFIER_MAX_ENTRIES,
  MCP_CLASSIFIER_MAX_STRING_CHARS,
  MCP_CLASSIFIER_MAX_TOTAL_CHARS,
} from './mcp-classifier-input.js';

describe('projectMcpArguments', () => {
  it('passes small argument objects through untouched', () => {
    const args = {
      channel: '#dev',
      text: 'deploy finished',
      count: 3,
      flag: true,
      nothing: null,
      nested: { a: [1, 'b'] },
    };
    expect(projectMcpArguments(args)).toEqual({
      value: args,
      truncated: false,
    });
  });

  it('projects non-object inputs to an empty object', () => {
    expect(projectMcpArguments(undefined)).toEqual({
      value: {},
      truncated: false,
    });
    expect(projectMcpArguments('x')).toEqual({ value: {}, truncated: false });
    expect(projectMcpArguments([1, 2])).toEqual({
      value: {},
      truncated: false,
    });
  });

  it('caps long strings with a visible marker that states the omitted length', () => {
    const long = 'a'.repeat(MCP_CLASSIFIER_MAX_STRING_CHARS + 123);
    const { value, truncated } = projectMcpArguments({ body: long });
    expect(truncated).toBe(true);
    expect(value['body']).toBe(
      `${'a'.repeat(MCP_CLASSIFIER_MAX_STRING_CHARS)}…[truncated 123 chars]`,
    );
  });

  it('shares one character budget across the whole tree', () => {
    const chunk = 'x'.repeat(MCP_CLASSIFIER_MAX_STRING_CHARS);
    const perString = MCP_CLASSIFIER_MAX_STRING_CHARS;
    const count = Math.ceil(MCP_CLASSIFIER_MAX_TOTAL_CHARS / perString) + 2;
    const args: Record<string, string> = {};
    for (let i = 0; i < count; i++) args[`k${i}`] = chunk;

    const { value, truncated } = projectMcpArguments(args);
    expect(truncated).toBe(true);
    const serialized = JSON.stringify(value);
    expect(serialized).toContain('[omitted: argument budget exhausted]');
    // The projection stays in the same order of magnitude as the budget —
    // markers and keys add a little, the payload cannot grow past it.
    expect(serialized.length).toBeLessThan(
      MCP_CLASSIFIER_MAX_TOTAL_CHARS * 1.1,
    );
  });

  it('replaces subtrees nested deeper than the depth cap', () => {
    let leaf: unknown = 'deep';
    for (let i = 0; i < MCP_CLASSIFIER_MAX_DEPTH + 2; i++) leaf = { n: leaf };
    const { value, truncated } = projectMcpArguments(leaf as object);
    expect(truncated).toBe(true);
    expect(JSON.stringify(value)).toContain('[omitted: nesting too deep]');
    expect(JSON.stringify(value)).not.toContain('"deep"');
  });

  it('caps entry counts in arrays and objects', () => {
    const items = Array.from(
      { length: MCP_CLASSIFIER_MAX_ENTRIES + 5 },
      (_, i) => i,
    );
    const wide: Record<string, number> = {};
    for (let i = 0; i < MCP_CLASSIFIER_MAX_ENTRIES + 3; i++) wide[`f${i}`] = i;

    const { value, truncated } = projectMcpArguments({ items, wide });
    expect(truncated).toBe(true);
    const projectedItems = value['items'] as unknown[];
    expect(projectedItems).toHaveLength(MCP_CLASSIFIER_MAX_ENTRIES + 1);
    expect(projectedItems.at(-1)).toBe('…[5 more entries omitted]');
    const projectedWide = value['wide'] as Record<string, unknown>;
    expect(Object.keys(projectedWide)).toHaveLength(
      MCP_CLASSIFIER_MAX_ENTRIES + 1,
    );
    expect(projectedWide['…']).toBe('[3 more keys omitted]');
  });

  it('never throws on values JSON cannot represent', () => {
    const { value } = projectMcpArguments({
      fn: () => 1,
      big: BigInt(7),
      undef: undefined,
    });
    expect(value['undef']).toBeNull();
    expect(typeof value['fn']).toBe('string');
    expect(value['big']).toBe('7');
  });
});

describe('buildMcpClassifierInput', () => {
  it('surfaces server, tool, arguments and only the declared annotations', () => {
    const input = buildMcpClassifierInput({
      serverName: 'github',
      serverToolName: 'create_issue',
      annotations: { destructiveHint: true, readOnlyHint: undefined },
      params: { repo: 'acme/app', title: 'bug' },
    });
    expect(input).toEqual({
      server: 'github',
      tool: 'create_issue',
      annotations: { destructiveHint: true },
      arguments: { repo: 'acme/app', title: 'bug' },
    });
    expect('arguments_truncated' in input).toBe(false);
  });

  it('omits annotations entirely when the server declared none', () => {
    const input = buildMcpClassifierInput({
      serverName: 's',
      serverToolName: 't',
      annotations: {},
      params: {},
    });
    expect(input).toEqual({ server: 's', tool: 't', arguments: {} });
  });

  it('flags truncation at the top level so the classifier cannot miss it', () => {
    const input = buildMcpClassifierInput({
      serverName: 's',
      serverToolName: 't',
      params: { blob: 'z'.repeat(MCP_CLASSIFIER_MAX_STRING_CHARS * 2) },
    });
    expect(input.arguments_truncated).toBe(true);
  });
});
