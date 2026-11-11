/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ToolExposureHints } from '../codemode/types.js';
import {
  ineffectiveDeferredNames,
  mcpDeclarationBudget,
  patternsMayDeferMcp,
  readDeferredToolPatterns,
  readMcpDeferThreshold,
  resolveExposure,
  resolveMcpRegistration,
  type ExposureTool,
} from './tool-exposure.js';

const tool = (
  name: string,
  exposureHints: ToolExposureHints = {},
): ExposureTool => ({ name, exposureHints });
const mcp = { namespace: { kind: 'mcp', server: 'docs' } } as const;

// Agent views: on/only have CodeMode; meta lacks it but declares mcp_call; bare has neither.
const agents = {
  on: { codeMode: 'on', metaCall: false },
  only: { codeMode: 'only', metaCall: false },
  meta: { metaCall: true },
  bare: { metaCall: false },
} as const;

describe('resolveExposure', () => {
  it.each([
    ['model-only stays declared', tool('Agent', { modelOnly: true }), ['Agent'], true, 'only', 'declared'],
    ['model-only MCP tools stay declared', tool('mcp__docs__a', { ...mcp, modelOnly: true }), [], true, 'on', 'declared'],
    ['tools without a structured result are inlined', tool('NotebookEdit'), [], false, 'only', 'inline'],
    ['meta tools are hidden from CodeMode agents', tool('mcp_call', { metaTool: 'mcp' }), [], true, 'on', 'hidden'],
    ['meta tools serve agents without CodeMode', tool('mcp_call', { metaTool: 'mcp' }), ['*'], true, 'meta', 'declared'],
    ['pinned beats patterns and modes', tool('mcp__docs__a', { ...mcp, pinned: true }), ['*'], true, 'on', 'declared'],
    ['!name beats an earlier include', tool('ImageGen', { defaultDeferred: true }), ['*', '!ImageGen'], false, 'on', 'declared'],
    ['!pattern beats the tool default', tool('ImageGen', { defaultDeferred: true }), ['!Image*'], false, 'on', 'declared'],
    ['include by exact name', tool('Read'), ['Read'], false, 'on', 'deferred'],
    ['include by wildcard', tool('mcp__docs__search', mcp), ['mcp__docs__*'], false, 'on', 'deferred'],
    ['wildcards anchor the whole name', tool('mcp__docs__search', mcp), ['docs*'], false, 'on', 'declared'],
    ['regex characters are literal', tool('a.b'), ['a?b'], false, 'on', 'declared'],
    ['CodeMode defers MCP tools', tool('mcp__docs__a', mcp), [], true, 'on', 'deferred'],
    ['CodeMode leaves built-ins declared', tool('Read'), [], true, 'on', 'declared'],
    ['server opt-in is a default', tool('mcp__docs__a', { ...mcp, defaultDeferred: true }), [], false, 'on', 'deferred'],
    ['tool default applies without settings', tool('ImageGen', { defaultDeferred: true }), [], false, 'on', 'deferred'],
    ['only inlines built-ins', tool('Read'), [], false, 'only', 'inline'],
    ['only discovers MCP tools, even pinned ones', tool('mcp__docs__a', { ...mcp, pinned: true }), [], true, 'only', 'deferred'],
    ['only discovers deferred built-ins', tool('ImageGen', { defaultDeferred: true }), [], true, 'only', 'deferred'],
    ['without CodeMode deferred MCP goes through mcp_call', tool('mcp__docs__a', mcp), [], true, 'meta', 'meta'],
    ['without mcp_call deferred MCP stays declared', tool('mcp__docs__a', mcp), [], true, 'bare', 'declared'],
    ['without CodeMode deferred built-ins stay declared', tool('ImageGen', { defaultDeferred: true }), [], false, 'meta', 'declared'],
    ['otherwise declared', tool('Read'), [], false, 'meta', 'declared'],
  ] as const)('%s', (_label, subject, patterns, mcpViaCodeMode, agent, expected) => {
    expect(
      resolveExposure(subject, { patterns, mcpViaCodeMode, ...agents[agent] }),
    ).toBe(expected);
  });
});

