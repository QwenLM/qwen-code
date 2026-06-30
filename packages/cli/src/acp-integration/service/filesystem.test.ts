/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: vi.fn(() => mockDebugLogger),
  };
});

vi.mock('node:fs/promises', { spy: true });

import type { FileSystemService } from '@qwen-code/qwen-code-core';
import { AcpFileSystemService } from './filesystem.js';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { promises as fs } from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
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
  beforeEach(() => {
    mockDebugLogger.debug.mockClear();
    mockDebugLogger.warn.mockClear();
    vi.mocked(fsRealpath).mockClear();
  });

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

    it('preserves message for other read errors', async () => {
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
        message: 'Internal error',
      });
    });

    it('normalizes plain object ACP errors without exposing numeric codes as Node error codes', async () => {
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
        cause: otherError,
        message: 'Internal error',
      });
      expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(false);
      expect(String(err)).toContain('Internal error');
      expect(String(err)).not.toContain('[object Object]');
    });

    it('does not copy unsafe properties from plain object ACP errors', async () => {
      const otherError: Record<string, unknown> = {
        code: 'ABORT_ERR',
        message: 'Internal error',
        stack: 'Remote ACP stack',
        name: 'AbortError',
        constructor: 'RemoteConstructor',
        toString: 'not callable',
        valueOf: 'not callable',
      };
      Object.defineProperty(otherError, '__proto__', {
        value: { remotePrototype: true },
        enumerable: true,
      });
      const client = {
        readTextFile: vi.fn().mockRejectedValue(otherError),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-2b-stack',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const err = await svc
        .readTextFile({ path: '/some/file.txt' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('Error');
      expect((err as Error).stack).toContain('Internal error');
      expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(err, 'constructor')).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(err, 'toString')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(err, 'valueOf')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(err, '__proto__')).toBe(
        false,
      );
      expect(
        (err as Record<string, unknown>)['remotePrototype'],
      ).toBeUndefined();
      expect(String(err)).toContain('Internal error');
    });

    it('does not copy array entries onto normalized ACP errors', async () => {
      const client = {
        readTextFile: vi.fn().mockRejectedValue(['Internal error']),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-2b-array',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const err = await svc
        .readTextFile({ path: '/some/file.txt' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(Object.prototype.hasOwnProperty.call(err, '0')).toBe(false);
    });

    it('includes cause details from plain object ACP errors', async () => {
      const otherError = {
        code: INTERNAL_ERROR_CODE,
        message: 'fetch failed',
        cause: { code: 'ECONNREFUSED' },
      };
      const client = {
        readTextFile: vi.fn().mockRejectedValue(otherError),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-2b-cause',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      const err = await svc
        .readTextFile({ path: '/some/file.txt' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({
        cause: otherError,
        message: 'fetch failed (cause: ECONNREFUSED)',
      });
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
        expect(fallback.readTextFile).toHaveBeenCalledWith({
          path: await fs.realpath(filePath),
        });
      });
    });

    it.skipIf(process.platform === 'win32')(
      'uses the resolved real path for local read fallback',
      async () => {
        await withTempRoot(async (tempRoot) => {
          const localRoot = path.join(tempRoot, 'skills');
          const realFilePath = path.join(localRoot, 'instructions.md');
          const symlinkPath = path.join(localRoot, 'instructions-link.md');
          await fs.mkdir(localRoot, { recursive: true });
          await fs.writeFile(realFilePath, 'instructions', 'utf8');
          await fs.symlink(realFilePath, symlinkPath);

          const pathOutsideWorkspaceError =
            createLocalReadFallbackError(symlinkPath);
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
            'session-2c-real-fallback-path',
            { readTextFile: true, writeTextFile: true },
            fallback,
            { localReadRoots: [localRoot] },
          );

          await expect(
            svc.readTextFile({ path: symlinkPath }),
          ).resolves.toEqual({
            content: 'instructions',
            _meta: { bom: false, encoding: 'utf-8' },
          });
          expect(fallback.readTextFile).toHaveBeenCalledWith({
            path: await fs.realpath(realFilePath),
          });
        });
      },
    );

    it('does not use top-level errorKind fields for local read fallback', async () => {
      await withTempRoot(async (tempRoot) => {
        const localRoot = path.join(tempRoot, 'skills');
        const filePath = path.join(localRoot, 'instructions.md');
        await fs.mkdir(localRoot, { recursive: true });
        await fs.writeFile(filePath, 'instructions', 'utf8');

        const topLevelErrorKindError = {
          code: INTERNAL_ERROR_CODE,
          message: `top-level errorKind only: ${filePath}`,
          errorKind: 'path_outside_workspace',
        };
        const client = {
          readTextFile: vi.fn().mockRejectedValue(topLevelErrorKindError),
        } as unknown as AgentSideConnection;
        const fallback = createFallback();

        const svc = new AcpFileSystemService(
          client,
          'session-2c-top-level-kind',
          { readTextFile: true, writeTextFile: true },
          fallback,
          { localReadRoots: [localRoot] },
        );

        const err = await svc
          .readTextFile({ path: filePath })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err).toMatchObject({
          cause: topLevelErrorKindError,
          message: `top-level errorKind only: ${filePath}`,
        });
        expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(false);
        expect(fallback.readTextFile).not.toHaveBeenCalled();
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

          const err = await svc
            .readTextFile({ path: symlinkPath })
            .catch((e: unknown) => e);

          expect(err).toBeInstanceOf(Error);
          expect(err).toMatchObject({
            cause: pathOutsideWorkspaceError,
            message: `path escapes workspace: ${symlinkPath}`,
          });
          expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(false);
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
            path: await fs.realpath(filePath),
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
        expect(fallback.readTextFile).toHaveBeenCalledWith({
          path: await fs.realpath(filePath),
        });
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
        const fallbackError = new Error('local read failed');
        (fallback.readTextFile as ReturnType<typeof vi.fn>).mockRejectedValue(
          fallbackError,
        );

        const svc = new AcpFileSystemService(
          client,
          'session-2d-fallback-fail',
          { readTextFile: true, writeTextFile: true },
          fallback,
          { localReadRoots: [localRoot] },
        );

        const err = await svc
          .readTextFile({ path: filePath })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err).toMatchObject({
          message: `Local fallback read failed for ${filePath}: local read failed (original ACP error: path escapes workspace: ${filePath})`,
          cause: {
            fallbackError,
            acpError: pathOutsideWorkspaceError,
          },
        });
      });
    });

    it('falls back to local reads for missing files under allowed local roots', async () => {
      await withTempRoot(async (tempRoot) => {
        const localRoot = path.join(tempRoot, 'skills');
        const filePath = path.join(localRoot, 'missing.md');
        await fs.mkdir(localRoot, { recursive: true });

        const pathOutsideWorkspaceError =
          createLocalReadFallbackError(filePath);
        const client = {
          readTextFile: vi.fn().mockRejectedValue(pathOutsideWorkspaceError),
        } as unknown as AgentSideConnection;
        const fallback = createFallback();
        const missingFileError = Object.assign(
          new Error(`File not found: ${filePath}`),
          {
            code: 'ENOENT',
            errno: -2,
            path: filePath,
          },
        );
        (fallback.readTextFile as ReturnType<typeof vi.fn>).mockRejectedValue(
          missingFileError,
        );

        const svc = new AcpFileSystemService(
          client,
          'session-2d-missing-local-file',
          { readTextFile: true, writeTextFile: true },
          fallback,
          { localReadRoots: [localRoot] },
        );

        await expect(svc.readTextFile({ path: filePath })).rejects.toBe(
          missingFileError,
        );
        expect(fallback.readTextFile).toHaveBeenCalledWith({
          path: filePath,
        });
      });
    });

    it('does not fall back to local reads outside configured roots', async () => {
      await withTempRoot(async (tempRoot) => {
        const localRoot = path.join(tempRoot, 'allowed');
        const outsideRoot = path.join(tempRoot, 'outside');
        const filePath = path.join(outsideRoot, 'outside-local-root.md');
        await fs.mkdir(localRoot, { recursive: true });
        await fs.mkdir(outsideRoot, { recursive: true });
        await fs.writeFile(filePath, 'outside local root', 'utf8');

        const pathOutsideWorkspaceError =
          createLocalReadFallbackError(filePath);
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

        const err = await svc
          .readTextFile({ path: filePath })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err).toMatchObject({
          cause: pathOutsideWorkspaceError,
          message: `path escapes workspace: ${filePath}`,
        });
        expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(false);
        expect(fallback.readTextFile).not.toHaveBeenCalled();
      });
    });

    it('logs when a local read fallback is eligible but skipped', async () => {
      await withTempRoot(async (tempRoot) => {
        const localRoot = path.join(tempRoot, 'allowed');
        const outsideRoot = path.join(tempRoot, 'outside');
        const filePath = path.join(outsideRoot, 'outside-local-root.md');
        await fs.mkdir(localRoot, { recursive: true });
        await fs.mkdir(outsideRoot, { recursive: true });
        await fs.writeFile(filePath, 'outside local root', 'utf8');

        const pathOutsideWorkspaceError =
          createLocalReadFallbackError(filePath);
        const client = {
          readTextFile: vi.fn().mockRejectedValue(pathOutsideWorkspaceError),
        } as unknown as AgentSideConnection;

        const svc = new AcpFileSystemService(
          client,
          'session-2e-skipped-log',
          { readTextFile: true, writeTextFile: true },
          createFallback(),
          { localReadRoots: [localRoot] },
        );

        await svc.readTextFile({ path: filePath }).catch(() => undefined);

        expect(mockDebugLogger.debug).toHaveBeenCalledWith(
          'Local read fallback skipped - no matching root',
          {
            path: filePath,
            errorKind: 'path_outside_workspace',
          },
        );
      });
    });

    it('resolves configured local read roots only once across fallback reads', async () => {
      await withTempRoot(async (tempRoot) => {
        const localRoot = path.join(tempRoot, 'skills');
        const firstFilePath = path.join(localRoot, 'first.md');
        const secondFilePath = path.join(localRoot, 'second.md');
        await fs.mkdir(localRoot, { recursive: true });
        await fs.writeFile(firstFilePath, 'first', 'utf8');
        await fs.writeFile(secondFilePath, 'second', 'utf8');

        const client = {
          readTextFile: vi
            .fn()
            .mockRejectedValueOnce(createLocalReadFallbackError(firstFilePath))
            .mockRejectedValueOnce(
              createLocalReadFallbackError(secondFilePath),
            ),
        } as unknown as AgentSideConnection;
        const fallback = createFallback();
        (fallback.readTextFile as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            content: 'first',
            _meta: { bom: false, encoding: 'utf-8' },
          })
          .mockResolvedValueOnce({
            content: 'second',
            _meta: { bom: false, encoding: 'utf-8' },
          });

        const svc = new AcpFileSystemService(
          client,
          'session-2e-root-cache',
          { readTextFile: true, writeTextFile: true },
          fallback,
          { localReadRoots: [localRoot] },
        );

        await svc.readTextFile({ path: firstFilePath });
        await svc.readTextFile({ path: secondFilePath });

        const resolvedLocalRoot = path.resolve(localRoot);
        const localRootRealpathCalls = vi
          .mocked(fsRealpath)
          .mock.calls.filter(([value]) => value === resolvedLocalRoot);
        expect(localRootRealpathCalls).toHaveLength(1);
      });
    });

    it('ignores empty configured local read roots', async () => {
      await withTempRoot(async (tempRoot) => {
        const filePath = path.join(tempRoot, 'outside-workspace.md');
        await fs.writeFile(filePath, 'outside workspace', 'utf8');

        const pathOutsideWorkspaceError =
          createLocalReadFallbackError(filePath);
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

        const err = await svc
          .readTextFile({ path: filePath })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err).toMatchObject({
          cause: pathOutsideWorkspaceError,
          message: `path escapes workspace: ${filePath}`,
        });
        expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(false);
        expect(fallback.readTextFile).not.toHaveBeenCalled();
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

    it('normalizes plain object ACP write errors without exposing numeric codes as Node error codes', async () => {
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
        cause: writeError,
        message: 'Write failed',
      });
      expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(false);
      expect(String(err)).toContain('Write failed');
      expect(String(err)).not.toContain('[object Object]');
    });

    it('converts RESOURCE_NOT_FOUND write errors to ENOENT', async () => {
      const resourceNotFoundError = {
        code: RESOURCE_NOT_FOUND_CODE,
        message: 'File not found',
      };
      const client = {
        writeTextFile: vi.fn().mockRejectedValue(resourceNotFoundError),
      } as unknown as AgentSideConnection;

      const svc = new AcpFileSystemService(
        client,
        'session-9',
        { readTextFile: true, writeTextFile: true },
        createFallback(),
      );

      await expect(
        svc.writeTextFile({
          path: '/some/file.txt',
          content: 'hello',
        }),
      ).rejects.toMatchObject({
        code: 'ENOENT',
        errno: -2,
        path: '/some/file.txt',
      });
    });
  });
});
