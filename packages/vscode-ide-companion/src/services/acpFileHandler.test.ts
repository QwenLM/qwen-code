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
  });
});
