/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../index.js';
import type { AnyToolInvocation } from '../index.js';
import { evaluatePermissionFlow } from './permissionFlow.js';

describe('evaluatePermissionFlow MCP restrictive collision handling', () => {
  const invocation = (legacyAlias: string): AnyToolInvocation => {
    const value = {
      getDefaultPermission: vi.fn().mockResolvedValue('allow'),
      permissionAliases: [legacyAlias],
      serverName: 'srv',
      serverToolName: 'foo/bar',
      params: {},
    };
    return value as unknown as AnyToolInvocation;
  };

  it('retains ambiguous legacy aliases for restrictive rules while grant context stays filtered', async () => {
    const legacyAlias = 'mcp__srv__foo_bar';
    const rawName = 'mcp__srv__foo/bar';
    const registeredName = 'mcp__srv__foo_bar_0cnn7di';
    const resolver = vi.fn().mockReturnValue([]);

    const pm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockImplementation(async (ctx: { toolAliases?: readonly string[] }) =>
        ctx.toolAliases?.includes(legacyAlias) ? 'deny' : 'default',
      ),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
      findMatchingDenyRule: vi.fn().mockReturnValue(legacyAlias),
    };
    const config = {
      getPermissionManager: vi.fn().mockReturnValue(pm),
      getToolRegistry: vi.fn().mockReturnValue({
        getUnambiguousMcpPermissionAliases: resolver,
      }),
      getTargetDir: vi.fn().mockReturnValue('/repo'),
    } as unknown as Config;

    const result = await evaluatePermissionFlow(
      config,
      invocation(legacyAlias),
      registeredName,
      {},
    );

    expect(result.finalPermission).toBe('deny');
    expect(result.pmCtx.toolAliases).toEqual([rawName]);
    expect(pm.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolAliases: expect.arrayContaining([rawName, legacyAlias]),
      }),
    );
  });

  it('fails closed for allow grants if the registry resolver is unavailable', async () => {
    const legacyAlias = 'mcp__srv__foo_bar';
    const rawName = 'mcp__srv__foo/bar';
    const registeredName = 'mcp__srv__foo_bar_0cnn7di';

    const pm = {
      hasRelevantRules: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockImplementation(async (ctx: { toolAliases?: readonly string[] }) =>
        ctx.toolAliases?.includes(legacyAlias) ? 'allow' : 'default',
      ),
      hasMatchingAskRule: vi.fn().mockReturnValue(false),
    };
    const config = {
      getPermissionManager: vi.fn().mockReturnValue(pm),
      getToolRegistry: vi.fn().mockReturnValue({}),
      getTargetDir: vi.fn().mockReturnValue('/repo'),
    } as unknown as Config;
    const inv = invocation(legacyAlias) as AnyToolInvocation & {
      getDefaultPermission: ReturnType<typeof vi.fn>;
    };
    inv.getDefaultPermission = vi.fn().mockResolvedValue('ask');

    const result = await evaluatePermissionFlow(config, inv, registeredName, {});

    expect(result.pmCtx.toolAliases).toEqual([rawName]);
    expect(result.finalPermission).toBe('ask');
  });
});
