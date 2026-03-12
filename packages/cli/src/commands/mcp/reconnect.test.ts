/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import yargs from 'yargs';
import { reconnectCommand } from './reconnect.js';
import { loadSettings } from '../../config/settings.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { createTransport, ExtensionManager } from '@qwen-code/qwen-code-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(),
}));
vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core', () => ({
  createTransport: vi.fn(),
  MCPServerStatus: {
    CONNECTED: 'CONNECTED',
    CONNECTING: 'CONNECTING',
    DISCONNECTED: 'DISCONNECTED',
  },
  ExtensionManager: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js');

const mockedLoadSettings = loadSettings as vi.Mock;
const mockedIsWorkspaceTrusted = isWorkspaceTrusted as vi.Mock;
const mockedCreateTransport = createTransport as vi.Mock;
const MockedExtensionManager = ExtensionManager as vi.Mock;
const MockedClient = Client as vi.Mock;

interface MockClient {
  connect: vi.Mock;
  ping: vi.Mock;
  close: vi.Mock;
}

interface MockTransport {
  close: vi.Mock;
}

const originalExit = process.exit;

describe('mcp reconnect command', () => {
  let mockClient: MockClient;
  let mockTransport: MockTransport;
  let mockExtensionManager: {
    refreshCache: vi.Mock;
    getLoadedExtensions: vi.Mock;
  };
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteStdoutLine.mockClear();
    mockWriteStderrLine.mockClear();
    exitCode = undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;

    mockTransport = { close: vi.fn() };
    mockClient = {
      connect: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
    };

    mockExtensionManager = {
      refreshCache: vi.fn().mockResolvedValue(undefined),
      getLoadedExtensions: vi.fn().mockReturnValue([]),
    };

    MockedClient.mockImplementation(() => mockClient);
    mockedCreateTransport.mockResolvedValue(mockTransport);
    MockedExtensionManager.mockImplementation(() => mockExtensionManager);
    mockedIsWorkspaceTrusted.mockReturnValue(true);
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  describe('reconnect specific server', () => {
    it('should successfully reconnect a disconnected server', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });

      mockClient.connect.mockResolvedValue(undefined);
      mockClient.ping.mockResolvedValue(undefined);

      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      await parser.parse('reconnect test-server');

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        'Successfully reconnected to server "test-server".',
      );
      expect(exitCode).toBeUndefined();
    });

    it('should show error for non-existent server', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: { mcpServers: {} },
      });

      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      await parser.parse('reconnect unknown-server');

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Error: Server "unknown-server" not found in configuration.',
      );
      expect(exitCode).toBe(1);
    });

    it('should show error when connection fails', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'failing-server': { command: '/path/to/server' },
          },
        },
      });

      mockClient.connect.mockRejectedValue(new Error('Connection refused'));

      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      await parser.parse('reconnect failing-server');

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect to server "failing-server": Connection could not be established.',
      );
      expect(exitCode).toBe(1);
    });
  });

  describe('reconnect --all', () => {
    it('should reconnect all disconnected servers', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-1': { command: '/path/to/server1' },
            'server-2': { command: '/path/to/server2' },
          },
        },
      });

      mockClient.connect.mockResolvedValue(undefined);
      mockClient.ping.mockResolvedValue(undefined);

      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      await parser.parse('reconnect --all');

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('Summary:'),
      );
      expect(exitCode).toBeUndefined();
    });

    it('should show message when no servers configured', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: { mcpServers: {} },
      });

      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      await parser.parse('reconnect --all');

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        'No MCP servers configured.',
      );
      expect(exitCode).toBeUndefined();
    });

    it('should show message when all servers already connected', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'connected-server': { command: '/path/to/server' },
          },
        },
      });

      mockClient.connect.mockResolvedValue(undefined);
      mockClient.ping.mockResolvedValue(undefined);

      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      await parser.parse('reconnect --all');

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('1 already connected'),
      );
      expect(exitCode).toBeUndefined();
    });

    it('should handle partial failures', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-1': { command: '/path/to/server1' },
          },
        },
      });

      mockedCreateTransport.mockRejectedValue(new Error('Transport failed'));

      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      await parser.parse('reconnect --all');

      expect(mockWriteStderrLine).toHaveBeenCalled();
      expect(exitCode).toBe(1);
    });
  });

  describe('argument validation', () => {
    it('should require either server name or --all', async () => {
      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      try {
        await parser.parse('reconnect');
      } catch (e) {
        expect((e as Error).message).toContain(
          'Either specify a server name or use --all flag',
        );
      }
    });

    it('should not allow both server name and --all', async () => {
      const parser = yargs([])
        .command(reconnectCommand)
        .fail(false)
        .locale('en');

      try {
        await parser.parse('reconnect test-server --all');
      } catch (e) {
        expect((e as Error).message).toContain(
          'Cannot specify both server name and --all flag',
        );
      }
    });
  });
});
