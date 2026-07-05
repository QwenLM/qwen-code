/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  refreshExtensionContentRuntime,
  reloadPluginsRuntime,
} from './extension-runtime-reload.js';

describe('reloadPluginsRuntime', () => {
  it('refreshes extension runtime and returns active extension counts', async () => {
    const refreshCache = vi.fn();
    const refreshTools = vi.fn();
    const reloadCommands = vi.fn();
    const config = {
      getExtensionManager: () => ({
        refreshCache,
        refreshTools,
      }),
      getActiveExtensions: () => [
        {
          commands: ['a', 'b'],
          skills: [{ name: 's1' }],
          agents: [{ name: 'a1' }, { name: 'a2' }],
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  { type: 'command', command: 'echo one' },
                  { type: 'command', command: 'echo two' },
                ],
              },
            ],
          },
          mcpServers: {
            one: { command: 'node' },
          },
          config: {
            lspServers: {
              ts: {},
            },
          },
        },
      ],
    } as unknown as Config;

    const summary = await reloadPluginsRuntime({ config, reloadCommands });

    expect(refreshCache).toHaveBeenCalledOnce();
    expect(refreshTools).toHaveBeenCalledOnce();
    expect(reloadCommands).toHaveBeenCalledOnce();
    expect(summary).toEqual({
      extensionCount: 1,
      commandCount: 2,
      skillCount: 1,
      agentCount: 2,
      hookCount: 2,
      mcpServerCount: 1,
      lspServerCount: 1,
    });
  });
});

describe('refreshExtensionContentRuntime', () => {
  it('refreshes extension cache, skills, agents, and slash commands', async () => {
    const refreshCache = vi.fn();
    const refreshSkillCache = vi.fn();
    const refreshSubagentCache = vi.fn();
    const reloadCommands = vi.fn();
    const config = {
      getExtensionManager: () => ({ refreshCache }),
      getSkillManager: () => ({ refreshCache: refreshSkillCache }),
      getSubagentManager: () => ({ refreshCache: refreshSubagentCache }),
    } as unknown as Config;

    await refreshExtensionContentRuntime({ config, reloadCommands });

    expect(refreshCache).toHaveBeenCalledOnce();
    expect(refreshSkillCache).toHaveBeenCalledOnce();
    expect(refreshSubagentCache).toHaveBeenCalledOnce();
    expect(reloadCommands).toHaveBeenCalledOnce();
  });

  it('continues refreshing content before reporting refresh failures', async () => {
    const refreshCache = vi.fn().mockRejectedValue(new Error('cache failed'));
    const refreshSkillCache = vi
      .fn()
      .mockRejectedValue(new Error('skills failed'));
    const refreshSubagentCache = vi.fn();
    const reloadCommands = vi.fn();
    const config = {
      getExtensionManager: () => ({ refreshCache }),
      getSkillManager: () => ({ refreshCache: refreshSkillCache }),
      getSubagentManager: () => ({ refreshCache: refreshSubagentCache }),
    } as unknown as Config;

    await expect(
      refreshExtensionContentRuntime({ config, reloadCommands }),
    ).rejects.toThrow('cache failed; skills failed');

    expect(refreshCache).toHaveBeenCalledOnce();
    expect(refreshSkillCache).toHaveBeenCalledOnce();
    expect(refreshSubagentCache).toHaveBeenCalledOnce();
    expect(reloadCommands).toHaveBeenCalledOnce();
  });

  it('continues refreshing content when subagent manager is not initialized', async () => {
    const refreshCache = vi.fn();
    const refreshSkillCache = vi.fn();
    const reloadCommands = vi.fn();
    const config = {
      getExtensionManager: () => ({ refreshCache }),
      getSkillManager: () => ({ refreshCache: refreshSkillCache }),
      getSubagentManager: () => undefined,
    } as unknown as Config;

    await expect(
      refreshExtensionContentRuntime({ config, reloadCommands }),
    ).resolves.toBeUndefined();

    expect(refreshCache).toHaveBeenCalledOnce();
    expect(refreshSkillCache).toHaveBeenCalledOnce();
    expect(reloadCommands).toHaveBeenCalledOnce();
  });
});
