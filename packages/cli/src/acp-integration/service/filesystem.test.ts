/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { FileSystemService } from '@qwen-code/qwen-code-core';
import { AcpFileSystemService } from './filesystem.js';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RESOURCE_NOT_FOUND_CODE = -32002;
const INTERNAL_ERROR_CODE = -32603;
type LocalReadFallbackErrorKind = 'path_outside_workspace' | 'symlink_escape';

async function withTempRoot<T>(
  callback: (tempRoot: string) => Promise<T>,
): Promise<T> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-local-read-'));

  try {
    return await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function createLocalReadFallbackError(
  filePath: string,
  errorKind: LocalReadFallbackErrorKind = 'path_outside_workspace',
) {
  const reason =
    errorKind === 'symlink_escape'
      ? 'path escapes workspace via symlink'
      : 'path escapes workspace';

  return {
    code: INTERNAL_ERROR_CODE,
    message: `${reason}: ${filePath}`,
    data: {
      errorKind,
      status: 400,
    },
  };
}

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
      await withTempRoot(async (tempRoot) => {
        const skillRoot = path.join(tempRoot, 'skills');
        const filePath = path.join(
          skillRoot,
          'dataworks-di-data-processor',
          'instructions',
          'interaction_norms.md',
        );
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, 'skill instructions', 'utf8');

        const pathOutsideWorkspaceError =
          createLocalReadFallbackError(filePath);
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
    });

    it.skipIf(process.platform === 'win32')(
      'does not follow symlink paths that resolve outside configured local roots',
      async () => {
        await withTempRoot(async (tempRoot) => {
          const localRoot = path.join(tempRoot, 'allowed');
          const outsideRoot = path.join(tempRoot, 'outside');
          await fs.mkdir(localRoot, { recursive: true });
          await fs.mkdir(outsideRoot, { recursive: true });

          const outsideFile = path.join(outsideRoot, 'secret.md');
          const symlinkPath = path.join(localRoot, 'secret.md');
          await fs.writeFile(outsideFile, 'secret', 'utf8');
          await fs.symlink(outsideFile, symlinkPath);

          const pathOutsideWorkspaceError =
            createLocalReadFallbackError(symlinkPath);
          const client = {
            readTextFile: vi.fn().mockRejectedValue(pathOutsideWorkspaceError),
          } as unknown as AgentSideConnection;
          const fallback = createFallback();

          const svc = new AcpFileSystemService(
            client,
            'session-2d',
            { readTextFile: true, writeTextFile: true },
            fallback,
            { localReadRoots: [localRoot] },
          );

          await expect(
            svc.readTextFile({ path: symlinkPath }),
          ).rejects.toMatchObject({
            code: INTERNAL_ERROR_CODE,
            message: `path escapes workspace: ${symlinkPath}`,
          });
          expect(fallback.readTextFile).not.toHaveBeenCalled();
        });
      },
    );

    it.skipIf(process.platform === 'win32')(
      'allows local roots and files that resolve to the same real path tree',
      async () => {
        await withTempRoot(async (tempRoot) => {
          const realRoot = path.join(tempRoot, 'real-root');
          const rootAlias = path.join(tempRoot, 'root-alias');
          const filePath = path.join(realRoot, 'instructions.md');
          await fs.mkdir(realRoot, { recursive: true });
          await fs.writeFile(filePath, 'instructions', 'utf8');
          await fs.symlink(realRoot, rootAlias, 'dir');

          const pathOutsideWorkspaceError =
            createLocalReadFallbackError(filePath);
          const client = {
            readTextFile: vi.fn().mockRejectedValue(pathOutsideWorkspaceError),
          } as unknown as AgentSideConnection;
          const fallback = createFallback();
          (fallback.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
            {
              content: 'instructions',
              _meta: { bom: false, encoding: 'utf-8' },
            },
          );

          const svc = new AcpFileSystemService(
            client,
            'session-2d-realpath',
            { readTextFile: true, writeTextFile: true },
            fallback,
            { localReadRoots: [rootAlias] },
          );

          await expect(svc.readTextFile({ path: filePath })).resolves.toEqual({
            content: 'instructions',
            _meta: { bom: false, encoding: 'utf-8' },
          });
          expect(fallback.readTextFile).toHaveBeenCalledWith({
            path: filePath,
          });
        });
      },
    );

    it('falls back to local reads for allowed local roots when ACP rejects them as symlink escapes', async () => {
      await withTempRoot(async (tempRoot) => {
        const localRoot = path.join(tempRoot, 'skills');
        const filePath = path.join(localRoot, 'instructions.md');
        await fs.mkdir(localRoot, { recursive: true });
        await fs.writeFile(filePath, 'instructions', 'utf8');

        const symlinkEscapeError = createLocalReadFallbackError(
          filePath,
          'symlink_escape',
        );
        const client = {
          readTextFile: vi.fn().mockRejectedValue(symlinkEscapeError),
        } as unknown as AgentSideConnection;
        const fallback = createFallback();
        (fallback.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue({
          content: 'instructions',
          _meta: { bom: false, encoding: 'utf-8' },
        });

        const svc = new AcpFileSystemService(
          client,
          'session-2d-symlink',
          { readTextFile: true, writeTextFile: true },
          fallback,
          { localReadRoots: [localRoot] },
        );

        await expect(svc.readTextFile({ path: filePath })).resolves.toEqual({
          content: 'instructions',
          _meta: { bom: false, encoding: 'utf-8' },
        });
        expect(fallback.readTextFile).toHaveBeenCalledWith({ path: filePath });
      });
    });

    it('preserves the original ACP error when local read fallback fails', async () => {
      await withTempRoot(async (tempRoot) => {
        const localRoot = path.join(tempRoot, 'skills');
        const filePath = path.join(localRoot, 'instructions.md');
        await fs.mkdir(localRoot, { recursive: true });
        await fs.writeFile(filePath, 'instructions', 'utf8');

        const pathOutsideWorkspaceError =
          createLocalReadFallbackError(filePath);
        const client = {
          readTextFile: vi.fn().mockRejectedValue(pathOutsideWorkspaceError),
        } as unknown as AgentSideConnection;
        const fallback = createFallback();
        (fallback.readTextFile as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('local read failed'),
        );

        const svc = new AcpFileSystemService(
          client,
          'session-2d-fallback-fail',
          { readTextFile: true, writeTextFile: true },
          fallback,
          { localReadRoots: [localRoot] },
        );

        await expect(svc.readTextFile({ path: filePath })).rejects.toThrow(
          `Local fallback read failed for ${filePath}: local read failed (original ACP error: path escapes workspace: ${filePath})`,
        );
      });
    });

    it('does not fall back to local reads outside configured roots', async () => {
      const localRoot = path.join(os.tmpdir(), 'acp-local-read-root');
      const filePath = path.join(os.tmpdir(), 'outside-local-root.md');
      const pathOutsideWorkspaceError = createLocalReadFallbackError(filePath);
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
      const pathOutsideWorkspaceError = createLocalReadFallbackError(filePath);
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

    it('normalizes plain object ACP write errors to Error instances with the original message', async () => {
      const writeError = {
        code: INTERNAL_ERROR_CODE,
        message: 'Write failed',
      };
      const client = {
        writeTextFile: vi.fn().mockRejectedValue(writeError),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-8',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const err = await svc
        .writeTextFile({
          path: '/some/file.txt',
          content: 'hello',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({
        code: INTERNAL_ERROR_CODE,
        message: 'Write failed',
      });
      expect(String(err)).toContain('Write failed');
      expect(String(err)).not.toContain('[object Object]');
    });
  });
});