describe('declared MCP servers', () => {
  const declared = new Set(['docs']);
  it.each([
    ['declared servers stay declared in on', tool('mcp__docs__a', mcp), 'on', 'declared'],
    ['other servers stay deferred', tool('mcp__web__a', { namespace: { kind: 'mcp', server: 'web' } }), 'on', 'deferred'],
    ['server opt-in still defers', tool('mcp__docs__a', { ...mcp, defaultDeferred: true }), 'on', 'deferred'],
    ['only still discovers them', tool('mcp__docs__a', mcp), 'only', 'deferred'],
    ['agents without CodeMode see them declared', tool('mcp__docs__a', mcp), 'meta', 'declared'],
  ] as const)('%s', (_label, subject, agent, expected) => {
    expect(
      resolveExposure(subject, {
        patterns: [],
        mcpViaCodeMode: true,
        declaredMcpServers: declared,
        ...agents[agent],
      }),
    ).toBe(expected);
  });
});

describe('MCP defer threshold', () => {
  it('defaults to 10 and clamps to 0..100', () => {
    expect(readMcpDeferThreshold(undefined)).toBe(10);
    expect(readMcpDeferThreshold({ mcpDeferThreshold: '5' })).toBe(10);
    expect(readMcpDeferThreshold({ mcpDeferThreshold: -1 })).toBe(0);
    expect(readMcpDeferThreshold({ mcpDeferThreshold: 250 })).toBe(100);
    expect(readMcpDeferThreshold({ mcpDeferThreshold: 3 })).toBe(3);
  });

  it.each([
    ['on with a known window', 'on', 10, 100_000, 10_000],
    ['only mode', 'only', 10, 100_000, undefined],
    ['without CodeMode', undefined, 10, 100_000, undefined],
    ['threshold 0', 'on', 0, 100_000, undefined],
    ['an unknown context window', 'on', 10, undefined, undefined],
  ] as const)(
    'budgets MCP declarations for %s',
    (_label, codeMode, threshold, contextWindow, expected) => {
      expect(mcpDeclarationBudget(codeMode, threshold, contextWindow)).toBe(
        expected,
      );
    },
  );
});

describe('resolveMcpRegistration', () => {
  it.each([
    [undefined, false, 'full', false],
    [undefined, true, 'lazy', false],
    ['on', false, 'full', true],
    ['on', true, 'full', true],
    ['only', false, 'full', true],
    ['only', true, 'full', true],
  ] as const)(
    'CodeMode %s with lazy=%s registers %s',
    (codeMode, lazy, mode, mcpViaCodeMode) => {
      expect(resolveMcpRegistration(codeMode, lazy)).toEqual({
        mode,
        mcpViaCodeMode,
        declaredMcpServers: new Set(),
      });
    },
  );
});

describe('deferredTools settings helpers', () => {
  it('reads only string entries and tolerates malformed settings', () => {
    expect(readDeferredToolPatterns(undefined)).toEqual([]);
    expect(readDeferredToolPatterns({ deferredTools: 'ImageGen' })).toEqual([]);
    expect(
      readDeferredToolPatterns({ deferredTools: ['ImageGen', 1, '!Read'] }),
    ).toEqual(['ImageGen', '!Read']);
  });

  it.each([
    [['ImageGen'], false],
    [['!mcp__*'], false],
    [['mcp__docs__*'], true],
    [['mcp__docs__search'], true],
    [['m*'], true],
    [['*'], true],
  ] as const)('detects patterns that may defer MCP tools: %j', (patterns, expected) => {
    expect(patternsMayDeferMcp(patterns)).toBe(expected);
  });

  it('reports exact names of tools that scripts cannot call', () => {
    expect(
      ineffectiveDeferredNames(
        ['TaskStop', 'ImageGen', 'Task*', '!TaskStop', 'Missing'],
        [tool('TaskStop', { modelOnly: true }), tool('ImageGen')],
      ),
    ).toEqual(['TaskStop']);
  });
});
