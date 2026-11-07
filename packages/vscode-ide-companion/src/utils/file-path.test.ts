/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWorkspacePath,
  shouldResolveAgainstWorkspace,
} from './file-path.js';

const { workspaceMock, joinPath } = vi.hoisted(() => ({
  workspaceMock: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  },
  joinPath: vi.fn((base: { fsPath: string }, filePath: string) => ({
    fsPath: `${base.fsPath}/${filePath}`,
  })),
}));

vi.mock('vscode', () => ({
  workspace: workspaceMock,
  Uri: { joinPath },
}));

describe('shouldResolveAgainstWorkspace', () => {
  it('returns true for relative paths', () => {
    expect(shouldResolveAgainstWorkspace('src/app.ts')).toBe(true);
    expect(shouldResolveAgainstWorkspace('nested/folder/file.ts')).toBe(true);
  });

  it('returns false for POSIX absolute paths', () => {
    expect(shouldResolveAgainstWorkspace('/workspace/src/app.ts')).toBe(false);
  });

  it('returns false for Windows drive-letter paths', () => {
    expect(shouldResolveAgainstWorkspace('C:\\workspace\\src\\app.ts')).toBe(
      false,
    );
    expect(shouldResolveAgainstWorkspace('C:/workspace/src/app.ts')).toBe(
      false,
    );
  });

  it('returns false for Windows UNC paths', () => {
    expect(shouldResolveAgainstWorkspace('\\\\server\\share\\app.ts')).toBe(
      false,
    );
  });
});

describe('resolveWorkspacePath', () => {
  beforeEach(() => {
    workspaceMock.workspaceFolders = [{ uri: { fsPath: '/test/workspace1' } }];
    joinPath.mockClear();
  });

  it('joins a relative path onto the first workspace folder', () => {
    expect(resolveWorkspacePath('src/foo.ts')).toBe(
      '/test/workspace1/src/foo.ts',
    );
  });

  it('resolves against the first folder when several are open', () => {
    workspaceMock.workspaceFolders = [
      { uri: { fsPath: '/test/workspace1' } },
      { uri: { fsPath: '/test/workspace2' } },
    ];

    expect(resolveWorkspacePath('src/foo.ts')).toBe(
      '/test/workspace1/src/foo.ts',
    );
  });

  it('leaves absolute paths untouched', () => {
    expect(resolveWorkspacePath('/absolute/path/file.ts')).toBe(
      '/absolute/path/file.ts',
    );
    expect(joinPath).not.toHaveBeenCalled();
  });

  it('returns the raw path when no folder is open', () => {
    workspaceMock.workspaceFolders = [];

    expect(resolveWorkspacePath('src/foo.ts')).toBe('src/foo.ts');
    expect(joinPath).not.toHaveBeenCalled();
  });

  it('returns the raw path when workspaceFolders is undefined', () => {
    (workspaceMock as { workspaceFolders?: unknown }).workspaceFolders =
      undefined;

    expect(resolveWorkspacePath('src/foo.ts')).toBe('src/foo.ts');
    expect(joinPath).not.toHaveBeenCalled();
  });
});
