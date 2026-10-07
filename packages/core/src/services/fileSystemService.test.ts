/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import {
  StandardFileSystemService,
  needsUtf8Bom,
  resetUtf8BomCache,
  detectLineEnding,
  ensureCrlfLineEndings,
  type CoreReadTextCursorRequest,
  type CoreReadTextFileHandleRequest,
  type CoreWriteTextFileRequest,
} from './fileSystemService.js';
import { encodeTextFileContent } from './sync-file-encoding.js';

const mockPlatform = vi.hoisted(() => vi.fn().mockReturnValue('linux'));
const mockGetSystemEncoding = vi.hoisted(() =>
  vi.fn().mockReturnValue('utf-8'),
);

vi.mock('fs/promises');
vi.mock('os', () => ({
  default: {
    platform: mockPlatform,
  },
  platform: mockPlatform,
}));
vi.mock('../utils/systemEncoding.js', () => ({
  getSystemEncoding: mockGetSystemEncoding,
}));

vi.mock('../utils/atomicFileWrite.js', () => ({
  atomicWriteFile: vi.fn(
    async (
      filePath: string,
      data: string | Buffer,
      options?: { encoding?: BufferEncoding },
    ) => {
      const fsMock = await import('fs/promises');
      if (typeof data === 'string' && options?.encoding) {
        await fsMock.default.writeFile(filePath, data, options.encoding);
      } else {
        await fsMock.default.writeFile(filePath, data);
      }
    },
  ),
}));

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
    resetUtf8BomCache();
    mockPlatform.mockReturnValue('linux');
    mockGetSystemEncoding.mockReturnValue('utf-8');
    fileSystem = new StandardFileSystemService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  type ReadResult = Awaited<ReturnType<typeof readFileWithLineAndLimit>>;
  const mockRead = (content: string, over: Partial<ReadResult> = {}) =>
    vi.mocked(readFileWithLineAndLimit).mockResolvedValue({
      content,
      bom: false,
      encoding: 'utf-8',
      originalLineCount: 1,
      originalLineCountExact: true,
      truncatedByBytes: false,
      ...over,
    });
  async function write(
    path: string,
    content: string,
    _meta?: CoreWriteTextFileRequest['_meta'],
  ) {
    vi.mocked(fs.writeFile).mockResolvedValue();
    await fileSystem.writeTextFile({
      path,
      content,
      ...(_meta ? { _meta } : {}),
    });
  }
  // Writes `content` and expects `expected` to reach fs.writeFile as UTF-8 text.
  async function expectWrite(
    path: string,
    content: string,
    expected: string,
    _meta?: CoreWriteTextFileRequest['_meta'],
  ) {
    await write(path, content, _meta);
    expect(fs.writeFile).toHaveBeenCalledWith(path, expected, 'utf-8');
  }
  // Asserts the first fs.writeFile call wrote a Buffer to /test/file.txt.
  function writtenBuffer(): Buffer {
    const [writtenPath, data] = vi.mocked(fs.writeFile).mock.calls[0];
    expect(writtenPath).toBe('/test/file.txt');
    expect(data).toBeInstanceOf(Buffer);
    return data as Buffer;
  }
  const onHost = (platform: string, encoding?: string | null) => {
    mockPlatform.mockReturnValue(platform);
    if (encoding !== undefined) mockGetSystemEncoding.mockReturnValue(encoding);
  };

  describe('readTextFile', () => {
    it('should read file content and return ReadTextFileResponse', async () => {
      mockRead('Hello, World!');

      const result = await fileSystem.readTextFile({ path: '/test/file.txt' });

      expect(readFileWithLineAndLimit).toHaveBeenCalledWith({
        path: '/test/file.txt',
        limit: Infinity,
      });
      expect(result.content).toBe('Hello, World!');
      expect(result._meta?.bom).toBe(false);
      expect(result._meta?.encoding).toBe('utf-8');
    });

    it('should pass limit and line params to readFileWithLineAndLimit', async () => {
      mockRead('line 5', { originalLineCount: 100 });

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

    it('should preserve explicit line zero for offset reads', async () => {
      mockRead('line 1', { originalLineCount: 100 });

      await fileSystem.readTextFile({ path: '/test/file.txt', line: 0 });

      expect(readFileWithLineAndLimit).toHaveBeenCalledWith({
        path: '/test/file.txt',
        limit: Infinity,
        line: 0,
      });
    });

    it('should pass maxOutputBytes and return byte-truncation metadata', async () => {
      mockRead('partial', { originalLineCount: 100, truncatedByBytes: true });

      const result = await fileSystem.readTextFile({
        path: '/test/file.txt',
        limit: 10,
        line: 5,
        maxOutputBytes: 128,
      });

      expect(readFileWithLineAndLimit).toHaveBeenCalledWith({
        path: '/test/file.txt',
        limit: 10,
        line: 5,
        maxOutputBytes: 128,
      });
      expect(result._meta?.truncatedByBytes).toBe(true);
    });

    it('should pass cached stats to readFileWithLineAndLimit', async () => {
      const stats = { size: 123 } as import('node:fs').Stats;
      mockRead('line 1');

      await fileSystem.readTextFile({
        path: '/test/file.txt',
        maxOutputBytes: 128,
        stats,
      });

      expect(readFileWithLineAndLimit).toHaveBeenCalledWith({
        path: '/test/file.txt',
        limit: Infinity,
        maxOutputBytes: 128,
        stats,
      });
    });

    // Handle-bound reads no longer route through `readFileWithLineAndLimit`,
    // so asserting the arguments it was called with would test nothing. The
    // behaviour is covered against real files in `read-text-range.test.ts`
    // and at the real boundary in `workspace-file-system.test.ts`; only the
    // argument validation below needs a unit test, and it needs no mock.
    const handleRead = (over: Partial<CoreReadTextFileHandleRequest>) =>
      fileSystem.readTextFileFromHandle({
        fileHandle: {} as import('node:fs/promises').FileHandle,
        fileSize: 300_000,
        limit: 20,
        maxOutputBytes: 262_144,
        maxScanBytes: 8 * 1024 * 1024,
        ...over,
      });
    const cursorRead = (over: Partial<CoreReadTextCursorRequest>) =>
      fileSystem.readTextCursorFromHandle({
        fileHandle: {} as import('node:fs/promises').FileHandle,
        startOffset: 0,
        fileSize: 300_000,
        limit: 20,
        maxOutputBytes: 262_144,
        maxSnapBytes: 8 * 1024 * 1024,
        ...over,
      });

    it.each([
      ['maxOutputBytes', { maxOutputBytes: Number.POSITIVE_INFINITY }],
      ['maxScanBytes', { maxScanBytes: Number.POSITIVE_INFINITY }],
      ['maxOutputBytes', { maxOutputBytes: 0 }],
      ['maxScanBytes', { maxScanBytes: -1 }],
    ])('should reject a handle read with unbounded %s', async (bound, over) => {
      await expect(handleRead(over)).rejects.toThrow(
        new RegExp(`positive finite ${bound}`),
      );
    });

    it.each([
      ['a fractional limit', 2.5],
      ['a zero limit', 0],
      ['a negative limit', -1],
    ])('should reject %s on a handle read', async (_label, limit) => {
      await expect(handleRead({ limit })).rejects.toThrow(
        /positive integer limit or Infinity/,
      );
    });

    it.each([
      ['fileSize', { fileSize: -1 }],
      ['fileSize', { fileSize: 1.5 }],
      ['line', { line: -1 }],
      ['line', { line: 1.5 }],
    ])('should reject invalid handle-bound %s', async (field, over) => {
      await expect(handleRead({ limit: 1, ...over })).rejects.toThrow(
        new RegExp(field),
      );
    });

    it.each([
      ['maxOutputBytes', { maxOutputBytes: Number.POSITIVE_INFINITY }],
      ['maxOutputBytes', { maxOutputBytes: 0 }],
      ['maxSnapBytes', { maxSnapBytes: Number.POSITIVE_INFINITY }],
      ['maxSnapBytes', { maxSnapBytes: 0 }],
    ])('should reject invalid cursor-bound %s', async (bound, over) => {
      await expect(cursorRead(over)).rejects.toThrow(
        new RegExp(`positive finite ${bound}`),
      );
    });

    it.each([
      ['startOffset', { startOffset: -1 }],
      ['startOffset', { startOffset: 1.5 }],
      ['fileSize', { fileSize: -1 }],
      ['fileSize', { fileSize: 1.5 }],
    ])('should reject invalid cursor-bound %s', async (field, over) => {
      await expect(cursorRead(over)).rejects.toThrow(new RegExp(field));
    });

    it.each([2.5, 0, -1])(
      'should reject invalid cursor-bound limit %s',
      async (limit) => {
        await expect(cursorRead({ limit })).rejects.toThrow(
          /positive integer limit/,
        );
      },
    );

    it('should return encoding info for GBK file', async () => {
      mockRead('你好世界', { encoding: 'gb18030' });

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
    it('encodeTextFileContent returns final bytes for UTF-8 and CRLF metadata', () => {
      const encoded = encodeTextFileContent('/test/file.txt', 'a\nb\n', {
        lineEnding: 'crlf',
      });
      expect(encoded.toString('utf8')).toBe('a\r\nb\r\n');
    });

    it('encodeTextFileContent preserves UTF-8 BOM in returned bytes', () => {
      const encoded = encodeTextFileContent('/test/file.txt', 'Hello', {
        bom: true,
      });
      expect(Array.from(encoded.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
      expect(encoded.subarray(3).toString('utf8')).toBe('Hello');
    });

    it('should write file content using fs', async () => {
      await expectWrite('/test/file.txt', 'Hello, World!', 'Hello, World!');
    });

    it('should write file with BOM when bom option is true', async () => {
      await write('/test/file.txt', 'Hello, World!', { bom: true });

      // fs.writeFile got a Buffer that starts with the BOM.
      const buffer = writtenBuffer();
      expect(buffer[0]).toBe(0xef);
      expect(buffer[1]).toBe(0xbb);
      expect(buffer[2]).toBe(0xbf);
    });

    it('should write file without BOM when bom option is false', async () => {
      await expectWrite('/test/file.txt', 'Hello, World!', 'Hello, World!', {
        bom: false,
      });
    });

    it('should not duplicate BOM when content already has BOM character', async () => {
      // Content that includes the BOM character (as readTextFile would return)
      await write('/test/file.txt', '﻿' + 'Hello', { bom: true });

      // fs.writeFile got a Buffer with exactly one BOM.
      const buffer = writtenBuffer();
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
      await write('/test/file.txt', '你好世界', { encoding: 'gbk' });
      // fs.writeFile got an iconv-encoded Buffer.
      writtenBuffer();
    });

    it('should write file as UTF-8 when encoding is utf-8', async () => {
      await expectWrite('/test/file.txt', 'Hello', 'Hello', {
        encoding: 'utf-8',
      });
    });

    it('should preserve UTF-16LE BOM when writing back a UTF-16LE file', async () => {
      await write('/test/file.txt', 'Hello', {
        encoding: 'utf-16le',
        bom: true,
      });

      // iconv-lite encodes as UTF-16LE; with bom:true the FF FE BOM is
      // prepended, so the first two bytes must be FF FE.
      const buf = writtenBuffer();
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xfe);
    });

    it('should not add BOM when writing UTF-16LE file without bom flag', async () => {
      await write('/test/file.txt', 'Hello', {
        encoding: 'utf-16le',
        bom: false,
      });

      // No BOM prepended: the raw iconv-encoded buffer is written directly,
      // so the first two bytes should NOT be FF FE (the UTF-16LE BOM).
      const buf = writtenBuffer();
      expect(!(buf[0] === 0xff && buf[1] === 0xfe)).toBe(true);
    });

    it('should convert LF to CRLF when writing .bat files on Windows', async () => {
      onHost('win32');
      await expectWrite(
        '/test/script.bat',
        '@echo off\necho hello\nexit /b 0\n',
        '@echo off\r\necho hello\r\nexit /b 0\r\n',
      );
    });

    it('should convert LF to CRLF when writing .cmd files on Windows', async () => {
      onHost('win32');
      await expectWrite(
        '/test/script.cmd',
        '@echo off\necho hello\n',
        '@echo off\r\necho hello\r\n',
      );
    });

    it('should not double-convert existing CRLF in .bat files on Windows', async () => {
      onHost('win32');
      await expectWrite(
        '/test/script.bat',
        '@echo off\r\necho hello\r\n',
        '@echo off\r\necho hello\r\n',
      );
    });

    it('should handle mixed line endings in .bat files on Windows', async () => {
      onHost('win32');
      await expectWrite(
        '/test/script.bat',
        'line1\r\nline2\nline3\r\n',
        'line1\r\nline2\r\nline3\r\n',
      );
    });

    it('should be case-insensitive for .BAT extension on Windows', async () => {
      onHost('win32');
      await expectWrite('/test/SCRIPT.BAT', 'echo hello\n', 'echo hello\r\n');
    });

    it('should not convert line endings for non-.bat/.cmd files on Windows', async () => {
      onHost('win32');
      await expectWrite(
        '/test/script.sh',
        '#!/bin/bash\necho hello\n',
        '#!/bin/bash\necho hello\n',
      );
    });

    it('should not convert line endings for .bat files on non-Windows', async () => {
      onHost('darwin');
      await expectWrite(
        '/test/script.bat',
        '@echo off\necho hello\n',
        '@echo off\necho hello\n',
      );
    });
  });

  describe('needsUtf8Bom', () => {
    beforeEach(() => {
      resetUtf8BomCache();
    });

    it('should return true for .ps1 files on Windows with non-UTF-8 code page', () => {
      onHost('win32', 'gbk');
      expect(needsUtf8Bom('/test/script.ps1')).toBe(true);
    });

    it('should return true for .PS1 files (case-insensitive)', () => {
      onHost('win32', 'gbk');
      expect(needsUtf8Bom('/test/SCRIPT.PS1')).toBe(true);
    });

    it('should return false for .ps1 files on Windows with UTF-8 code page', () => {
      onHost('win32', 'utf-8');
      expect(needsUtf8Bom('/test/script.ps1')).toBe(false);
    });

    it('should return false for .ps1 files on non-Windows', () => {
      onHost('darwin');
      expect(needsUtf8Bom('/test/script.ps1')).toBe(false);
    });

    it('should return false for non-.ps1 files on Windows with non-UTF-8 code page', () => {
      onHost('win32', 'gbk');
      expect(needsUtf8Bom('/test/script.sh')).toBe(false);
      expect(needsUtf8Bom('/test/file.txt')).toBe(false);
      expect(needsUtf8Bom('/test/script.bat')).toBe(false);
    });

    it('should cache the platform/encoding check across calls', () => {
      onHost('win32', 'gbk');

      needsUtf8Bom('/test/script.ps1');
      needsUtf8Bom('/test/other.ps1');

      // getSystemEncoding should only be called once due to caching
      expect(mockGetSystemEncoding).toHaveBeenCalledTimes(1);
    });

    it('should treat null system encoding as non-UTF-8', () => {
      onHost('win32', null);
      expect(needsUtf8Bom('/test/script.ps1')).toBe(true);
    });
  });

  describe('detectLineEnding', () => {
    it.each([
      ['should detect CRLF line endings', 'line1\r\nline2\r\n', 'crlf'],
      ['should detect LF line endings', 'line1\nline2\n', 'lf'],
      [
        'should return lf for content with no line endings',
        'single line',
        'lf',
      ],
      ['should return lf for empty content', '', 'lf'],
      [
        'should detect CRLF even in mixed content',
        'line1\r\nline2\nline3',
        'crlf',
      ],
    ])('%s', (_title, content, expected) => {
      expect(detectLineEnding(content)).toBe(expected);
    });
  });

  describe('ensureCrlfLineEndings', () => {
    it.each([
      ['should convert LF to CRLF', 'line1\nline2\n', 'line1\r\nline2\r\n'],
      [
        'should not double-convert existing CRLF',
        'line1\r\nline2\r\n',
        'line1\r\nline2\r\n',
      ],
      [
        'should handle mixed line endings',
        'line1\r\nline2\nline3\r\n',
        'line1\r\nline2\r\nline3\r\n',
      ],
      [
        'should handle content with no line endings',
        'single line',
        'single line',
      ],
    ])('%s', (_title, content, expected) => {
      expect(ensureCrlfLineEndings(content)).toBe(expected);
    });
  });

  describe('writeTextFile with lineEnding preservation', () => {
    it('should convert LF to CRLF when lineEnding is crlf', async () => {
      await expectWrite(
        '/test/file.txt',
        'line1\nline2\n',
        'line1\r\nline2\r\n',
        {
          lineEnding: 'crlf',
        },
      );
    });

    it('should not convert line endings when lineEnding is lf', async () => {
      await expectWrite('/test/file.txt', 'line1\nline2\n', 'line1\nline2\n', {
        lineEnding: 'lf',
      });
    });

    it('should not convert line endings when lineEnding is not specified', async () => {
      await expectWrite('/test/file.txt', 'line1\nline2\n', 'line1\nline2\n');
    });

    it('should preserve CRLF for non-bat files on non-Windows when lineEnding is crlf', async () => {
      onHost('linux');
      await expectWrite(
        '/test/file.cs',
        'using System;\nclass Foo {}\n',
        'using System;\r\nclass Foo {}\r\n',
        { lineEnding: 'crlf' },
      );
    });
  });

  describe('readTextFile with lineEnding detection', () => {
    it('should detect CRLF line ending in file content', async () => {
      mockRead('line1\r\nline2\r\n', { originalLineCount: 3 });
      const result = await fileSystem.readTextFile({ path: '/test/file.txt' });
      expect(result._meta?.lineEnding).toBe('crlf');
    });

    it('should detect LF line ending in file content', async () => {
      mockRead('line1\nline2\n', { originalLineCount: 3 });
      const result = await fileSystem.readTextFile({ path: '/test/file.txt' });
      expect(result._meta?.lineEnding).toBe('lf');
    });
  });
});
