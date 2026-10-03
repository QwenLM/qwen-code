/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesToolPattern } from './rule-parser.js';
import { PermissionManager } from './permission-manager.js';
import type { PermissionManagerConfig } from './permission-manager.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import type { CallableTool } from '@google/genai';

const callableTool = { callTool: async () => [] } as unknown as CallableTool;
function prodTool(serverName: string, serverToolName: string) {
  return new DiscoveredMCPTool(
    callableTool,
    serverName,
    serverToolName,
    'test tool',
    {},
  );
}
function makeConfig(
  opts: Partial<{
    permissionsAllow: string[];
    permissionsAsk: string[];
    permissionsDeny: string[];
  }> = {},
): PermissionManagerConfig {
  return {
    getPermissionsAllow: () => opts.permissionsAllow,
    getPermissionsAsk: () => opts.permissionsAsk,
    getPermissionsDeny: () => opts.permissionsDeny,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getApprovalMode: () => 'default',
  } as PermissionManagerConfig;
}
function ctxOf(tool: DiscoveredMCPTool) {
  return {
    toolName: tool.name,
    toolAliases: tool.permissionAliases,
    mcpIdentity: {
      serverName: tool.serverName,
      serverToolName: tool.serverToolName,
    },
  };
}

const URL52 = 'https://mcp.services.example.internal/sse?team=infra';
const URL60 = 'https://mcp.services.example.internal/sse?team=infra-staging';

describe('wildcards copied from a budget-cut registration (R18-1)', () => {
  it.each([
    [URL52, 'deploy'],
    // Raw name is 60 characters (<= 63) but unsafe, so it is still cut at 55.
    ['https://mcp.services.example.internal/sse?team=inf', 'run'],
    ['k'.repeat(53), 'tool'],
    ['a.b-' + 'k'.repeat(50), 'tool'],
  ])('deny/ask keep covering %s / %s', async (server, name) => {
    const tool = prodTool(server, name);
    expect(tool.name).toHaveLength(63);
    const ctx = ctxOf(tool);
    for (const rule of [tool.name + '*', tool.name.slice(0, 56) + '*']) {
      expect(
        matchesToolPattern(
          rule,
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(true);
      const deny = new PermissionManager(
        makeConfig({ permissionsDeny: [rule] }),
      );
      deny.initialize();
      expect(await deny.evaluate(ctx)).toBe('deny');
      expect(
        await deny.isToolEnabled(
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(false);
      const ask = new PermissionManager(makeConfig({ permissionsAsk: [rule] }));
      ask.initialize();
      expect(await ask.evaluate(ctx)).toBe('ask');
    }
  });

  it('never grants: allow on a cut prefix reaches neither the tool nor a sibling key', async () => {
    const own = prodTool(URL52, 'deploy');
    const sibling = prodTool(URL60, 'deploy');
    expect(sibling.name.slice(0, 56)).toBe(own.name.slice(0, 56));
    const allow = new PermissionManager(
      makeConfig({ permissionsAllow: [own.name.slice(0, 56) + '*'] }),
    );
    allow.initialize();
    expect(await allow.evaluate(ctxOf(own))).toBe('default');
    expect(await allow.evaluate(ctxOf(sibling))).toBe('default');
  });

  it.each([
    // Verbatim registration (R17-2).
    ['foo', '_internal', 'mcp__foo_*'],
    // Normalized (`_<hash>` suffix) but the separator survived the cut.
    ['foo', '_in.ternal', 'mcp__foo_*'],
    ['foo.bar', '_in.ternal', 'mcp__foo_bar_*'],
  ])(
    'an uncut registration never enters the fallback: %s / %s',
    async (server, name, rule) => {
      const tool = prodTool(server, name);
      const ctx = ctxOf(tool);
      expect(
        matchesToolPattern(
          rule,
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(false);
      const deny = new PermissionManager(
        makeConfig({ permissionsDeny: [rule] }),
      );
      deny.initialize();
      expect(await deny.evaluate(ctx)).toBe('default');
    },
  );

  it.each([
    ['a bare `*`', () => '*'],
    // An exact entry for a different hash suffix is not a prefix rule.
    ['an exact foreign suffix', (name: string) => name.slice(0, -1) + 'Z'],
  ])('%s does not enter the fallback for a cut registration', (_, rule) => {
    const tool = prodTool(URL52, 'deploy');
    expect(
      matchesToolPattern(
        rule(tool.name),
        tool.name,
        tool.permissionAliases,
        ctxOf(tool).mcpIdentity,
      ),
    ).toBe(false);
  });
});
