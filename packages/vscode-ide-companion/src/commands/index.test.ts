/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusChatCommand,
  loginCommand,
  newConversationCommand,
  openChatCommand,
  openNewChatTabCommand,
  registerNewCommands,
  showDiffCommand,
  showLogsCommand,
} from './index.js';
import type { DiffManager } from '../diff-manager.js';
import type { WebViewProvider } from '../webview/providers/WebViewProvider.js';

const {
  executeCommand,
  joinPath,
  registerCommand,
  showErrorMessage,
  showInformationMessage,
  showWarningMessage,
  workspace,
} = vi.hoisted(() => ({
  registerCommand: vi.fn(
    (_id: string, handler: (...args: unknown[]) => unknown) => ({
      dispose: vi.fn(),
      handler,
    }),
  ),
  executeCommand: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  joinPath: vi.fn((base: { fsPath: string }, ...paths: string[]) => ({
    fsPath: `${base.fsPath}/${paths.join('/')}`,
  })),
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  },
}));

vi.mock('vscode', () => ({
  commands: {
    executeCommand,
    registerCommand,
  },
  window: {
    showErrorMessage,
    showInformationMessage,
    showWarningMessage,
  },
  workspace,
  Uri: {
    joinPath,
  },
}));

function getRegisteredHandler(commandId: string) {
  const call = registerCommand.mock.calls.find(([id]) => id === commandId);
  if (!call) {
    throw new Error(`Command ${commandId} was not registered`);
  }

  return call[1] as (...args: unknown[]) => Promise<void>;
}

function createProvider() {
  return {
    createNewSession: vi.fn().mockResolvedValue(undefined),
    forceReLogin: vi.fn().mockResolvedValue(undefined),
    setInitialModelId: vi.fn(),
    show: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebViewProvider;
}

describe('registerNewCommands', () => {
  const context = { subscriptions: [] as Array<{ dispose: () => void }> };
  const diffManager = {
    showDiff: vi.fn().mockResolvedValue(undefined),
  } as unknown as DiffManager;
  const log = vi.fn();

  beforeEach(() => {
    context.subscriptions = [];
    vi.clearAllMocks();
    workspace.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  });

  it('registers the expected command handlers', () => {
    const outputChannel = { show: vi.fn() };

    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      createProvider,
      outputChannel as never,
    );

    expect(context.subscriptions).toHaveLength(7);
    expect(registerCommand.mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining([
        openChatCommand,
        showDiffCommand,
        openNewChatTabCommand,
        loginCommand,
        focusChatCommand,
        newConversationCommand,
        showLogsCommand,
      ]),
    );
  });

  it('openChat shows the latest provider when one already exists', async () => {
    const firstProvider = createProvider();
    const lastProvider = createProvider();

    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [firstProvider, lastProvider],
      createProvider,
    );

    await getRegisteredHandler(openChatCommand)();

    expect(lastProvider.show).toHaveBeenCalledTimes(1);
    expect(firstProvider.show).not.toHaveBeenCalled();
  });

  it('openChat creates a provider when none exist', async () => {
    const providerFactory = vi.fn(() => createProvider());

    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      providerFactory,
    );

    await getRegisteredHandler(openChatCommand)();

    expect(providerFactory).toHaveBeenCalledTimes(1);
  });

  it('showDiff resolves relative paths against the workspace root', async () => {
    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      createProvider,
    );

    await getRegisteredHandler(showDiffCommand)({
      path: 'src/file.ts',
      oldText: 'old',
      newText: 'new',
    });

    expect(diffManager.showDiff).toHaveBeenCalledWith(
      '/workspace/src/file.ts',
      'old',
      'new',
    );
  });

  it('showDiff surfaces failures through logging and notifications', async () => {
    const failingDiffManager = {
      showDiff: vi.fn().mockRejectedValue(new Error('Diff error')),
    } as unknown as DiffManager;

    registerNewCommands(
      context as never,
      log,
      failingDiffManager,
      () => [],
      createProvider,
    );

    await getRegisteredHandler(showDiffCommand)({
      path: '/tmp/file.ts',
      oldText: 'old',
      newText: 'new',
    });

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Failed to show diff: Diff error',
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[Command] Error showing diff: Diff error'),
    );
  });

  it('openNewChatTab opens a fresh provider without creating a session explicitly', async () => {
    const provider = createProvider();

    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      () => provider,
    );

    await getRegisteredHandler(openNewChatTabCommand)({
      initialModelId: 'glm-5',
    });

    expect(provider.show).toHaveBeenCalledTimes(1);
    expect(provider.createNewSession).not.toHaveBeenCalled();
    expect(provider.setInitialModelId).toHaveBeenCalledWith('glm-5');
  });

  it('login uses the latest provider when one exists', async () => {
    const firstProvider = createProvider();
    const lastProvider = createProvider();

    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [firstProvider, lastProvider],
      createProvider,
    );

    await getRegisteredHandler(loginCommand)();

    expect(lastProvider.forceReLogin).toHaveBeenCalledTimes(1);
    expect(firstProvider.forceReLogin).not.toHaveBeenCalled();
  });

  it('login shows guidance when no chat provider exists', async () => {
    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      createProvider,
    );

    await getRegisteredHandler(loginCommand)();

    expect(showInformationMessage).toHaveBeenCalledWith(
      'Please open Qwen Code chat first before logging in.',
    );
  });

  it('focusChat targets the secondary sidebar when supported', async () => {
    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      createProvider,
      undefined,
      true,
    );

    await getRegisteredHandler(focusChatCommand)();

    expect(executeCommand).toHaveBeenCalledWith(
      'qwen-code.chatView.secondary.focus',
    );
  });

  it('focusChat falls back to the primary sidebar when needed', async () => {
    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      createProvider,
      undefined,
      false,
    );

    await getRegisteredHandler(focusChatCommand)();

    expect(executeCommand).toHaveBeenCalledWith(
      'qwen-code.chatView.sidebar.focus',
    );
  });

  it('showLogs reveals the output channel when available', async () => {
    const outputChannel = { show: vi.fn() };

    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      createProvider,
      outputChannel as never,
    );

    await getRegisteredHandler(showLogsCommand)();

    expect(outputChannel.show).toHaveBeenCalledWith(true);
  });

  it('showLogs warns when no output channel is available', async () => {
    registerNewCommands(
      context as never,
      log,
      diffManager,
      () => [],
      createProvider,
    );

    await getRegisteredHandler(showLogsCommand)();

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Qwen Code Companion log channel is not available.',
    );
  });

  it('command constants remain stable', () => {
    expect(openChatCommand).toBe('qwen-code.openChat');
    expect(showDiffCommand).toBe('qwenCode.showDiff');
    expect(openNewChatTabCommand).toBe('qwenCode.openNewChatTab');
    expect(loginCommand).toBe('qwen-code.login');
    expect(focusChatCommand).toBe('qwen-code.focusChat');
    expect(newConversationCommand).toBe('qwen-code.newConversation');
    expect(showLogsCommand).toBe('qwen-code.showLogs');
  });
});
