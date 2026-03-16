/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { StandardFileSystemService } from './fileSystemService.js';

const mockPlatform = vi.hoisted(() => vi.fn().mockReturnValue('linux'));

vi.mock('fs/promises');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      platform: mockPlatform,
    },
  };
});

vi.mock('../utils/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fileUtils.js')>();
  return {
    ...actual,
    readFileWithLineAndLimit: vi.fn(),
  };
});

import { readFileWithLineAndLimit } from '../utils/fileUtils.js';

describe('StandardFileSystemService', () => {
  let fileSystem: StandardFileSystemService;

  beforeEach(() => {
    vi.resetAllMocks();
    fileSystem = new StandardFileSystemService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readTextFile', () => {
    it('should read file content and return ReadTextFileResponse', async () => {
      vi.mocked(readFileWithLineAndLimit).mockResolvedValue({
        content: 'Hello, World!',
        bom: false,
        encoding: 'utf-8',
        originalLineCount: 1,
      });

      const result = await fileSystem.readTextFile({ path: '/test/file.txt' });

      expect(readFileWithLineAndLimit).toHaveBeenCalledWith({
        path: '/test/file.txt',
        limit: Infinity,
        line: 0,
      });
      expect(result.content).toBe('Hello, World!');
      expect(result._meta?.bom).toBe(false);
      expect(result._meta?.encoding).toBe('utf-8');
    });

    it('should pass limit and line params to readFileWithLineAndLimit', async () => {
      vi.mocked(readFileWithLineAndLimit).mockResolvedValue({
        content: 'line 5',
        bom: false,
        encoding: 'utf-8',
        originalLineCount: 100,
      });

      const result = await fileSystem.readTextFile({
        path: '/test/file.txt',
        limit: 10,
        line: 5,
      });

      expect(readFileWithLineAndLimit).toHaveBeenCalledWith({
        path: '/test/file.txt',
        limit: 10,
        line: 5,
      });
      expect(result._meta?.originalLineCount).toBe(100);
    });

    it('should return encoding info for GBK file', async () => {
      vi.mocked(readFileWithLineAndLimit).mockResolvedValue({
        content: '你好世界',
        bom: false,
        encoding: 'gb18030',
        originalLineCount: 1,
      });

      const result = await fileSystem.readTextFile({ path: '/test/gbk.txt' });

      expect(result.content).toBe('你好世界');
      expect(result._meta?.encoding).toBe('gb18030');
      expect(result._meta?.bom).toBe(false);
    });

    it('should propagate readFileWithLineAndLimit errors', async () => {
      const error = new Error('ENOENT: File not found');
      vi.mocked(readFileWithLineAndLimit).mockRejectedValue(error);

      await expect(
        fileSystem.readTextFile({ path: '/test/file.txt' }),
      ).rejects.toThrow('ENOENT: File not found');
    });
  });

  describe('writeTextFile', () => {
    it('should write file content using fs', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/file.txt',
        content: 'Hello, World!',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/file.txt',
        'Hello, World!',
        'utf-8',
      );
    });

    it('should write file with BOM when bom option is true', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/file.txt',
        content: 'Hello, World!',
        _meta: { bom: true },
      });

      // Verify that fs.writeFile was called with a Buffer that starts with BOM
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[0]).toBe('/test/file.txt');
      expect(writeCall[1]).toBeInstanceOf(Buffer);
      const buffer = writeCall[1] as Buffer;
      expect(buffer[0]).toBe(0xef);
      expect(buffer[1]).toBe(0xbb);
      expect(buffer[2]).toBe(0xbf);
    });

    it('should write file without BOM when bom option is false', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/file.txt',
        content: 'Hello, World!',
        _meta: { bom: false },
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/file.txt',
        'Hello, World!',
        'utf-8',
      );
    });

    it('should not duplicate BOM when content already has BOM character', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      // Content that includes the BOM character (as readTextFile would return)
      const contentWithBOM = '\uFEFF' + 'Hello';
      await fileSystem.writeTextFile({
        path: '/test/file.txt',
        content: contentWithBOM,
        _meta: { bom: true },
      });

      // Verify that fs.writeFile was called with a Buffer that has only one BOM
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[0]).toBe('/test/file.txt');
      expect(writeCall[1]).toBeInstanceOf(Buffer);
      const buffer = writeCall[1] as Buffer;
      // First three bytes should be BOM
      expect(buffer[0]).toBe(0xef);
      expect(buffer[1]).toBe(0xbb);
      expect(buffer[2]).toBe(0xbf);
      // Fourth byte should be 'H' (0x48), not another BOM
      expect(buffer[3]).toBe(0x48);
      // Count BOM sequences in the buffer - should be only one
      let bomCount = 0;
      for (let i = 0; i <= buffer.length - 3; i++) {
        if (
          buffer[i] === 0xef &&
          buffer[i + 1] === 0xbb &&
          buffer[i + 2] === 0xbf
        ) {
          bomCount++;
        }
      }
      expect(bomCount).toBe(1);
    });

    it('should write file with non-UTF-8 encoding using iconv-lite', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/file.txt',
        content: '你好世界',
        _meta: { encoding: 'gbk' },
      });

      // Verify that fs.writeFile was called with a Buffer (iconv-encoded)
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[0]).toBe('/test/file.txt');
      expect(writeCall[1]).toBeInstanceOf(Buffer);
    });

    it('should write file as UTF-8 when encoding is utf-8', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/file.txt',
        content: 'Hello',
        _meta: { encoding: 'utf-8' },
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/file.txt',
        'Hello',
        'utf-8',
      );
    });

    it('should preserve UTF-16LE BOM when writing back a UTF-16LE file', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/file.txt',
        content: 'Hello',
        _meta: { encoding: 'utf-16le', bom: true },
      });

      // iconv-lite encodes as UTF-16LE; with bom:true the FF FE BOM is prepended
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[0]).toBe('/test/file.txt');
      expect(writeCall[1]).toBeInstanceOf(Buffer);
      const buf = writeCall[1] as Buffer;
      // First two bytes must be the UTF-16LE BOM: FF FE
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xfe);
    });

    it('should not add BOM when writing UTF-16LE file without bom flag', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/file.txt',
        content: 'Hello',
        _meta: { encoding: 'utf-16le', bom: false },
      });

      // No BOM prepended — raw iconv-encoded buffer written directly
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[0]).toBe('/test/file.txt');
      expect(writeCall[1]).toBeInstanceOf(Buffer);
      const buf = writeCall[1] as Buffer;
      // First two bytes should NOT be FF FE (the UTF-16LE BOM)
      expect(!(buf[0] === 0xff && buf[1] === 0xfe)).toBe(true);
    });

    it('should convert LF to CRLF when writing .bat files on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/script.bat',
        content: '@echo off\necho hello\nexit /b 0\n',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/script.bat',
        '@echo off\r\necho hello\r\nexit /b 0\r\n',
        'utf-8',
      );
    });

    it('should convert LF to CRLF when writing .cmd files on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/script.cmd',
        content: '@echo off\necho hello\n',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/script.cmd',
        '@echo off\r\necho hello\r\n',
        'utf-8',
      );
    });

    it('should not double-convert existing CRLF in .bat files on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/script.bat',
        content: '@echo off\r\necho hello\r\n',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/script.bat',
        '@echo off\r\necho hello\r\n',
        'utf-8',
      );
    });

    it('should handle mixed line endings in .bat files on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/script.bat',
        content: 'line1\r\nline2\nline3\r\n',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/script.bat',
        'line1\r\nline2\r\nline3\r\n',
        'utf-8',
      );
    });

    it('should be case-insensitive for .BAT extension on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/SCRIPT.BAT',
        content: 'echo hello\n',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/SCRIPT.BAT',
        'echo hello\r\n',
        'utf-8',
      );
    });

    it('should not convert line endings for non-.bat/.cmd files on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/script.sh',
        content: '#!/bin/bash\necho hello\n',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/script.sh',
        '#!/bin/bash\necho hello\n',
        'utf-8',
      );
    });

    it('should not convert line endings for .bat files on non-Windows', async () => {
      mockPlatform.mockReturnValue('darwin');
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile({
        path: '/test/script.bat',
        content: '@echo off\necho hello\n',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/script.bat',
        '@echo off\necho hello\n',
        'utf-8',
      );
    });
  });
});
