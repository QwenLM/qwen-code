/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { StandardFileSystemService } from './fileSystemService.js';

vi.mock('fs/promises');

vi.mock('../utils/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fileUtils.js')>();
  return {
    ...actual,
    readFileWithEncoding: vi.fn(),
    readFileWithEncodingInfo: vi.fn(),
  };
});

import {
  readFileWithEncoding,
  readFileWithEncodingInfo,
} from '../utils/fileUtils.js';

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
    it('should read file content using readFileWithEncoding', async () => {
      const testContent = 'Hello, World!';
      vi.mocked(readFileWithEncoding).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt');

      expect(readFileWithEncoding).toHaveBeenCalledWith('/test/file.txt');
      expect(result).toBe(testContent);
    });

    it('should propagate readFileWithEncoding errors', async () => {
      const error = new Error('ENOENT: File not found');
      vi.mocked(readFileWithEncoding).mockRejectedValue(error);

      await expect(fileSystem.readTextFile('/test/file.txt')).rejects.toThrow(
        'ENOENT: File not found',
      );
    });
  });

  describe('readTextFileWithInfo', () => {
    it('should return content, encoding, and bom via readFileWithEncodingInfo', async () => {
      const mockResult = { content: 'Hello', encoding: 'utf-8', bom: false };
      vi.mocked(readFileWithEncodingInfo).mockResolvedValue(mockResult);

      const result = await fileSystem.readTextFileWithInfo('/test/file.txt');

      expect(readFileWithEncodingInfo).toHaveBeenCalledWith('/test/file.txt');
      expect(result).toEqual(mockResult);
    });

    it('should return non-UTF-8 encoding info for GBK file', async () => {
      const mockResult = {
        content: '你好世界',
        encoding: 'gb18030',
        bom: false,
      };
      vi.mocked(readFileWithEncodingInfo).mockResolvedValue(mockResult);

      const result = await fileSystem.readTextFileWithInfo('/test/gbk.txt');

      expect(result.encoding).toBe('gb18030');
      expect(result.bom).toBe(false);
      expect(result.content).toBe('你好世界');
    });

    it('should propagate readFileWithEncodingInfo errors', async () => {
      const error = new Error('ENOENT: File not found');
      vi.mocked(readFileWithEncodingInfo).mockRejectedValue(error);

      await expect(
        fileSystem.readTextFileWithInfo('/test/file.txt'),
      ).rejects.toThrow('ENOENT: File not found');
    });
  });

  describe('writeTextFile', () => {
    it('should write file content using fs', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile('/test/file.txt', 'Hello, World!');

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/file.txt',
        'Hello, World!',
        'utf-8',
      );
    });

    it('should write file with BOM when bom option is true', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile('/test/file.txt', 'Hello, World!', {
        bom: true,
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

      await fileSystem.writeTextFile('/test/file.txt', 'Hello, World!', {
        bom: false,
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
      await fileSystem.writeTextFile('/test/file.txt', contentWithBOM, {
        bom: true,
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

      await fileSystem.writeTextFile('/test/file.txt', '你好世界', {
        encoding: 'gbk',
      });

      // Verify that fs.writeFile was called with a Buffer (iconv-encoded)
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[0]).toBe('/test/file.txt');
      expect(writeCall[1]).toBeInstanceOf(Buffer);
    });

    it('should write file as UTF-8 when encoding is utf-8', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile('/test/file.txt', 'Hello', {
        encoding: 'utf-8',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/file.txt',
        'Hello',
        'utf-8',
      );
    });

    it('should preserve UTF-16LE BOM when writing back a UTF-16LE file', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile('/test/file.txt', 'Hello', {
        encoding: 'utf-16le',
        bom: true,
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

      await fileSystem.writeTextFile('/test/file.txt', 'Hello', {
        encoding: 'utf-16le',
        bom: false,
      });

      // No BOM prepended — raw iconv-encoded buffer written directly
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      expect(writeCall[0]).toBe('/test/file.txt');
      expect(writeCall[1]).toBeInstanceOf(Buffer);
      const buf = writeCall[1] as Buffer;
      // First two bytes should NOT be FF FE (the UTF-16LE BOM)
      expect(!(buf[0] === 0xff && buf[1] === 0xfe)).toBe(true);
    });
  });

  describe('detectFileBOM', () => {
    it('should return true for file with UTF-8 BOM', async () => {
      // Create a buffer with BOM
      const bomBuffer = Buffer.from([0xef, 0xbb, 0xbf]);

      // Mock fs.open to return a file descriptor that fills buffer with BOM
      vi.mocked(fs.open).mockImplementation(
        async () =>
          ({
            read: async (buffer: Buffer, offset: number) => {
              // Copy BOM bytes to the buffer
              bomBuffer.copy(buffer, offset);
              return { bytesRead: 3 };
            },
            close: async () => {},
          }) as unknown as fs.FileHandle,
      );

      const result = await fileSystem.detectFileBOM('/test/file.txt');
      expect(result).toBe(true);
    });

    it('should return false for file without BOM', async () => {
      // Mock file without BOM (starts with plain text)
      vi.mocked(fs.open).mockImplementation(
        async () =>
          ({
            read: async (buffer: Buffer, offset: number) => {
              // Copy plain text bytes ("// ")
              const plainText = Buffer.from([0x2f, 0x2f, 0x20]);
              plainText.copy(buffer, offset);
              return { bytesRead: 3 };
            },
            close: async () => {},
          }) as unknown as fs.FileHandle,
      );

      const result = await fileSystem.detectFileBOM('/test/file.txt');
      expect(result).toBe(false);
    });

    it('should return false for non-existent file', async () => {
      vi.mocked(fs.open).mockRejectedValue(new Error('ENOENT'));

      const result = await fileSystem.detectFileBOM('/test/nonexistent.txt');
      expect(result).toBe(false);
    });

    it('should return false for empty file', async () => {
      vi.mocked(fs.open).mockImplementation(
        async () =>
          ({
            read: async () => ({ bytesRead: 0 }),
            close: async () => {},
          }) as unknown as fs.FileHandle,
      );

      const result = await fileSystem.detectFileBOM('/test/empty.txt');
      expect(result).toBe(false);
    });
  });
});
