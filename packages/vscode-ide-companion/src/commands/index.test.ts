/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  authCommand,
  closeDiffCommand,
  focusChatCommand,
  openNewChatTabCommand,
  registerNewCommands,
  showDiffCommand,
} from './index.js';

const {
  registerCommand,
  executeCommand,
  showWarningMessage,
  showInformationMessage,
  joinPath,
  workspaceMock,
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
  joinPath: vi.fn((base: { fsPath: string }, filePath: string) => ({
    fsPath: `${base.fsPath}/${filePath}`,
  })),
  workspaceMock: {
    workspaceFolders: [] as Array<{
      uri: { fsPath: string };
      name: string;
      index: number;
    }>,
  },
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
  workspace: workspaceMock,
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
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
    joinPath.mockClear();
    diffManager.showDiff.mockClear();
    log.mockClear();
    workspaceMock.workspaceFolders = [];
  });

  it.each(['logout', 'upgrade'])(
    'registers the native subscription %s command',
    (action) => {
      registerNewCommands(
        context as never,
        log,
        diffManager as never,
        () => [],
        vi.fn() as never,
      );
      expect(registerCommand.mock.calls.map(([id]) => id)).toContain(
        `qwen-code.${action}`,
      );
    },
  );

  it.each(['logout', 'upgrade'])(
    'exposes subscription %s in the command palette',
    (action) => {
      const manifest = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as {
        contributes: {
          commands: Array<{ command: string; title: string }>;
          menus: { commandPalette: Array<{ command: string; when: string }> };
        };
      };
      expect(manifest.contributes.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: `qwen-code.${action}`,
            title: expect.any(String),
          }),
        ]),
      );
      expect(manifest.contributes.menus.commandPalette).toContainEqual({
        command: `qwen-code.${action}`,
        when: 'qwen-code.subscriptionEnabled',
      });
    },
  );

  it('openNewChatTab opens a new provider without creating a second session explicitly', async () => {
    const provider = {
      show: vi.fn().mockResolvedValue(undefined),
      createNewSession: vi.fn().mockResolvedValue(undefined),
      startInteractiveAuth: vi.fn().mockResolvedValue(undefined),
      setInitialModelId: vi.fn(),
    };

    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      () => provider as never,
    );

    await getRegisteredHandler(openNewChatTabCommand)({
      initialModelId: 'glm-5',
    });

    expect(provider.show).toHaveBeenCalledTimes(1);
    expect(provider.createNewSession).not.toHaveBeenCalled();
    expect(provider.setInitialModelId).toHaveBeenCalledWith('glm-5');
  });

  it('auth opens the interactive provider setup flow instead of VS Code settings', async () => {
    const provider = {
      show: vi.fn().mockResolvedValue(undefined),
      startInteractiveAuth: vi.fn().mockResolvedValue(undefined),
    };

    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [provider as never],
      vi.fn(() => provider as never),
    );

    await getRegisteredHandler(authCommand)();

    expect(provider.show).toHaveBeenCalledTimes(1);
    expect(provider.startInteractiveAuth).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it.each(['logout', 'upgrade'] as const)(
    'routes palette %s to the active provider native action',
    async (action) => {
      const provider = {
        show: vi.fn().mockResolvedValue(undefined),
        startSubscriptionAction: vi.fn().mockResolvedValue(undefined),
        startInteractiveAuth: vi.fn(),
      };
      registerNewCommands(
        context as never,
        log,
        diffManager as never,
        () => [provider as never],
        vi.fn(() => provider as never),
      );
      await getRegisteredHandler(`qwen-code.${action}`)();
      expect(provider.show).toHaveBeenCalledOnce();
      expect(provider.startSubscriptionAction).toHaveBeenCalledWith(action);
      expect(provider.startInteractiveAuth).not.toHaveBeenCalled();
    },
  );

  it('focusChat focuses the Activity Bar chat view', async () => {
    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      vi.fn() as never,
    );

    await getRegisteredHandler(focusChatCommand)();

    expect(executeCommand).toHaveBeenCalledWith(
      'qwen-code.chatView.sidebar.focus',
    );
  });

  it('showDiff resolves relative paths against the workspace', async () => {
    workspaceMock.workspaceFolders = [
      { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
    ];

    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      vi.fn() as never,
    );

    await getRegisteredHandler(showDiffCommand)({
      path: 'src/app.ts',
      oldText: 'old',
      newText: 'new',
    });

    expect(joinPath).toHaveBeenCalledWith(
      { fsPath: '/workspace' },
      'src/app.ts',
    );
    expect(diffManager.showDiff).toHaveBeenCalledWith(
      '/workspace/src/app.ts',
      'old',
      'new',
      { readOnly: false, permissionRequestId: undefined },
    );
  });

  it('closeDiff resolves relative paths against the workspace', async () => {
    workspaceMock.workspaceFolders = [
      { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
    ];
    const closeDiff = vi.fn().mockResolvedValue(undefined);

    registerNewCommands(
      context as never,
      log,
      { showDiff: vi.fn(), closeDiff } as never,
      () => [],
      vi.fn() as never,
    );

    await getRegisteredHandler(closeDiffCommand)('src/foo.ts');

    expect(joinPath).toHaveBeenCalledWith(
      { fsPath: '/workspace' },
      'src/foo.ts',
    );
    expect(closeDiff).toHaveBeenCalledWith(
      '/workspace/src/foo.ts',
      true,
      undefined,
    );
  });

  it('closeDiff keeps absolute paths unchanged', async () => {
    workspaceMock.workspaceFolders = [
      { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
    ];
    const closeDiff = vi.fn().mockResolvedValue(undefined);

    registerNewCommands(
      context as never,
      log,
      { showDiff: vi.fn(), closeDiff } as never,
      () => [],
      vi.fn() as never,
    );

    await getRegisteredHandler(closeDiffCommand)('/workspace/src/foo.ts');

    expect(joinPath).not.toHaveBeenCalled();
    expect(closeDiff).toHaveBeenCalledWith(
      '/workspace/src/foo.ts',
      true,
      undefined,
    );
  });

  it('showDiff keeps UNC paths absolute', async () => {
    workspaceMock.workspaceFolders = [
      { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
    ];

    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      vi.fn() as never,
    );

    await getRegisteredHandler(showDiffCommand)({
      path: '\\\\server\\share\\app.ts',
      oldText: 'old',
      newText: 'new',
    });

    expect(joinPath).not.toHaveBeenCalled();
    expect(diffManager.showDiff).toHaveBeenCalledWith(
      '\\\\server\\share\\app.ts',
      'old',
      'new',
      { readOnly: false, permissionRequestId: undefined },
    );
  });

  // R3-2: every existing showDiff case leaves permissionRequestId undefined, so
  // the hop that binds a diff to a pending approval was never exercised.
  it('showDiff forwards a defined permission request id', async () => {
    workspaceMock.workspaceFolders = [
      { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
    ];

    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      vi.fn() as never,
    );

    await getRegisteredHandler(showDiffCommand)({
      path: '/workspace/src/app.ts',
      oldText: 'old',
      newText: 'new',
      readOnly: true,
      permissionRequestId: 'req-42',
    });

    expect(diffManager.showDiff).toHaveBeenCalledWith(
      '/workspace/src/app.ts',
      'old',
      'new',
      { readOnly: true, permissionRequestId: 'req-42' },
    );
  });

  // R3-3: the close side of the same binding. Without the id, closeDiff would
  // close any diff for that path, including one owned by another approval.
  it('closeDiff forwards a defined permission request id', async () => {
    workspaceMock.workspaceFolders = [
      { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
    ];
    const closeDiff = vi.fn().mockResolvedValue(undefined);

    registerNewCommands(
      context as never,
      log,
      { showDiff: vi.fn(), closeDiff } as never,
      () => [],
      vi.fn() as never,
    );

    await getRegisteredHandler(closeDiffCommand)('src/foo.ts', 'req-42');

    expect(closeDiff).toHaveBeenCalledWith(
      '/workspace/src/foo.ts',
      true,
      'req-42',
    );
  });

  it('showDiff forwards the readOnly flag', async () => {
    workspaceMock.workspaceFolders = [
      { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
    ];

    registerNewCommands(
      context as never,
      log,
      diffManager as never,
      () => [],
      vi.fn() as never,
    );

    await getRegisteredHandler(showDiffCommand)({
      path: '/workspace/src/app.ts',
      oldText: 'old',
      newText: 'new',
      readOnly: true,
    });

    expect(diffManager.showDiff).toHaveBeenCalledWith(
      '/workspace/src/app.ts',
      'old',
      'new',
      { readOnly: true, permissionRequestId: undefined },
    );
  });
});
