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
});
