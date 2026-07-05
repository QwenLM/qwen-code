/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { reloadPluginsCommand } from './reload-plugins-command.js';
import type { CommandContext } from './types.js';
import { reloadPluginsRuntime } from '../../config/extension-runtime-reload.js';
import type { ExtensionRefreshState } from '../../config/extension-refresh-state.js';

vi.mock('../../config/extension-runtime-reload.js', () => ({
  reloadPluginsRuntime: vi.fn(async () => ({
    extensionCount: 1,
    commandCount: 2,
    skillCount: 3,
    agentCount: 4,
    hookCount: 5,
    mcpServerCount: 6,
    lspServerCount: 7,
  })),
}));

describe('reloadPluginsCommand', () => {
  let extensionRefreshState: ExtensionRefreshState;

  beforeEach(() => {
    vi.clearAllMocks();
    extensionRefreshState = {
      clearExtensionsChanged: vi.fn(),
      notifyExtensionsReloadStarted: vi.fn(),
    } as unknown as ExtensionRefreshState;
  });

  it('returns an error when config is missing', async () => {
    const context = {
      services: { config: null, extensionRefreshState },
      ui: { reloadCommands: vi.fn() },
    } as unknown as CommandContext;

    const result = await reloadPluginsCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
    expect(reloadPluginsRuntime).not.toHaveBeenCalled();
    expect(extensionRefreshState.clearExtensionsChanged).not.toHaveBeenCalled();
    expect(
      extensionRefreshState.notifyExtensionsReloadStarted,
    ).not.toHaveBeenCalled();
  });

  it('reloads extension runtime and clears stale state', async () => {
    const config = {} as Config;
    const reloadCommands = vi.fn();
    const context = {
      services: { config, extensionRefreshState },
      ui: { reloadCommands },
    } as unknown as CommandContext;

    const result = await reloadPluginsCommand.action?.(context, '');

    expect(
      extensionRefreshState.notifyExtensionsReloadStarted,
    ).toHaveBeenCalledOnce();
    expect(reloadPluginsRuntime).toHaveBeenCalledWith({
      config,
      reloadCommands,
    });
    expect(extensionRefreshState.clearExtensionsChanged).toHaveBeenCalledOnce();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Reloaded extensions: 1 extension · 2 commands · 3 skills · 4 agents · 5 hooks · 6 extension MCP servers · 7 extension LSP servers',
    });
  });

  it('does not clear stale state when reload fails', async () => {
    vi.mocked(reloadPluginsRuntime).mockRejectedValueOnce(new Error('boom'));
    const context = {
      services: { config: {} as Config, extensionRefreshState },
      ui: { reloadCommands: vi.fn() },
    } as unknown as CommandContext;

    const result = await reloadPluginsCommand.action?.(context, '');

    expect(
      extensionRefreshState.notifyExtensionsReloadStarted,
    ).toHaveBeenCalledOnce();
    expect(extensionRefreshState.clearExtensionsChanged).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Reload failed: boom',
    });
  });
});
