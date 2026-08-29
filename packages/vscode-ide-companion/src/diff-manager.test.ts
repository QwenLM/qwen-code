/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import { DiffContentProvider, DiffManager } from './diff-manager.js';

const { workspaceMock, openTextDocument, executeCommand, tabGroups } =
  vi.hoisted(() => ({
    workspaceMock: {
      workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
      openTextDocument: vi.fn(),
    },
    openTextDocument: vi.fn(),
    executeCommand: vi.fn(),
    tabGroups: { all: [] as unknown[], close: vi.fn() },
  }));

// A minimal stand-in for vscode.Uri: enough structure for the scheme/query
// rewrites DiffManager does and a stable toString() for its map keys.
function makeUri(fsPath: string, scheme = 'file', query = '') {
  return {
    fsPath,
    scheme,
    query,
    with(change: { scheme?: string; query?: string }) {
      return makeUri(fsPath, change.scheme ?? scheme, change.query ?? query);
    },
    toString() {
      return `${scheme}://${fsPath}${query ? `?${query}` : ''}`;
    },
  };
}

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceMock.workspaceFolders;
    },
    openTextDocument,
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    tabGroups,
  },
  commands: { executeCommand },
  ViewColumn: { Beside: -2 },
  Uri: {
    file: (fsPath: string) => makeUri(fsPath),
    joinPath: (base: { fsPath: string }, filePath: string) =>
      makeUri(`${base.fsPath}/${filePath}`),
  },
  EventEmitter: class {
    private listeners: Array<(e: unknown) => void> = [];
    event = (listener: (e: unknown) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire = (e: unknown) => {
      for (const listener of this.listeners) listener(e);
    };
  },
}));

vi.mock('./extension.js', () => ({ DIFF_SCHEME: 'qwen-diff' }));

vi.mock('./utils/editorGroupUtils.js', () => ({
  findLeftGroupOfChatWebview: () => undefined,
  findRightGroupOfChatWebview: () => undefined,
}));

describe('DiffManager path resolution', () => {
  let diffManager: DiffManager;
  let notifications: JSONRPCNotification[];

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMock.workspaceFolders = [{ uri: { fsPath: '/test/workspace1' } }];
    tabGroups.all = [];
    // The right-hand pane is read back through openTextDocument when a diff is
    // closed; the text it returns is what closeDiff resolves with.
    openTextDocument.mockResolvedValue({ getText: () => 'new content' });

    diffManager = new DiffManager(() => {}, new DiffContentProvider());
    notifications = [];
    diffManager.onDidChange((n) => notifications.push(n));
  });

  it('closes a diff opened with a workspace-relative path', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');

    await expect(diffManager.closeDiff('src/foo.ts')).resolves.toBe(
      'new content',
    );
  });

  it('closes a relative-opened diff when asked with the absolute path', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');

    await expect(
      diffManager.closeDiff('/test/workspace1/src/foo.ts'),
    ).resolves.toBe('new content');
  });

  it('closes an absolute-opened diff when asked with the relative path', async () => {
    await diffManager.showDiff('/test/workspace1/src/foo.ts', 'old', 'new');

    await expect(diffManager.closeDiff('src/foo.ts')).resolves.toBe(
      'new content',
    );
  });

  it('echoes the path the diff was opened with, not the one used to close', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');
    await diffManager.closeDiff('/test/workspace1/src/foo.ts');

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params).toMatchObject({
      filePath: 'src/foo.ts',
      content: 'new content',
    });
  });

  it('opens the diff against the resolved path', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');

    const diffCall = executeCommand.mock.calls.find(
      (call) => call[0] === 'vscode.diff',
    );
    expect(diffCall?.[1].fsPath).toBe('/test/workspace1/src/foo.ts');
    expect(diffCall?.[2].fsPath).toBe('/test/workspace1/src/foo.ts');
  });

  it('reads the old content from the resolved path', async () => {
    await diffManager.showDiff('src/foo.ts', 'new');

    expect(openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/test/workspace1/src/foo.ts' }),
    );
  });

  it('falls back to the raw path when no workspace folder is open', async () => {
    workspaceMock.workspaceFolders = [];

    await diffManager.showDiff('src/foo.ts', 'old', 'new');
    await expect(diffManager.closeDiff('src/foo.ts')).resolves.toBe(
      'new content',
    );

    const diffCall = executeCommand.mock.calls.find(
      (call) => call[0] === 'vscode.diff',
    );
    expect(diffCall?.[1].fsPath).toBe('src/foo.ts');
  });

  it('returns undefined when no diff matches the requested path', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');

    await expect(
      diffManager.closeDiff('src/other.ts'),
    ).resolves.toBeUndefined();
    expect(notifications).toHaveLength(0);
  });

  it('suppresses the notification when asked to', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');
    await diffManager.closeDiff('src/foo.ts', true);

    expect(notifications).toHaveLength(0);
  });
});
