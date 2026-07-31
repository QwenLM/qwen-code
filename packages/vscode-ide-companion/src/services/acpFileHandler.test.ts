/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mocks are accessible inside the vi.mock factory
// (vi.mock calls are hoisted to the top of the file by Vitest).
const {
  mockGetText,
  mockPositionAt,
  mockSave,
  mockApplyEdit,
  mockOpenTextDocument,
  mockCreateDirectory,
  mockStatFile,
  mockWriteFile,
} = vi.hoisted(() => {
  const mockGetText = vi.fn();
  const mockPositionAt = vi.fn((offset: number) => ({ offset }));
  const mockSave = vi.fn().mockResolvedValue(true);
  const mockApplyEdit = vi.fn().mockResolvedValue(true);
  const mockOpenTextDocument = vi.fn().mockResolvedValue({
    getText: mockGetText,
    positionAt: mockPositionAt,
    isDirty: false,
    save: mockSave,
  });
  const mockCreateDirectory = vi.fn().mockResolvedValue(undefined);
  const mockStatFile = vi.fn();
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
  return {
    mockGetText,
    mockPositionAt,
    mockSave,
    mockApplyEdit,
    mockOpenTextDocument,
    mockCreateDirectory,
    mockStatFile,
    mockWriteFile,
  };
});

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => p }),
  },
  workspace: {
    openTextDocument: mockOpenTextDocument,
    applyEdit: mockApplyEdit,
    fs: {
      createDirectory: mockCreateDirectory,
      stat: mockStatFile,
      writeFile: mockWriteFile,
    },
  },
  WorkspaceEdit: class {
    replace = vi.fn();
  },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
}));

import { AcpFileHandler } from './acpFileHandler.js';

describe('AcpFileHandler', () => {
  let handler: AcpFileHandler;

  beforeEach(() => {
    handler = new AcpFileHandler();
    vi.clearAllMocks();
    // Restore default implementations after clearAllMocks
    mockOpenTextDocument.mockResolvedValue({
      getText: mockGetText,
      positionAt: mockPositionAt,
      isDirty: false,
      save: mockSave,
    });
    mockApplyEdit.mockResolvedValue(true);
    mockCreateDirectory.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  describe('handleReadTextFile', () => {
    it('returns full content when no line/limit specified', async () => {
      mockGetText.mockReturnValue('line1\nline2\nline3\n');

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: null,
        limit: null,
      });

      expect(result.content).toBe('line1\nline2\nline3\n');
    });

    it('uses 1-based line indexing (ACP spec)', async () => {
      mockGetText.mockReturnValue('line1\nline2\nline3\nline4\nline5');

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: 2,
        limit: 2,
      });

      expect(result.content).toBe('line2\nline3');
    });

    it('treats line=1 as first line', async () => {
      mockGetText.mockReturnValue('first\nsecond\nthird');

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: 1,
        limit: 1,
      });

      expect(result.content).toBe('first');
    });

    it('defaults to line=1 when line is null but limit is set', async () => {
      mockGetText.mockReturnValue('a\nb\nc\nd');

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: null,
        limit: 2,
      });

      expect(result.content).toBe('a\nb');
    });

    it('clamps negative line values to 0', async () => {
      mockGetText.mockReturnValue('a\nb\nc');

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: -5,
        limit: null,
      });

      expect(result.content).toBe('a\nb\nc');
    });

    it('propagates ENOENT errors', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockOpenTextDocument.mockRejectedValue(err);

      await expect(
        handler.handleReadTextFile({
          path: '/missing/file.txt',
          sessionId: 'sid',
          line: null,
          limit: null,
        }),
      ).rejects.toThrow('ENOENT');
    });

    it('normalises VS Code FileNotFound to ENOENT', async () => {
      // vscode.FileSystemError.FileNotFound sets code = 'FileNotFound'
      const err = new Error('file not found') as NodeJS.ErrnoException;
      (err as unknown as Record<string, unknown>).code = 'FileNotFound';
      mockOpenTextDocument.mockRejectedValue(err);

      const rejection = handler.handleReadTextFile({
        path: '/missing/file.txt',
        sessionId: 'sid',
        line: null,
        limit: null,
      });

      await expect(rejection).rejects.toThrow('ENOENT');
      await expect(rejection).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('handleWriteTextFile', () => {
    it('creates directory and uses WorkspaceEdit for existing file', async () => {
      // stat resolves → file exists
      mockStatFile.mockResolvedValue({});
      mockGetText.mockReturnValue('old content');

      const result = await handler.handleWriteTextFile({
        path: '/test/dir/file.txt',
        content: 'hello',
        sessionId: 'sid',
      });

      expect(result).toBeNull();
      expect(mockCreateDirectory).toHaveBeenCalled();
      expect(mockApplyEdit).toHaveBeenCalled();
    });

    it('writes bytes directly for new (non-existing) file', async () => {
      // stat rejects → file does not exist
      mockStatFile.mockRejectedValue(new Error('FileNotFound'));

      const result = await handler.handleWriteTextFile({
        path: '/test/dir/newfile.txt',
        content: 'hello',
        sessionId: 'sid',
      });

      expect(result).toBeNull();
      expect(mockCreateDirectory).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: '/test/dir/newfile.txt' }),
        expect.any(Uint8Array),
      );
    });
  });
});
