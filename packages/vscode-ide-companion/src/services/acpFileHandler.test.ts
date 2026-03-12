/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpFileHandler } from './acpFileHandler.js';
import { promises as fs } from 'fs';

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  },
}));

describe('AcpFileHandler', () => {
  let handler: AcpFileHandler;

  beforeEach(() => {
    handler = new AcpFileHandler();
    vi.clearAllMocks();
  });

  describe('handleReadTextFile', () => {
    it('returns full content when no line/limit specified', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('line1\nline2\nline3\n');

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: null,
        limit: null,
      });

      expect(result.content).toBe('line1\nline2\nline3\n');
    });

    it('uses 1-based line indexing (ACP spec)', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        'line1\nline2\nline3\nline4\nline5',
      );

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: 2,
        limit: 2,
      });

      expect(result.content).toBe('line2\nline3');
    });

    it('treats line=1 as first line', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('first\nsecond\nthird');

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: 1,
        limit: 1,
      });

      expect(result.content).toBe('first');
    });

    it('defaults to line=1 when line is null but limit is set', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('a\nb\nc\nd');

      const result = await handler.handleReadTextFile({
        path: '/test/file.txt',
        sessionId: 'sid',
        line: null,
        limit: 2,
      });

      expect(result.content).toBe('a\nb');
    });

    it('clamps negative line values to 0', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('a\nb\nc');

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
      vi.mocked(fs.readFile).mockRejectedValue(err);

      await expect(
        handler.handleReadTextFile({
          path: '/missing/file.txt',
          sessionId: 'sid',
          line: null,
          limit: null,
        }),
      ).rejects.toThrow('ENOENT');
    });
  });

  describe('handleWriteTextFile', () => {
    it('creates directories and writes file', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await handler.handleWriteTextFile({
        path: '/test/dir/file.txt',
        content: 'hello',
        sessionId: 'sid',
      });

      expect(result).toBeNull();
      expect(fs.mkdir).toHaveBeenCalledWith('/test/dir', { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/dir/file.txt',
        'hello',
        'utf-8',
      );
    });

    it('trims whitespace from path', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await handler.handleWriteTextFile({
        path: '  /test/dir/file.txt  ',
        content: 'hello',
        sessionId: 'sid',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/dir/file.txt',
        'hello',
        'utf-8',
      );
    });

    it('rejects empty path', async () => {
      await expect(
        handler.handleWriteTextFile({
          path: '',
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('Invalid path: path must be a non-empty string');
    });

    it('rejects whitespace-only path', async () => {
      await expect(
        handler.handleWriteTextFile({
          path: '   ',
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow(
        'Invalid path: path cannot be empty or whitespace-only',
      );
    });

    it('rejects non-string path (number)', async () => {
      await expect(
        handler.handleWriteTextFile({
          path: 123 as unknown as string,
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('Invalid path: path must be a non-empty string');
    });

    it('rejects null path', async () => {
      await expect(
        handler.handleWriteTextFile({
          path: null as unknown as string,
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('Invalid path: path must be a non-empty string');
    });

    it('rejects undefined path', async () => {
      await expect(
        handler.handleWriteTextFile({
          path: undefined as unknown as string,
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('Invalid path: path must be a non-empty string');
    });

    it('rejects path with null byte', async () => {
      await expect(
        handler.handleWriteTextFile({
          path: '/test/file\0.txt',
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('Invalid path: path contains null byte character');
    });

    it('handles EINVAL error with helpful message', async () => {
      vi.mocked(fs.mkdir).mockRejectedValue(
        Object.assign(new Error('invalid argument'), { code: 'EINVAL' }),
      );

      await expect(
        handler.handleWriteTextFile({
          path: '/invalid:path/file.txt',
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('Invalid path');
    });

    it('handles EACCES error with helpful message', async () => {
      vi.mocked(fs.mkdir).mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      await expect(
        handler.handleWriteTextFile({
          path: '/root/protected/file.txt',
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('Permission denied');
    });

    it('handles ENOSPC error with helpful message', async () => {
      vi.mocked(fs.mkdir).mockRejectedValue(
        Object.assign(new Error('no space left'), { code: 'ENOSPC' }),
      );

      await expect(
        handler.handleWriteTextFile({
          path: '/test/file.txt',
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('No space left on device');
    });

    it('handles EISDIR error with helpful message', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockRejectedValue(
        Object.assign(new Error('is a directory'), { code: 'EISDIR' }),
      );

      await expect(
        handler.handleWriteTextFile({
          path: '/test/directory',
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow('Cannot write to directory');
    });

    it('handles generic errors', async () => {
      vi.mocked(fs.mkdir).mockRejectedValue(new Error('something went wrong'));

      await expect(
        handler.handleWriteTextFile({
          path: '/test/file.txt',
          content: 'hello',
          sessionId: 'sid',
        }),
      ).rejects.toThrow("Failed to write file '/test/file.txt'");
    });
  });
});
