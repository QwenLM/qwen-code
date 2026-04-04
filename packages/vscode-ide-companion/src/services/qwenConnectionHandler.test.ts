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
import { authMethod } from '../types/acpTypes.js';

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
    vi.useRealTimers();
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

  describe('authentication flow', () => {
    const authRequiredError = Object.assign(
      new Error('Authentication required (code: -32000)'),
      { code: -32000 },
    );

    it('returns requiresAuth without auto-authenticating when autoAuthenticate is false', async () => {
      mockGetConfiguration.mockReturnValue({ get: () => undefined });
      (
        mockConnection.newSession as unknown as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(authRequiredError);

      const result = await handler.connect(
        mockConnection,
        '/workspace',
        '/path/to/cli.js',
        {
          autoAuthenticate: false,
        },
      );

      expect(result.sessionCreated).toBe(false);
      expect(result.requiresAuth).toBe(true);
      expect(mockConnection.authenticate).not.toHaveBeenCalled();
      expect(mockConnection.newSession).toHaveBeenCalledTimes(1);
    });

    it('authenticates and retries session creation when autoAuthenticate is true', async () => {
      vi.useFakeTimers();
      mockGetConfiguration.mockReturnValue({ get: () => undefined });
      (mockConnection.newSession as unknown as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(authRequiredError)
        .mockResolvedValueOnce({ sessionId: 'after-auth-session' });

      const connectPromise = handler.connect(
        mockConnection,
        '/workspace',
        '/path/to/cli.js',
        {
          autoAuthenticate: true,
        },
      );

      await vi.runAllTimersAsync();
      const result = await connectPromise;

      expect(mockConnection.authenticate).toHaveBeenCalledWith(authMethod);
      expect(mockConnection.newSession).toHaveBeenCalledTimes(2);
      expect(result.sessionCreated).toBe(true);
      expect(result.requiresAuth).toBe(false);
    });
  });
});
