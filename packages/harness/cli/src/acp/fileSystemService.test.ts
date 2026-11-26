/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
} from 'vitest';
import { AcpFileSystemService } from './fileSystemService.js';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import {
  CONFIG_DIR,
  Storage,
  type FileSystemService,
} from '@qwen-code/core';
import os from 'node:os';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(() => '/home/user');
  return {
    ...actual,
    homedir,
    default: {
      ...actual,
      homedir,
    },
  };
});

describe('AcpFileSystemService', () => {
  let mockConnection: Mocked<AgentSideConnection>;
  let mockFallback: Mocked<FileSystemService>;
  let service: AcpFileSystemService;

  beforeEach(() => {
    mockConnection = {
      requestPermission: vi.fn(),
      sessionUpdate: vi.fn(),
      writeTextFile: vi.fn(),
      readTextFile: vi.fn(),
    } as unknown as Mocked<AgentSideConnection>;
    mockFallback = {
      readTextFile: vi.fn(),
      writeTextFile: vi.fn(),
    };
    vi.mocked(os.homedir).mockReturnValue('/home/user');
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(
      `/home/user/${CONFIG_DIR}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readTextFile', () => {
    it('routes files in a worktree entered after construction through the ACP connection', async () => {
      let runtimeRoot = '/path/to';
      service = new AcpFileSystemService(
        mockConnection,
        'session-1',
        { readTextFile: true, writeTextFile: true },
        mockFallback,
        () => runtimeRoot,
      );
      runtimeRoot = '/external/worktree';
      mockConnection.readTextFile.mockResolvedValue({ content: 'content' });

      await expect(
        service.readTextFile('/external/worktree/src/file.ts'),
      ).resolves.toBe('content');

      expect(mockConnection.readTextFile).toHaveBeenCalledWith({
        path: '/external/worktree/src/file.ts',
        sessionId: 'session-1',
      });
      expect(mockFallback.readTextFile).not.toHaveBeenCalled();
    });

    it('reads worktree files through the local fallback when the host lacks file capabilities', async () => {
      let runtimeRoot = '/path/to';
      mockFallback.readTextFile.mockResolvedValue('worktree content');
      service = new AcpFileSystemService(
        mockConnection,
        'session-1',
        { readTextFile: false, writeTextFile: false },
        mockFallback,
        () => runtimeRoot,
      );
      runtimeRoot = '/external/worktree';

      await expect(
        service.readTextFile('/external/worktree/src/file.ts'),
      ).resolves.toBe('worktree content');

      expect(mockFallback.readTextFile).toHaveBeenCalledWith(
        '/external/worktree/src/file.ts',
      );
      expect(mockConnection.readTextFile).not.toHaveBeenCalled();
    });

    it.each([
      {
        capability: true,
        path: '/path/to/file',
        desc: 'connection if capability exists and file is inside root',
        setup: () => {
          mockConnection.readTextFile.mockResolvedValue({ content: 'content' });
        },
        verify: () => {
          expect(mockConnection.readTextFile).toHaveBeenCalledWith({
            path: '/path/to/file',
            sessionId: 'session-1',
          });
          expect(mockFallback.readTextFile).not.toHaveBeenCalled();
        },
      },
      {
        capability: false,
        path: '/path/to/file',
        desc: 'fallback if capability missing',
        setup: () => {
          mockFallback.readTextFile.mockResolvedValue('content');
        },
        verify: () => {
          expect(mockFallback.readTextFile).toHaveBeenCalledWith(
            '/path/to/file',
          );
          expect(mockConnection.readTextFile).not.toHaveBeenCalled();
        },
      },
      {
        capability: true,
        path: '/outside/file',
        desc: 'fallback if capability exists but file is outside root',
        setup: () => {
          mockFallback.readTextFile.mockResolvedValue('content');
        },
        verify: () => {
          expect(mockFallback.readTextFile).toHaveBeenCalledWith(
            '/outside/file',
          );
          expect(mockConnection.readTextFile).not.toHaveBeenCalled();
        },
      },
      {
        capability: true,
        path: `/home/user/${CONFIG_DIR}/tmp/file.md`,
        root: '/home/user',
        desc: 'fallback if file is inside global gemini dir, even if root overlaps',
        setup: () => {
          mockFallback.readTextFile.mockResolvedValue('content');
        },
        verify: () => {
          expect(mockFallback.readTextFile).toHaveBeenCalledWith(
            `/home/user/${CONFIG_DIR}/tmp/file.md`,
          );
          expect(mockConnection.readTextFile).not.toHaveBeenCalled();
        },
      },
    ])(
      'should use $desc',
      async ({ capability, path, root, setup, verify }) => {
        service = new AcpFileSystemService(
          mockConnection,
          'session-1',
          { readTextFile: capability, writeTextFile: true },
          mockFallback,
          () => root || '/path/to',
        );
        setup();

        const result = await service.readTextFile(path);

        expect(result).toBe('content');
        verify();
      },
    );

    it('should throw normalized ENOENT error when readTextFile encounters "Resource not found"', async () => {
      service = new AcpFileSystemService(
        mockConnection,
        'session-1',
        { readTextFile: true, writeTextFile: true },
        mockFallback,
        () => '/path/to',
      );
      mockConnection.readTextFile.mockRejectedValue(
        new Error('Resource not found for document'),
      );

      await expect(
        service.readTextFile('/path/to/missing'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
        message: 'Resource not found for document',
      });
    });
  });

  describe('writeTextFile', () => {
    it.each([
      {
        capability: true,
        path: '/path/to/file',
        desc: 'connection if capability exists and file is inside root',
        verify: () => {
          expect(mockConnection.writeTextFile).toHaveBeenCalledWith({
            path: '/path/to/file',
            content: 'content',
            sessionId: 'session-1',
          });
          expect(mockFallback.writeTextFile).not.toHaveBeenCalled();
        },
      },
      {
        capability: false,
        path: '/path/to/file',
        desc: 'fallback if capability missing',
        verify: () => {
          expect(mockFallback.writeTextFile).toHaveBeenCalledWith(
            '/path/to/file',
            'content',
          );
          expect(mockConnection.writeTextFile).not.toHaveBeenCalled();
        },
      },
      {
        capability: true,
        path: '/outside/file',
        desc: 'fallback if capability exists but file is outside root',
        verify: () => {
          expect(mockFallback.writeTextFile).toHaveBeenCalledWith(
            '/outside/file',
            'content',
          );
          expect(mockConnection.writeTextFile).not.toHaveBeenCalled();
        },
      },
      {
        capability: true,
        path: `/home/user/${CONFIG_DIR}/tmp/file.md`,
        root: '/home/user',
        desc: 'fallback if file is inside global gemini dir, even if root overlaps',
        verify: () => {
          expect(mockFallback.writeTextFile).toHaveBeenCalledWith(
            `/home/user/${CONFIG_DIR}/tmp/file.md`,
            'content',
          );
          expect(mockConnection.writeTextFile).not.toHaveBeenCalled();
        },
      },
    ])('should use $desc', async ({ capability, path, root, verify }) => {
      service = new AcpFileSystemService(
        mockConnection,
        'session-1',
        { writeTextFile: capability, readTextFile: true },
        mockFallback,
        () => root || '/path/to',
      );

      await service.writeTextFile(path, 'content');

      verify();
    });

    it('should throw normalized ENOENT error when writeTextFile encounters "Resource not found"', async () => {
      service = new AcpFileSystemService(
        mockConnection,
        'session-1',
        { readTextFile: true, writeTextFile: true },
        mockFallback,
        () => '/path/to',
      );
      mockConnection.writeTextFile.mockRejectedValue(
        new Error('Resource not found for directory'),
      );

      await expect(
        service.writeTextFile('/path/to/missing', 'content'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
        message: 'Resource not found for directory',
      });
    });
  });
});
