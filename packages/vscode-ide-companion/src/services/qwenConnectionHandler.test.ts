/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(),
  },
}));

import { QwenConnectionHandler } from './qwenConnectionHandler.js';
import type { AcpConnection } from './acpConnection.js';

describe('QwenConnectionHandler', () => {
  let handler: QwenConnectionHandler;
  let mockConnection: AcpConnection;
  let mockGetConfiguration: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const vscode = await import('vscode');
    mockGetConfiguration = vscode.workspace.getConfiguration as ReturnType<
      typeof vi.fn
    >;
    mockGetConfiguration.mockReset();

    handler = new QwenConnectionHandler();
    mockConnection = {
      connect: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
      authenticate: vi.fn().mockResolvedValue({}),
    } as unknown as AcpConnection;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('proxy configuration', () => {
    it('passes --proxy argument when http.proxy is set', async () => {
      mockGetConfiguration.mockReturnValue({
        get: (key: string) => {
          if (key === 'proxy') {
            return 'http://proxy.example.com:8080';
          }
          return undefined;
        },
      });

      await handler.connect(mockConnection, '/workspace', '/path/to/cli.js');

      expect(mockConnection.connect).toHaveBeenCalled();
      const connectArgs = (mockConnection.connect as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(connectArgs[2]).toContain('--proxy');
      expect(connectArgs[2]).toContain('http://proxy.example.com:8080');
    });

    it('passes --proxy argument when https.proxy is set (fallback)', async () => {
      mockGetConfiguration.mockReturnValue({
        get: (key: string) => {
          if (key === 'proxy') {
            return undefined;
          }
          if (key === 'https.proxy') {
            return 'http://https-proxy.example.com:8080';
          }
          return undefined;
        },
      });

      await handler.connect(mockConnection, '/workspace', '/path/to/cli.js');

      expect(mockConnection.connect).toHaveBeenCalled();
      const connectArgs = (mockConnection.connect as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(connectArgs[2]).toContain('--proxy');
      expect(connectArgs[2]).toContain('http://https-proxy.example.com:8080');
    });

    it('prefers http.proxy over https.proxy', async () => {
      mockGetConfiguration.mockReturnValue({
        get: (key: string) => {
          if (key === 'proxy') {
            return 'http://http-proxy.example.com:8080';
          }
          if (key === 'https.proxy') {
            return 'http://https-proxy.example.com:8080';
          }
          return undefined;
        },
      });

      await handler.connect(mockConnection, '/workspace', '/path/to/cli.js');

      const connectArgs = (mockConnection.connect as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(connectArgs[2]).toContain('http://http-proxy.example.com:8080');
      expect(connectArgs[2]).not.toContain(
        'http://https-proxy.example.com:8080',
      );
    });

    it('does not pass --proxy argument when no proxy is configured', async () => {
      mockGetConfiguration.mockReturnValue({
        get: () => undefined,
      });

      await handler.connect(mockConnection, '/workspace', '/path/to/cli.js');

      const connectArgs = (mockConnection.connect as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(connectArgs[2]).not.toContain('--proxy');
    });

    it('does not pass --proxy argument when proxy is empty string', async () => {
      mockGetConfiguration.mockReturnValue({
        get: (key: string) => {
          if (key === 'proxy') {
            return '';
          }
          return undefined;
        },
      });

      await handler.connect(mockConnection, '/workspace', '/path/to/cli.js');

      const connectArgs = (mockConnection.connect as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(connectArgs[2]).not.toContain('--proxy');
    });
  });

  describe('connect retry logic', () => {
    beforeEach(() => {
      mockGetConfiguration.mockReturnValue({
        get: () => undefined,
      });
      // Speed up tests by mocking setTimeout-based delays
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('succeeds on first attempt without retry', async () => {
      await handler.connect(mockConnection, '/workspace', '/path/to/cli.js');

      expect(mockConnection.connect).toHaveBeenCalledTimes(1);
    });

    it('retries connect on spawn failure and succeeds on second attempt', async () => {
      (mockConnection.connect as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(
          new Error(
            'Qwen ACP process failed to start (exit code: null, signal: SIGTERM)',
          ),
        )
        .mockResolvedValueOnce(undefined);

      await handler.connect(mockConnection, '/workspace', '/path/to/cli.js');

      expect(mockConnection.connect).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting all connect retry attempts (3 attempts)', async () => {
      const spawnError = new Error(
        'Qwen ACP process failed to start (exit code: null, signal: SIGTERM)',
      );
      (mockConnection.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
        spawnError,
      );

      await expect(
        handler.connect(mockConnection, '/workspace', '/path/to/cli.js'),
      ).rejects.toThrow(spawnError);

      expect(mockConnection.connect).toHaveBeenCalledTimes(3);
    });
  });
});
