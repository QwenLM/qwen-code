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
    const restartMcpServers = vi.fn();
    const refreshSkills = vi.fn();
    const refreshSubagents = vi.fn();
    const refreshHierarchicalMemory = vi.fn();

    const config = {
      getToolRegistry: () => ({ restartMcpServers }),
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      refreshHierarchicalMemory,
    } as unknown as ExtensionRuntimeRefreshConfig;

    await refreshExtensionRuntime(config);

    expect(restartMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).toHaveBeenCalledOnce();
    expect(refreshSubagents).toHaveBeenCalledOnce();
    expect(refreshHierarchicalMemory).toHaveBeenCalledOnce();
  });

  it('continues when a refreshCache leg rejects', async () => {
    const restartMcpServers = vi.fn();
    const refreshSkills = vi.fn().mockRejectedValue(new Error('skills failed'));
    const refreshSubagents = vi.fn();
    const refreshHierarchicalMemory = vi.fn();

    const config = {
      getToolRegistry: () => ({ restartMcpServers }),
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      refreshHierarchicalMemory,
    } as unknown as ExtensionRuntimeRefreshConfig;

    await expect(refreshExtensionRuntime(config)).resolves.toBeUndefined();

    expect(restartMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).toHaveBeenCalledOnce();
    expect(refreshSubagents).toHaveBeenCalledOnce();
    expect(refreshHierarchicalMemory).toHaveBeenCalledOnce();
  });

  it('resolves when refreshHierarchicalMemory throws', async () => {
    const restartMcpServers = vi.fn();
    const refreshSkills = vi.fn();
    const refreshSubagents = vi.fn();

    const config = {
      getToolRegistry: () => ({ restartMcpServers }),
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      refreshHierarchicalMemory: vi
        .fn()
        .mockRejectedValue(new Error('memory failed')),
    } as unknown as ExtensionRuntimeRefreshConfig;

    await expect(refreshExtensionRuntime(config)).resolves.toBeUndefined();

    expect(restartMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).toHaveBeenCalledOnce();
    expect(refreshSubagents).toHaveBeenCalledOnce();
  });

  it('rejects when restartMcpServers fails', async () => {
    const restartMcpServers = vi
      .fn()
      .mockRejectedValue(new Error('mcp failed'));
    const refreshSkills = vi.fn();
    const refreshSubagents = vi.fn();
    const refreshHierarchicalMemory = vi.fn();

    const config = {
      getToolRegistry: () => ({ restartMcpServers }),
      getSkillManager: () => ({ refreshCache: refreshSkills }),
      getSubagentManager: () => ({ refreshCache: refreshSubagents }),
      refreshHierarchicalMemory,
    } as unknown as ExtensionRuntimeRefreshConfig;

    await expect(refreshExtensionRuntime(config)).rejects.toThrow('mcp failed');

    expect(restartMcpServers).toHaveBeenCalledOnce();
    expect(refreshSkills).not.toHaveBeenCalled();
    expect(refreshSubagents).not.toHaveBeenCalled();
    expect(refreshHierarchicalMemory).not.toHaveBeenCalled();
  });
});
