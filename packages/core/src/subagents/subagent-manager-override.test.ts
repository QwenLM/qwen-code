/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Config, ApprovalMode, deriveConfig } from '../config/config.js';
import { SubagentManager } from './subagent-manager.js';
import type { SubagentConfig } from './types.js';
import { ToolNames } from '../tools/tool-names.js';
import { EditTool } from '../tools/edit.js';
import { ReadFileTool } from '../tools/read-file.js';
import { createApprovalModeOverride } from '../tools/agent/agent.js';

/**
 * Companion to `tools/agent/agent-override.test.ts`. A derived child must
 * rebuild core tools so Edit/Write/Read resolve its child-local cache rather
 * than the parent's recorded reads.
 */
describe('SubagentManager.buildSubagentContextOverride bound-tool isolation', () => {
  // Bare mode keeps the registry small (ReadFile / Edit / Shell only) and
  // avoids needing extra setup for optional tools.
  const baseParams = {
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'test-model',
    usageStatisticsEnabled: false,
    bareMode: true,
  };

  // The method is `private`. Cast via `unknown` to invoke it directly —
  // testing through the public `createAgentHeadless` pathway would also
  // work but pulls in a much larger graph (file IO, hooks, etc.).
  async function callBuildOverride(
    manager: SubagentManager,
    base: Config,
    config?: Partial<SubagentConfig>,
  ): Promise<Config> {
    const fn = (
      manager as unknown as {
        buildSubagentContextOverride: (
          b: Config,
          c: SubagentConfig,
        ) => Promise<{
          context: Config;
          cleanup?: () => Promise<void>;
        }>;
      }
    ).buildSubagentContextOverride.bind(manager);
    const fullConfig: SubagentConfig = {
      name: 'test-agent',
      description: 'test',
      systemPrompt: '',
      level: 'session',
      ...config,
    };
    const result = await fn(base, fullConfig);
    return result.context;
  }

  it('returns a Config whose registry is distinct from the parent and binds Edit/Read to the override', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const manager = new SubagentManager(parent);

    const child = await callBuildOverride(manager, parent);

    expect(child).not.toBe(parent);
    expect(child.getToolRegistry()).not.toBe(parentRegistry);

    const childEdit = await child.getToolRegistry().ensureTool(ToolNames.EDIT);
    const childRead = await child
      .getToolRegistry()
      .ensureTool(ToolNames.READ_FILE);

    expect(childEdit).toBeInstanceOf(EditTool);
    expect(childRead).toBeInstanceOf(ReadFileTool);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childEdit as any).config).toBe(child);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childRead as any).config).toBe(child);

    // The bound tool's FileReadCache must be the child's, not the parent's.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (childEdit as any).config as Config;
    expect(boundConfig.getFileReadCache()).toBe(child.getFileReadCache());
    expect(boundConfig.getFileReadCache()).not.toBe(parent.getFileReadCache());
  });

  it('parent and child caches are independent', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const manager = new SubagentManager(parent);

    const child = await callBuildOverride(manager, parent);

    // Record a read on parent. Child must not see it.
    const fakeStats = {
      dev: 1,
      ino: 100,
      mtimeMs: 1_000_000,
      size: 42,
    } as unknown as import('node:fs').Stats;

    parent.getFileReadCache().recordRead('/tmp/parent.ts', fakeStats, {
      full: true,
      cacheable: true,
    });

    expect(parent.getFileReadCache().size()).toBe(1);
    expect(child.getFileReadCache().size()).toBe(0);
  });

  it('skips rebuild and inherits registry when an upstream derived wrapper already rebuilt it', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    // Layer 1: actual createApprovalModeOverride (sets the marker).
    const { config: upstreamWrapper } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );
    const upstreamRegistry = upstreamWrapper.getToolRegistry();

    // Layer 2: add the background prompt policy through the factory.
    const bgWrapper = deriveConfig(upstreamWrapper, {
      getShouldAvoidPermissionPrompts: () => true,
    });

    const manager = new SubagentManager(parent);

    const child = await callBuildOverride(manager, bgWrapper as Config);

    // The child is distinct, but the rebuilt registry remains inherited from
    // the approval profile so no duplicate registry lifecycle is created.
    expect(child).not.toBe(bgWrapper);
    expect(child.getToolRegistry()).toBe(upstreamRegistry);
    const childEdit = await child.getToolRegistry().ensureTool(ToolNames.EDIT);
    expect(childEdit).toBeInstanceOf(EditTool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childEdit as any).config).toBe(upstreamWrapper);
  });

  it('the override approval mode (inherited via prototype) still resolves via the override Config', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const manager = new SubagentManager(parent);

    const child = await callBuildOverride(manager, parent);

    // Child has no own getApprovalMode; falls through prototype to parent.
    // Verify mutating parent's mode via setter is observed by child.
    parent.setApprovalMode(ApprovalMode.AUTO_EDIT);
    expect(child.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);

    // And the bound EditTool sees the same mode.
    const childEdit = await child.getToolRegistry().ensureTool(ToolNames.EDIT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (childEdit as any).config as Config;
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);
  });

  describe('per-agent mcpServers override', () => {
    it('exposes session + agent servers via getMcpServers, with agent winning on key collision', async () => {
      const parent = new Config(baseParams);
      const parentRegistry = await parent.createToolRegistry(undefined, {
        skipDiscovery: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parent as any).toolRegistry = parentRegistry;
      // Pre-seed a session-level MCP server so the merge has something to
      // shadow. addMcpServers must be called before initialization, which
      // bareMode skips for us.
      parent.addMcpServers({
        'session-only': { type: 'stdio', command: 'node-a' } as never,
        shared: { type: 'stdio', command: 'session-version' } as never,
      });

      const manager = new SubagentManager(parent);
      const child = await callBuildOverride(manager, parent, {
        mcpServers: {
          'agent-only': { type: 'stdio', command: 'node-b' },
          shared: { type: 'stdio', command: 'agent-version' },
        },
      });

      const merged = child.getMcpServers();
      expect(Object.keys(merged ?? {}).sort()).toEqual([
        'agent-only',
        'session-only',
        'shared',
      ]);
      // Agent wins on collision (CC `scope: 'agent'` semantics).
      expect((merged?.['shared'] as { command: string }).command).toBe(
        'agent-version',
      );
      // Session server passes through unchanged.
      expect((merged?.['session-only'] as { command: string }).command).toBe(
        'node-a',
      );
    });

    it('leaves getMcpServers untouched when no per-agent servers are declared', async () => {
      const parent = new Config(baseParams);
      const parentRegistry = await parent.createToolRegistry(undefined, {
        skipDiscovery: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parent as any).toolRegistry = parentRegistry;
      parent.addMcpServers({
        'session-only': { type: 'stdio', command: 'node' } as never,
      });
      const manager = new SubagentManager(parent);
      const child = await callBuildOverride(manager, parent);
      // Child has no own getMcpServers; prototype resolves to parent's.
      expect(child.getMcpServers()).toEqual(parent.getMcpServers());
    });
  });
});
