/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  refreshExtensionRuntime,
  type ExtensionRuntimeRefreshConfig,
} from './extension-runtime-refresh.js';

describe('refreshExtensionRuntime', () => {
  it('returns early without config', async () => {
    await expect(refreshExtensionRuntime(undefined)).resolves.not.toThrow();
  });

  it('refreshes existing extension runtime components', async () => {
    const order: string[] = [];
    const reinitializeMcpServers = vi.fn(async () => {
      order.push('mcp');
    });
    const reinitializeLsp = vi.fn(async () => {
      order.push('lsp');
      return undefined;
    });
    const refreshSkills = vi.fn(async () => {
      order.push('skills');
    });
    const refreshSubagents = vi.fn(async () => {
      order.push('subagents');
    });
    const reloadHooks = vi.fn(async () => {
      order.push('hooks');
    });
    const refreshHierarchicalMemory = vi.fn(async () => {
      order.push('memory');
    });
    const settingsMcpServers = { server: { command: 'cmd' } };

    const config = {
      getSettingsMcpServers: () => settingsMcpServers,
      reinitializeMcpServers,
      reinitializeLsp,
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      getHookSystem: () => ({ reload: reloadHooks }),
      refreshHierarchicalMemory,
    } as unknown as ExtensionRuntimeRefreshConfig;

    await refreshExtensionRuntime(config);

    expect(reinitializeMcpServers).toHaveBeenCalledOnce();
    expect(reinitializeMcpServers).toHaveBeenCalledWith(settingsMcpServers);
    expect(reinitializeLsp).toHaveBeenCalledOnce();
    expect(refreshSkills).toHaveBeenCalledOnce();
    expect(refreshSubagents).toHaveBeenCalledOnce();
    expect(reloadHooks).toHaveBeenCalledOnce();
    expect(refreshHierarchicalMemory).toHaveBeenCalledOnce();
    // MCP and LSP must settle first, then skills/subagents/hooks in parallel, memory last.
    expect(order[0]).toBe('mcp');
    expect(order[1]).toBe('lsp');
    expect(order.slice(2, 5)).toEqual(
      expect.arrayContaining(['skills', 'subagents', 'hooks']),
    );
    expect(order[5]).toBe('memory');
  });

  it('propagates MCP reconcile failures', async () => {
    const reinitializeMcpServers = vi
      .fn()
      .mockRejectedValue(new Error('mcp failed'));
    const refreshSkills = vi.fn();
    const refreshSubagents = vi.fn();
    const reloadHooks = vi.fn();
    const refreshHierarchicalMemory = vi.fn();

    const config = {
      getSettingsMcpServers: () => undefined,
      reinitializeMcpServers,
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      getHookSystem: () => ({ reload: reloadHooks }),
      refreshHierarchicalMemory,
    } as unknown as ExtensionRuntimeRefreshConfig;

    await expect(refreshExtensionRuntime(config)).rejects.toThrow('mcp failed');

    expect(reinitializeMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).not.toHaveBeenCalled();
    expect(refreshSubagents).not.toHaveBeenCalled();
    expect(reloadHooks).not.toHaveBeenCalled();
    expect(refreshHierarchicalMemory).not.toHaveBeenCalled();
  });

  it('propagates LSP partial failures', async () => {
    const reinitializeMcpServers = vi.fn();
    const refreshSkills = vi.fn();
    const refreshSubagents = vi.fn();
    const reloadHooks = vi.fn();
    const refreshHierarchicalMemory = vi.fn();

    const config = {
      getSettingsMcpServers: () => undefined,
      reinitializeMcpServers,
      reinitializeLsp: vi.fn().mockResolvedValue({
        reconcile: {
          added: [],
          removed: [],
          restarted: [],
          unchanged: [],
          failed: ['clangd'],
        },
        skipped: [],
      }),
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      getHookSystem: () => ({ reload: reloadHooks }),
      refreshHierarchicalMemory,
    } as unknown as ExtensionRuntimeRefreshConfig;

    await expect(refreshExtensionRuntime(config)).rejects.toThrow(
      'LSP reload partially failed: clangd',
    );

    expect(reinitializeMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).toHaveBeenCalledOnce();
    expect(refreshSubagents).toHaveBeenCalledOnce();
    expect(reloadHooks).toHaveBeenCalledOnce();
    expect(refreshHierarchicalMemory).toHaveBeenCalledOnce();
  });

  it('continues when a refreshCache leg rejects', async () => {
    const reinitializeMcpServers = vi.fn();
    const refreshSkills = vi.fn().mockRejectedValue(new Error('skills failed'));
    const refreshSubagents = vi.fn();
    const reloadHooks = vi.fn();
    const refreshHierarchicalMemory = vi.fn();

    const config = {
      getSettingsMcpServers: () => undefined,
      reinitializeMcpServers,
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      getHookSystem: () => ({ reload: reloadHooks }),
      refreshHierarchicalMemory,
    } as unknown as ExtensionRuntimeRefreshConfig;

    await expect(refreshExtensionRuntime(config)).resolves.toBeUndefined();

    expect(reinitializeMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).toHaveBeenCalledOnce();
    expect(refreshSubagents).toHaveBeenCalledOnce();
    expect(reloadHooks).toHaveBeenCalledOnce();
    expect(refreshHierarchicalMemory).toHaveBeenCalledOnce();
  });

  it('propagates hook reload failures after other refresh legs settle', async () => {
    const reinitializeMcpServers = vi.fn();
    const refreshSkills = vi.fn();
    const refreshSubagents = vi.fn();
    const reloadHooks = vi.fn().mockRejectedValue(new Error('hooks failed'));
    const refreshHierarchicalMemory = vi.fn();

    const config = {
      getSettingsMcpServers: () => undefined,
      reinitializeMcpServers,
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      getHookSystem: () => ({ reload: reloadHooks }),
      refreshHierarchicalMemory,
    } as unknown as ExtensionRuntimeRefreshConfig;

    await expect(refreshExtensionRuntime(config)).rejects.toThrow(
      'hooks failed',
    );

    expect(reinitializeMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).toHaveBeenCalledOnce();
    expect(refreshSubagents).toHaveBeenCalledOnce();
    expect(reloadHooks).toHaveBeenCalledOnce();
    expect(refreshHierarchicalMemory).toHaveBeenCalledOnce();
  });

  it('resolves when refreshHierarchicalMemory throws', async () => {
    const reinitializeMcpServers = vi.fn();
    const refreshSkills = vi.fn();
    const refreshSubagents = vi.fn();
    const reloadHooks = vi.fn();

    const config = {
      getSettingsMcpServers: () => undefined,
      reinitializeMcpServers,
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      getHookSystem: () => ({ reload: reloadHooks }),
      refreshHierarchicalMemory: vi
        .fn()
        .mockRejectedValue(new Error('memory failed')),
    } as unknown as ExtensionRuntimeRefreshConfig;

    await expect(refreshExtensionRuntime(config)).resolves.toBeUndefined();

    expect(reinitializeMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).toHaveBeenCalledOnce();
    expect(refreshSubagents).toHaveBeenCalledOnce();
    expect(reloadHooks).toHaveBeenCalledOnce();
  });
});
