/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { FileSystemService } from '@qwen-code/qwen-code-core';
import { AcpFileSystemService } from './filesystem.js';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';

const RESOURCE_NOT_FOUND_CODE = -32002;
const INTERNAL_ERROR_CODE = -32603;

const createFallback = (): FileSystemService => ({
  readTextFile: vi.fn().mockResolvedValue({
    content: '',
    _meta: { bom: false, encoding: 'utf-8' },
  }),
  writeTextFile: vi.fn().mockResolvedValue({ _meta: undefined }),
  findFiles: vi.fn().mockReturnValue([]),
});

describe('AcpFileSystemService', () => {
  describe('readTextFile', () => {
    it('reads through ACP and returns response', async () => {
      const mockResponse = {
        content: 'hello',
        _meta: { bom: false, encoding: 'utf-8' },
      };
      const client = {
        readTextFile: vi.fn().mockResolvedValue(mockResponse),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-1',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const result = await svc.readTextFile({ path: '/some/file.txt' });

      expect(result).toEqual(mockResponse);
      expect(client.readTextFile).toHaveBeenCalledWith({
        path: '/some/file.txt',
        sessionId: 'session-1',
      });
    });

    it('converts RESOURCE_NOT_FOUND error to ENOENT', async () => {
      const resourceNotFoundError = {
        code: RESOURCE_NOT_FOUND_CODE,
        message: 'File not found',
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(resourceNotFoundError),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-1',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      await expect(
        svc.readTextFile({ path: '/some/file.txt' }),
      ).rejects.toMatchObject({
        code: 'ENOENT',
        errno: -2,
        path: '/some/file.txt',
      });
    });

    it('re-throws other errors unchanged', async () => {
      const otherError = {
        code: INTERNAL_ERROR_CODE,
        message: 'Internal error',
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(otherError),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-2',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      await expect(
        svc.readTextFile({ path: '/some/file.txt' }),
      ).rejects.toMatchObject({
        code: INTERNAL_ERROR_CODE,
        message: 'Internal error',
      });
    });

    it('uses fallback when readTextFile capability is disabled', async () => {
      const client = {
        readTextFile: vi.fn(),
      } as unknown as AgentSideConnection;

      const fallback = createFallback();
      const fallbackResponse = {
        content: 'fallback content',
        _meta: { bom: false, encoding: 'utf-8' },
      };
      (fallback.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        fallbackResponse,
      );

      const svc = new AcpFileSystemService(
        client,
        'session-3',
        { readTextFile: false, writeTextFile: true },
        fallback,
      );

      const result = await svc.readTextFile({ path: '/some/file.txt' });

      expect(result).toEqual(fallbackResponse);
      expect(fallback.readTextFile).toHaveBeenCalledWith({
        path: '/some/file.txt',
      });
      expect(client.readTextFile).not.toHaveBeenCalled();
    });
  });
});
