/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { reloadPluginsCommand } from './reload-plugins-command.js';
import type { CommandContext } from './types.js';
import { reloadPluginsRuntime } from '../../config/hot-reload.js';
import { clearPluginsChanged } from '../../config/plugin-refresh-state.js';

vi.mock('../../config/hot-reload.js', () => ({
  reloadPluginsRuntime: vi.fn(async () => ({
    extensionCount: 1,
    commandCount: 2,
    skillCount: 3,
    hookCount: 4,
    mcpServerCount: 5,
    lspServerCount: 6,
  })),
}));

vi.mock('../../config/plugin-refresh-state.js', () => ({
  clearPluginsChanged: vi.fn(),
}));

const reloadPluginsRuntimeMock = vi.mocked(reloadPluginsRuntime);
const clearPluginsChangedMock = vi.mocked(clearPluginsChanged);

describe('reloadPluginsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an error when config is missing', async () => {
    const context = {
      services: { config: null },
      ui: { reloadCommands: vi.fn() },
    } as unknown as CommandContext;

    const result = await reloadPluginsCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
    expect(reloadPluginsRuntimeMock).not.toHaveBeenCalled();
    expect(clearPluginsChangedMock).not.toHaveBeenCalled();
  });

  it('reloads plugin runtime', async () => {
    const config = {} as Config;
    const reloadCommands = vi.fn();
    const context = {
      services: { config },
      ui: { reloadCommands },
    } as unknown as CommandContext;

    const result = await reloadPluginsCommand.action?.(context, '');

    expect(reloadPluginsRuntimeMock).toHaveBeenCalledWith({
      config,
      reloadCommands,
    });
    expect(clearPluginsChangedMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Reloaded: 1 plugin · 2 commands · 3 skills · 4 hooks · 5 plugin MCP servers · 6 plugin LSP servers',
    });
  });

  it('surfaces reload failures without clearing the refresh flag', async () => {
    // A failed reload must not clear the pending-refresh flag — the runtime is
    // still stale, so the user should be able to retry /reload-plugins.
    reloadPluginsRuntimeMock.mockRejectedValueOnce(new Error('boom'));

    const config = {} as Config;
    const reloadCommands = vi.fn();
    const context = {
      services: { config },
      ui: { reloadCommands },
    } as unknown as CommandContext;

    const result = await reloadPluginsCommand.action?.(context, '');

    expect(reloadPluginsRuntimeMock).toHaveBeenCalledWith({
      config,
      reloadCommands,
    });
    expect(clearPluginsChangedMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Reload failed: boom',
    });
  });
});
