/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reconnectCommand } from './reconnect.js';
import { loadSettings } from '../../config/settings.js';
import { assembleMcpServers } from '../../config/mcpServers.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { Config, ExtensionManager } from '@qwen-code/qwen-code-core';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockProcessExit = vi.hoisted(() => vi.fn());
const mockGetPendingGatedMcpServers = vi.hoisted(() => vi.fn());
const mockAssembleMcpServers = vi.hoisted(() => vi.fn());
const mockIsWorkspaceTrusted = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../config/mcpServers.js', () => ({
  assembleMcpServers: mockAssembleMcpServers,
}));

vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: mockIsWorkspaceTrusted,
}));

vi.mock('../../config/mcpApprovals.js', () => ({
  getPendingGatedMcpServers: mockGetPendingGatedMcpServers,
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  Config: vi.fn(),
  FileDiscoveryService: vi.fn(),
  ExtensionManager: vi.fn(),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const mockedLoadSettings = loadSettings as vi.Mock;
const mockedAssembleMcpServers = assembleMcpServers as vi.Mock;
const mockedIsWorkspaceTrusted = isWorkspaceTrusted as vi.Mock;
const MockedConfig = Config as vi.Mock;
const MockedExtensionManager = ExtensionManager as vi.Mock;

describe('mcp reconnect command', () => {
  let mockConfig: {
    getToolRegistry: vi.Mock;
    shutdown: vi.Mock;
    initialize: vi.Mock;
  };
  let mockToolRegistry: {
    discoverToolsForServer: vi.Mock;
  };
  let mockExtensionManager: {
    refreshCache: vi.Mock;
    getLoadedExtensions: vi.Mock;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteStdoutLine.mockClear();
    mockWriteStderrLine.mockClear();

    mockToolRegistry = {
      discoverToolsForServer: vi.fn().mockResolvedValue(undefined),
    };

    mockConfig = {
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      shutdown: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
    };

    mockExtensionManager = {
      refreshCache: vi.fn().mockResolvedValue(undefined),
      getLoadedExtensions: vi.fn().mockReturnValue([]),
    };

    MockedConfig.mockImplementation(() => mockConfig);
    MockedExtensionManager.mockImplementation(() => mockExtensionManager);
    mockGetPendingGatedMcpServers.mockReturnValue([]);
    mockedAssembleMcpServers.mockImplementation((servers) => servers ?? {});
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: true,
      source: 'file',
    });

    Object.defineProperty(process, 'exit', {
      value: mockProcessExit,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('reconnect specific server', () => {
    it('should successfully reconnect a specific server', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        'Reconnecting to server "test-server"...',
      );
      expect(mockToolRegistry.discoverToolsForServer).toHaveBeenCalledWith(
        'test-server',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        'Successfully reconnected to server "test-server".',
      );
    });

    it('passes pending gated servers to the reconnect config', async () => {
      const mcpServers = {
        approved: { command: '/path/to/server' },
        pending: { command: '/path/to/pending', scope: 'workspace' },
      };
      mockedLoadSettings.mockReturnValue({
        merged: { mcpServers },
      });
      mockGetPendingGatedMcpServers.mockReturnValue(['pending']);

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'approved', all: false });

      expect(MockedConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers,
          pendingMcpServers: ['pending'],
        }),
      );
      expect(mockToolRegistry.discoverToolsForServer).toHaveBeenCalledWith(
        'approved',
      );
    });

    it('passes explicit untrusted workspace state to the extension manager', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });
      mockedIsWorkspaceTrusted.mockReturnValue({
        isTrusted: false,
        source: 'file',
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(MockedExtensionManager).toHaveBeenCalledWith(
        expect.objectContaining({
          isWorkspaceTrusted: false,
        }),
      );
    });

    it('reconnects project servers from assembled MCP config', async () => {
      const settingsServers = {
        user: { command: '/path/to/user' },
      };
      const assembledServers = {
        user: { command: '/path/to/user' },
        project: { command: '/path/to/project', scope: 'project' },
      };
      mockedLoadSettings.mockReturnValue({
        merged: { mcpServers: settingsServers },
      });
      mockedAssembleMcpServers.mockReturnValue(assembledServers);

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'project', all: false });

      expect(mockedAssembleMcpServers).toHaveBeenCalledWith(
        settingsServers,
        process.cwd(),
      );
      expect(mockToolRegistry.discoverToolsForServer).toHaveBeenCalledWith(
        'project',
      );
    });

    it('should print error when server not found', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'other-server': { command: '/path/to/server' },
          },
        },
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'nonexistent-server', all: false });

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Error: Server "nonexistent-server" not found in configuration.',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('should print error when reconnection fails', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });

      mockToolRegistry.discoverToolsForServer.mockRejectedValue(
        new Error('Connection refused'),
      );

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect to server "test-server": Connection refused',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe('reconnect all servers', () => {
    it('should successfully reconnect all servers', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { command: '/path/to/server1' },
            'server-two': { command: '/path/to/server2' },
          },
        },
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        'Reconnecting to all MCP servers...\n',
      );
      expect(mockToolRegistry.discoverToolsForServer).toHaveBeenCalledWith(
        'server-one',
      );
      expect(mockToolRegistry.discoverToolsForServer).toHaveBeenCalledWith(
        'server-two',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✓ server-one: Reconnected successfully',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✓ server-two: Reconnected successfully',
      );
    });

    it('should print message when no servers configured', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {},
        },
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        'No MCP servers configured.',
      );
    });

    it('should report failure for individual servers when reconnecting all', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { command: '/path/to/server1' },
            'server-two': { command: '/path/to/server2' },
          },
        },
      });

      mockToolRegistry.discoverToolsForServer
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Timeout'));

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✓ server-one: Reconnected successfully',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✗ server-two: Failed - Timeout',
      );
    });
  });
});
