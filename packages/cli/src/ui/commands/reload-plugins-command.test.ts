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
import { ExtensionRefreshState } from '../../config/extension-refresh-state.js';

vi.mock('../../config/extension-runtime-reload.js', () => ({
  reloadPluginsRuntime: vi.fn(async () => ({
    extensionCount: 1,
    commandCount: 2,
    skillCount: 3,
    agentCount: 4,
    workflowCount: 8,
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
      markExtensionsReloadFailed: vi.fn(),
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
        'Reloaded extensions: 1 extension · 2 commands · 3 skills · 4 agents · 8 workflows · 5 hooks · 6 extension MCP servers · 7 extension LSP servers',
    });
  });

  it('preserves stale state when reload fails', async () => {
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
    expect(
      extensionRefreshState.markExtensionsReloadFailed,
    ).toHaveBeenCalledOnce();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Reload failed: boom',
    });
  });

  it('does not finish a newer shared reload when an earlier command completes', async () => {
    const state = new ExtensionRefreshState();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const summary = {
      extensionCount: 0,
      commandCount: 0,
      skillCount: 0,
      agentCount: 0,
      workflowCount: 0,
      hookCount: 0,
      mcpServerCount: 0,
      lspServerCount: 0,
    };
    vi.mocked(reloadPluginsRuntime)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () => resolve(summary);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = () => resolve(summary);
          }),
      );
    const context = {
      services: { config: {} as Config, extensionRefreshState: state },
      ui: { reloadCommands: vi.fn() },
    } as unknown as CommandContext;
    const first = reloadPluginsCommand.action!(context, '');
    const second = reloadPluginsCommand.action!(context, '');
    finishFirst();
    await first;
    expect(state.isReloadInProgress()).toBe(true);
    finishSecond();
    await second;
    expect(state.isReloadInProgress()).toBe(false);
    expect(state.markExtensionsChanged('later change')).toBe(true);
  });
});
