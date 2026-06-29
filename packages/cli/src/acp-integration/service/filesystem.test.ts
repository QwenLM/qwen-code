/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { FileSystemService } from '@qwen-code/qwen-code-core';
import { AcpFileSystemService } from './filesystem.js';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import os from 'node:os';
import path from 'node:path';

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

    it('preserves code and message for other read errors', async () => {
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

    it('normalizes plain object ACP errors to Error instances with the original message', async () => {
      const otherError = {
        code: INTERNAL_ERROR_CODE,
        message: 'Internal error',
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(otherError),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-2b',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const err = await svc
        .readTextFile({ path: '/some/file.txt' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({
        code: INTERNAL_ERROR_CODE,
        message: 'Internal error',
      });
      expect(String(err)).toContain('Internal error');
      expect(String(err)).not.toContain('[object Object]');
    });

    it('falls back to local reads for allowed local roots when ACP rejects them as outside the workspace', async () => {
      const skillRoot = path.join(os.homedir(), '.qwen', 'skills');
      const filePath = path.join(
        skillRoot,
        'dataworks-di-data-processor',
        'instructions',
        'interaction_norms.md',
      );
      const pathOutsideWorkspaceError = {
        code: INTERNAL_ERROR_CODE,
        message: `path escapes workspace: ${filePath}`,
        data: {
          errorKind: 'path_outside_workspace',
          status: 400,
        },
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(pathOutsideWorkspaceError),
      } as unknown as AgentSideConnection;
      const fallback = createFallback();
      (fallback.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: 'skill instructions',
        _meta: { bom: false, encoding: 'utf-8' },
      });

      const svc = new AcpFileSystemService(
        client,
        'session-2c',
        { readTextFile: true, writeTextFile: true },
        fallback,
        { localReadRoots: [skillRoot] },
      );

      await expect(svc.readTextFile({ path: filePath })).resolves.toEqual({
        content: 'skill instructions',
        _meta: { bom: false, encoding: 'utf-8' },
      });
      expect(fallback.readTextFile).toHaveBeenCalledWith({ path: filePath });
    });

    it('does not fall back to local reads outside configured roots', async () => {
      const localRoot = path.join(os.tmpdir(), 'acp-local-read-root');
      const filePath = path.join(os.tmpdir(), 'outside-local-root.md');
      const pathOutsideWorkspaceError = {
        code: INTERNAL_ERROR_CODE,
        message: `path escapes workspace: ${filePath}`,
        data: {
          errorKind: 'path_outside_workspace',
          status: 400,
        },
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(pathOutsideWorkspaceError),
      } as unknown as AgentSideConnection;
      const fallback = createFallback();

      const svc = new AcpFileSystemService(
        client,
        'session-2e',
        { readTextFile: true, writeTextFile: true },
        fallback,
        { localReadRoots: [localRoot] },
      );

      await expect(svc.readTextFile({ path: filePath })).rejects.toMatchObject({
        code: INTERNAL_ERROR_CODE,
        message: `path escapes workspace: ${filePath}`,
      });
      expect(fallback.readTextFile).not.toHaveBeenCalled();
    });

    it('ignores empty configured local read roots', async () => {
      const filePath = path.join(process.cwd(), 'outside-workspace.md');
      const pathOutsideWorkspaceError = {
        code: INTERNAL_ERROR_CODE,
        message: `path escapes workspace: ${filePath}`,
        data: {
          errorKind: 'path_outside_workspace',
          status: 400,
        },
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(pathOutsideWorkspaceError),
      } as unknown as AgentSideConnection;
      const fallback = createFallback();

      const svc = new AcpFileSystemService(
        client,
        'session-2f',
        { readTextFile: true, writeTextFile: true },
        fallback,
        { localReadRoots: [''] },
      );

      await expect(svc.readTextFile({ path: filePath })).rejects.toMatchObject({
        code: INTERNAL_ERROR_CODE,
        message: `path escapes workspace: ${filePath}`,
      });
      expect(fallback.readTextFile).not.toHaveBeenCalled();
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

  describe('writeTextFile', () => {
    it('writes through ACP with the session id', async () => {
      const client = {
        writeTextFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-4',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const result = await svc.writeTextFile({
        path: '/some/file.txt',
        content: 'hello',
      });

      expect(result).toEqual({ _meta: undefined });
      expect(client.writeTextFile).toHaveBeenCalledWith({
        path: '/some/file.txt',
        content: 'hello',
        sessionId: 'session-4',
      });
    });

    it('preserves a UTF-8 BOM without duplicating an existing marker', async () => {
      const client = {
        writeTextFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-5',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      await svc.writeTextFile({
        path: '/some/file.txt',
        content: '\uFEFFHello',
        _meta: { bom: true },
      });

      expect(client.writeTextFile).toHaveBeenCalledWith({
        path: '/some/file.txt',
        content: '\uFEFFHello',
        _meta: { bom: true },
        sessionId: 'session-5',
      });
    });

    it('adds a UTF-8 BOM marker when requested and missing', async () => {
      const client = {
        writeTextFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-6',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      await svc.writeTextFile({
        path: '/some/file.txt',
        content: 'Hello',
        _meta: { bom: true },
      });

      expect(client.writeTextFile).toHaveBeenCalledWith({
        path: '/some/file.txt',
        content: '\uFEFFHello',
        _meta: { bom: true },
        sessionId: 'session-6',
      });
    });

    it('uses fallback when writeTextFile capability is disabled', async () => {
      const client = {
        writeTextFile: vi.fn(),
      } as unknown as AgentSideConnection;
      const fallback = createFallback();
      (fallback.writeTextFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        _meta: { bom: true },
      });

      const svc = new AcpFileSystemService(
        client,
        'session-7',
        { readTextFile: true, writeTextFile: false },
        fallback,
      );

      const result = await svc.writeTextFile({
        path: '/some/file.txt',
        content: '\uFEFFHello',
        _meta: { bom: true },
      });

      expect(result).toEqual({ _meta: { bom: true } });
      expect(fallback.writeTextFile).toHaveBeenCalledWith({
        path: '/some/file.txt',
        content: '\uFEFFHello',
        _meta: { bom: true },
      });
      expect(client.writeTextFile).not.toHaveBeenCalled();
    });
  });
});
