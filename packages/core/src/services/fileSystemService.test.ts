/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { StandardFileSystemService } from './fileSystemService.js';

vi.mock('fs/promises');

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
    it('should read file content using fs', async () => {
      const testContent = 'Hello, World!';
      vi.mocked(fs.readFile).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt');

      expect(fs.readFile).toHaveBeenCalledWith('/test/file.txt', 'utf-8');
      expect(result).toBe(testContent);
    });

    it('should propagate fs.readFile errors', async () => {
      const error = new Error('ENOENT: File not found');
      vi.mocked(fs.readFile).mockRejectedValue(error);

      await expect(fileSystem.readTextFile('/test/file.txt')).rejects.toThrow(
        'ENOENT: File not found',
      );
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
