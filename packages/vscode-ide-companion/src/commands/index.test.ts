/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { openNewChatTabCommand, registerNewCommands } from './index.js';

vi.mock('vscode', () => ({
  commands: {
    registerCommand: vi.fn(
      (_command: string, _handler: (...args: unknown[]) => unknown) => ({
        dispose: vi.fn(),
      }),
    ),
  },
  workspace: {
    workspaceFolders: [],
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  Uri: {
    joinPath: vi.fn(),
  },
}));

describe('registerNewCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a fresh session when opening a new chat tab', async () => {
    const fakeProvider = {
      show: vi.fn().mockResolvedValue(undefined),
      createNewSession: vi.fn().mockResolvedValue(undefined),
      forceReLogin: vi.fn().mockResolvedValue(undefined),
    };

    registerNewCommands(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      vi.fn(),
      {} as never,
      () => [],
      () => fakeProvider as never,
    );

    const commandCall = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([command]) => command === openNewChatTabCommand);

    expect(commandCall).toBeDefined();

    const handler = commandCall?.[1] as (() => Promise<void>) | undefined;
    expect(handler).toBeDefined();

    await handler?.();

    expect(fakeProvider.show).toHaveBeenCalledTimes(1);
    expect(fakeProvider.createNewSession).toHaveBeenCalledTimes(1);
  });
});
