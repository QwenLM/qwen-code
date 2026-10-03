/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallableTool } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { Config, ApprovalMode } from '../config/config.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { generateLegacyMcpToolName } from '../utils/tool-name-utils.js';
import { PermissionManager } from './permission-manager.js';

const tool = (server: string, name: string, appOnly = false) =>
  new DiscoveredMCPTool(
    {} as CallableTool,
    server,
    name,
    'fixture',
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    appOnly ? 'ui://fixture/app' : undefined,
    undefined,
    undefined,
    appOnly ? ['app'] : undefined,
  );
const context = (tool: DiscoveredMCPTool) => ({
  toolName: tool.name,
  toolAliases: tool.permissionAliases,
  mcpIdentity: tool.build({}).mcpIdentity,
});

function setup(
  rule: string,
  tools: DiscoveredMCPTool[],
  direction: 'allow' | 'deny' | 'ask' = 'allow',
) {
  const config = new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    model: 'fixture',
    embeddingModel: 'fixture',
    sandbox: undefined,
    debugMode: false,
    userMemory: '',
    memoryFileCount: 0,
    approvalMode: ApprovalMode.DEFAULT,
    permissions: {
      allow: direction === 'allow' ? [rule] : [],
      deny: direction === 'deny' ? [rule] : [],
      ask: direction === 'ask' ? [rule] : [],
    },
  });
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  const pm = new PermissionManager(config);
  pm.initialize();
  for (const entry of tools) registry.registerTool(entry);
  return { pm, registry };
}

describe('registry-backed MCP allow ambiguity', () => {
  it.each(['foo.bar', 'foo:bar', 'foo/bar'])(
    'keeps the raw foo_bar grant from reaching %s',
    async (server) => {
      const safe = tool('foo_bar', 'get_x');
      const other = tool(server, 'get+x');
      for (const rule of [
        'mcp__foo_bar',
        'mcp__foo_bar__*',
        'mcp__foo_bar__get_x',
      ]) {
        const { pm, registry } = setup(rule, [safe, other]);
        expect(registry.getAllToolNames()).toHaveLength(2);
        expect(await pm.evaluate(context(safe))).toBe('allow');
        expect(await pm.evaluate(context(other))).toBe('default');
        expect(pm.hasRelevantRules(context(other))).toBe(false);
      }
    },
  );

  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])(
    'counts App-only registrations (safe app=%s, other app=%s)',
    async (safeApp, otherApp) => {
      const safe = tool('foo_bar', 'get_x', safeApp);
      const other = tool('foo:bar', 'get+x', otherApp);
      for (const rule of [
        'mcp__foo_bar',
        'mcp__foo_bar__*',
        'mcp__foo_bar__get_x',
      ]) {
        const { pm, registry } = setup(rule, [safe, other]);
        expect(registry.getAllToolNames()).toHaveLength(
          Number(!safeApp) + Number(!otherApp),
        );
        expect(registry.getMcpToolIdentities()).toHaveLength(2);
        if (safeApp)
          expect(registry.getMcpAppTool('foo_bar', 'get_x')).toBe(safe);
        if (otherApp)
          expect(registry.getMcpAppTool('foo:bar', 'get+x')).toBe(other);
        expect(await pm.evaluate(context(safe))).toBe('allow');
        expect(await pm.evaluate(context(other))).toBe('default');
        expect(pm.hasRelevantRules(context(other))).toBe(false);
        registry.removeMcpToolsByServer('foo_bar');
        expect(registry.getMcpToolIdentities()).toHaveLength(1);
        expect(await pm.evaluate(context(other))).toBe('allow');
      }
    },
  );

  it('preserves the unique registered exact name even when server aliases collide', async () => {
    const other = tool('foo:bar', 'get+x');
    const { pm } = setup(other.name, [tool('foo_bar', 'get_x'), other]);
    expect(await pm.evaluate(context(other))).toBe('allow');
    expect(pm.hasRelevantRules(context(other))).toBe(true);
  });

  it('preserves an unambiguous alias and observes later registration/removal', async () => {
    const other = tool('foo:bar', 'get+x');
    const safe = tool('foo_bar', 'different');
    const { pm, registry } = setup('mcp__foo_bar', [other]);
    expect(await pm.evaluate(context(other))).toBe('allow');
    expect(pm.hasRelevantRules(context(other))).toBe(true);
    registry.registerTool(safe);
    expect(await pm.evaluate(context(other))).toBe('default');
    expect(pm.hasRelevantRules(context(other))).toBe(false);
    registry.removeMcpToolsByServer('foo_bar');
    expect(await pm.evaluate(context(other))).toBe('allow');
  });

  it('refuses an alias shared by two unsafe server keys', async () => {
    const first = tool('foo:bar', 'get+x');
    const second = tool('foo/bar', 'get+x');
    const { pm } = setup('mcp__foo_bar__get_x', [first, second]);
    expect(await pm.evaluate(context(first))).toBe('default');
    expect(await pm.evaluate(context(second))).toBe('default');
  });

  it.each(['deny', 'ask'] as const)(
    'retains %s coverage for every claimant',
    async (direction) => {
      const safe = tool('foo_bar', 'get_x');
      const other = tool('foo:bar', 'get+x');
      for (const rule of [
        'mcp__foo_bar',
        'mcp__foo_bar__*',
        'mcp__foo_bar__get_x',
      ]) {
        const { pm } = setup(rule, [safe, other], direction);
        expect(await pm.evaluate(context(safe))).toBe(direction);
        expect(await pm.evaluate(context(other))).toBe(direction);
        expect(pm.hasRelevantRules(context(other))).toBe(true);
      }
    },
  );

  it.each(['mcp__foo:bar__get+x', 'mcp__foo*', 'mcp__*'])(
    'preserves explicit raw identity and deliberate coarse prefix %s',
    async (rule) => {
      const other = tool('foo:bar', 'get+x');
      const { pm } = setup(rule, [tool('foo_bar', 'get_x'), other]);
      expect(await pm.evaluate(context(other))).toBe('allow');
      expect(pm.hasRelevantRules(context(other))).toBe(true);
    },
  );

  it('does not let an exact tool alias grant its same-server sibling', async () => {
    const safe = tool('foo', 'get_x');
    const other = tool('foo', 'get+x');
    const { pm } = setup('mcp__foo__get_x', [safe, other]);
    expect(await pm.evaluate(context(safe))).toBe('allow');
    expect(await pm.evaluate(context(other))).toBe('default');
    const { pm: unique } = setup('mcp__foo__get_x', [other]);
    expect(await unique.evaluate(context(other))).toBe('allow');
  });

  it('refuses a shared published middle-truncated legacy tool alias', async () => {
    const first = tool('foo', 'a'.repeat(40) + 'first' + 'z'.repeat(40));
    const second = tool('foo', 'a'.repeat(40) + 'second' + 'z'.repeat(40));
    const legacy = generateLegacyMcpToolName(
      `mcp__foo__${first.serverToolName}`,
    );
    expect(first.permissionAliases).toContain(legacy);
    expect(second.permissionAliases).toContain(legacy);
    const { pm } = setup(legacy, [first, second]);
    expect(await pm.evaluate(context(first))).toBe('default');
    expect(await pm.evaluate(context(second))).toBe('default');
    const { pm: unique } = setup(legacy, [first]);
    expect(await unique.evaluate(context(first))).toBe('allow');
  });
});
