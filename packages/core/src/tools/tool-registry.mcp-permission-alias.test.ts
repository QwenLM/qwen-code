/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallableTool } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { ApprovalMode, Config } from '../config/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { ToolRegistry } from './tool-registry.js';

function createRegistry(): ToolRegistry {
  const config = new Config({
    cwd: '/tmp',
    model: 'test-model',
    embeddingModel: 'test-embedding-model',
    sandbox: undefined,
    targetDir: '/tmp',
    debugMode: false,
    userMemory: '',
    memoryFileCount: 0,
    approvalMode: ApprovalMode.DEFAULT,
  });
  return new ToolRegistry(config);
}

describe('ToolRegistry MCP permission alias ownership', () => {
  it('filters shared aliases through the real registry while keeping a unique alias', () => {
    const registry = createRegistry();
    registry.registerTool(new MockTool({ name: 'ordinary-tool' }));

    const first = new DiscoveredMCPTool(
      {} as CallableTool,
      'srv',
      'foo/bar',
      'first collision tool',
      {},
    );
    const second = new DiscoveredMCPTool(
      {} as CallableTool,
      'srv',
      'foo:bar',
      'second collision tool',
      {},
    );
    const unique = new DiscoveredMCPTool(
      {} as CallableTool,
      'srv2',
      'unique.tool',
      'unique legacy alias tool',
      {},
    );

    registry.registerTool(first);
    registry.registerTool(second);
    registry.registerTool(unique);

    const sharedAlias = 'mcp__srv__foo_bar';
    expect(first.permissionAliases).toContain(sharedAlias);
    expect(second.permissionAliases).toContain(sharedAlias);
    expect(
      registry.getUnambiguousMcpPermissionAliases(first.name, [sharedAlias]),
    ).toEqual([]);
    expect(
      registry.getUnambiguousMcpPermissionAliases(second.name, [sharedAlias]),
    ).toEqual([]);

    expect(unique.permissionAliases).toHaveLength(1);
    expect(
      registry.getUnambiguousMcpPermissionAliases(
        unique.name,
        unique.permissionAliases,
      ),
    ).toEqual(unique.permissionAliases);
  });

  it('treats another MCP tool registered name as an alias claimant', () => {
    const registry = createRegistry();
    const providerSafe = new DiscoveredMCPTool(
      {} as CallableTool,
      'srv',
      'foo_bar',
      'provider-safe owner',
      {},
    );
    const collidingLegacy = new DiscoveredMCPTool(
      {} as CallableTool,
      'srv',
      'foo/bar',
      'legacy alias claimant',
      {},
    );

    registry.registerTool(providerSafe);
    registry.registerTool(collidingLegacy);

    expect(providerSafe.name).toBe('mcp__srv__foo_bar');
    expect(collidingLegacy.permissionAliases).toContain(providerSafe.name);
    expect(
      registry.getUnambiguousMcpPermissionAliases(
        collidingLegacy.name,
        collidingLegacy.permissionAliases,
      ),
    ).toEqual([]);
  });
});
