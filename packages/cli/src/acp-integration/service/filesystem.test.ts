/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { FileSystemService } from '@qwen-code/qwen-code-core';
import { AcpFileSystemService } from './filesystem.js';
import { ACP_ERROR_CODES } from '../errorCodes.js';

const createFallback = (): FileSystemService => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  detectFileBOM: vi.fn().mockResolvedValue(false),
  findFiles: vi.fn().mockReturnValue([]),
});

describe('AcpFileSystemService', () => {
  describe('detectFileBOM', () => {
    it('detects BOM through ACP client when content starts with U+FEFF', async () => {
      const client = {
        readTextFile: vi
          .fn()
          .mockResolvedValue({ content: '\ufeff// BOM file' }),
      } as unknown as import('../acp.js').Client;

      const svc = new AcpFileSystemService(
        client,
        'session-1',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const result = await svc.detectFileBOM('/test/file.txt');
      expect(result).toBe(true);
      expect(client.readTextFile).toHaveBeenCalledWith({
        path: '/test/file.txt',
        sessionId: 'session-1',
        line: null,
        limit: 1,
      });
    });

    it('detects no BOM through ACP client when content does not start with U+FEFF', async () => {
      const client = {
        readTextFile: vi.fn().mockResolvedValue({ content: '// No BOM file' }),
      } as unknown as import('../acp.js').Client;

      const svc = new AcpFileSystemService(
        client,
        'session-2',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const result = await svc.detectFileBOM('/test/file.txt');
      expect(result).toBe(false);
    });

    it('falls back to local filesystem when ACP client fails', async () => {
      const client = {
        readTextFile: vi.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as import('../acp.js').Client;

      const fallback = createFallback();
      (fallback.detectFileBOM as ReturnType<typeof vi.fn>).mockResolvedValue(
        true,
      );

      const svc = new AcpFileSystemService(
        client,
        'session-3',
        { readTextFile: true, writeTextFile: true },
        fallback,
      );

      const result = await svc.detectFileBOM('/test/file.txt');
      expect(result).toBe(true);
      expect(fallback.detectFileBOM).toHaveBeenCalledWith('/test/file.txt');
    });

    it('falls back to local filesystem when readTextFile capability is disabled', async () => {
      const client = {
        readTextFile: vi.fn(),
      } as unknown as import('../acp.js').Client;

      const fallback = createFallback();
      (fallback.detectFileBOM as ReturnType<typeof vi.fn>).mockResolvedValue(
        false,
      );

      const svc = new AcpFileSystemService(
        client,
        'session-4',
        { readTextFile: false, writeTextFile: true },
        fallback,
      );

      const result = await svc.detectFileBOM('/test/file.txt');
      expect(result).toBe(false);
      expect(fallback.detectFileBOM).toHaveBeenCalledWith('/test/file.txt');
      expect(client.readTextFile).not.toHaveBeenCalled();
    });
  });

  describe('readTextFile ENOENT handling', () => {
    it('converts RESOURCE_NOT_FOUND error to ENOENT', async () => {
      const resourceNotFoundError = {
        code: ACP_ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'File not found',
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(resourceNotFoundError),
      } as unknown as import('../acp.js').Client;

      const svc = new AcpFileSystemService(
        client,
        'session-1',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      await expect(svc.readTextFile('/some/file.txt')).rejects.toMatchObject({
        code: 'ENOENT',
        errno: -2,
        path: '/some/file.txt',
      });
    });

    it('re-throws other errors unchanged', async () => {
      const otherError = {
        code: ACP_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(otherError),
      } as unknown as import('../acp.js').Client;

      const svc = new AcpFileSystemService(
        client,
        'session-2',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      await expect(svc.readTextFile('/some/file.txt')).rejects.toMatchObject({
        code: ACP_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      });
    });

    it('uses fallback when readTextFile capability is disabled', async () => {
      const client = {
        readTextFile: vi.fn(),
      } as unknown as import('../acp.js').Client;

      const fallback = createFallback();
      (fallback.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        'fallback content',
      );

      const svc = new AcpFileSystemService(
        client,
        'session-3',
        { readTextFile: false, writeTextFile: true },
        fallback,
      );

      const result = await svc.readTextFile('/some/file.txt');

      expect(result).toBe('fallback content');
      expect(fallback.readTextFile).toHaveBeenCalledWith('/some/file.txt');
      expect(client.readTextFile).not.toHaveBeenCalled();
    });
  });
});
