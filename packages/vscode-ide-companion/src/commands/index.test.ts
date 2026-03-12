/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusChatCommand,
  openNewChatTabCommand,
  registerNewCommands,
} from './index.js';

const {
  registerCommand,
  executeCommand,
  showWarningMessage,
  showInformationMessage,
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
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand,
    executeCommand,
  },
  window: {
    showWarningMessage,
    showInformationMessage,
  },
  workspace: {
    workspaceFolders: [],
  },
  Uri: {
    joinPath: vi.fn(),
  },
}));

function getRegisteredHandler(commandId: string) {
  const call = registerCommand.mock.calls.find(([id]) => id === commandId);
  if (!call) {
    throw new Error(`Command ${commandId} was not registered`);
  }
  return call[1] as (...args: unknown[]) => Promise<void>;
}

describe('registerNewCommands', () => {
  const context = { subscriptions: [] as Array<{ dispose: () => void }> };
  const diffManager = { showDiff: vi.fn() };
  const log = vi.fn();

  beforeEach(() => {
    context.subscriptions = [];
    registerCommand.mockClear();
    executeCommand.mockClear();
    showWarningMessage.mockClear();
    showInformationMessage.mockClear();
  });

  it('openNewChatTab opens a new provider without creating a second session explicitly', async () => {
    const provider = {
      show: vi.fn().mockResolvedValue(undefined),
      createNewSession: vi.fn().mockResolvedValue(undefined),
    };

    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      () => provider as never,
    );

    await getRegisteredHandler(openNewChatTabCommand)();

    expect(provider.show).toHaveBeenCalledTimes(1);
    expect(provider.createNewSession).not.toHaveBeenCalled();
  });

  it('focusChat focuses the secondary sidebar when it is supported', async () => {
    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      vi.fn() as never,
      undefined,
      true,
    );

    await getRegisteredHandler(focusChatCommand)();

    expect(executeCommand).toHaveBeenCalledWith(
      'qwen-code.chatView.secondary.focus',
    );
  });

  it('focusChat falls back to the primary sidebar when secondary sidebar is unavailable', async () => {
    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      vi.fn() as never,
      undefined,
      false,
    );

    await getRegisteredHandler(focusChatCommand)();

    expect(executeCommand).toHaveBeenCalledWith(
      'qwen-code.chatView.sidebar.focus',
    );
  });
});
