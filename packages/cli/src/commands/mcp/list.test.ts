/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { listMcpServers } from './list.js';
import { loadSettings } from '../../config/settings.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { assembleMcpServers } from '../../config/mcpServers.js';
import { loadMcpApprovals } from '../../config/mcpApprovals.js';
import { createTransport, ExtensionManager } from '@qwen-code/qwen-code-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(),
}));
vi.mock('../../config/mcpServers.js', () => ({
  assembleMcpServers: vi.fn((servers) => servers ?? {}),
}));
vi.mock('../../config/mcpApprovals.js', () => ({
  loadMcpApprovals: vi.fn(() => ({
    getState: vi.fn(() => 'approved'),
  })),
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
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  isGatedMcpScope: (scope: string | undefined) =>
    scope === 'project' || scope === 'workspace',
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js');

const mockedLoadSettings = loadSettings as Mock;
const mockedAssembleMcpServers = assembleMcpServers as Mock;
const mockedLoadMcpApprovals = loadMcpApprovals as Mock;
const mockedIsWorkspaceTrusted = isWorkspaceTrusted as Mock;
const mockedCreateTransport = createTransport as Mock;
const MockedExtensionManager = ExtensionManager as Mock;
const MockedClient = Client as Mock;

interface MockClient {
  connect: Mock;
  ping: Mock;
  close: Mock;
}

interface MockTransport {
  close: Mock;
}

describe('mcp list command', () => {
  let mockClient: MockClient;
  let mockTransport: MockTransport;
  let mockExtensionManager: {
    refreshCache: Mock;
    getLoadedExtensions: Mock;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteStdoutLine.mockClear();

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
    mockedAssembleMcpServers.mockImplementation((servers) => servers ?? {});
    mockedLoadMcpApprovals.mockReturnValue({
      getState: vi.fn(() => 'approved'),
    });
  });

  it('should display message when no servers configured', async () => {
    mockedLoadSettings.mockReturnValue({ merged: { mcpServers: {} } });

    await listMcpServers();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No MCP servers configured.',
    );
  });

  it('should display different server types with connected status', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: {
          'stdio-server': { command: '/path/to/server', args: ['arg1'] },
          'sse-server': { url: 'https://example.com/sse' },
          'http-server': { httpUrl: 'https://example.com/http' },
        },
      },
    });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue(undefined);

    await listMcpServers();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Configured MCP servers:\n',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'stdio-server: /path/to/server arg1 (stdio) - Connected',
      ),
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'sse-server: https://example.com/sse (sse) - Connected',
      ),
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'http-server: https://example.com/http (http) - Connected',
      ),
    );
  });

  it('should display disconnected status when connection fails', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: {
          'test-server': { command: '/test/server' },
        },
      },
    });

    mockClient.connect.mockRejectedValue(new Error('Connection failed'));

    await listMcpServers();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'test-server: /test/server  (stdio) - Disconnected',
      ),
    );
  });

  it('should merge extension servers with config servers', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: { 'config-server': { command: '/config/server' } },
      },
    });

    mockExtensionManager.getLoadedExtensions.mockReturnValue([
      {
        isActive: true,
        config: {
          name: 'test-extension',
          mcpServers: { 'extension-server': { command: '/ext/server' } },
        },
      },
    ]);

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue(undefined);

    await listMcpServers();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'config-server: /config/server  (stdio) - Connected',
      ),
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'extension-server: /ext/server  (stdio) - Connected',
      ),
    );
  });

  it('shows a pending project server without connecting', async () => {
    mockedLoadSettings.mockReturnValue({ merged: { mcpServers: {} } });
    mockedAssembleMcpServers.mockReturnValue({
      'project-server': {
        command: 'node',
        args: ['server.js'],
        scope: 'project',
      },
    });
    mockedLoadMcpApprovals.mockReturnValue({
      getState: vi.fn(() => 'pending'),
    });

    await listMcpServers();

    expect(mockedCreateTransport).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'project-server: node server.js (stdio) - Pending approval',
      ),
    );
  });

  it('shows a rejected workspace server without connecting', async () => {
    mockedLoadSettings.mockReturnValue({ merged: { mcpServers: {} } });
    mockedAssembleMcpServers.mockReturnValue({
      'workspace-server': {
        httpUrl: 'https://example.com/mcp',
        scope: 'workspace',
      },
    });
    mockedLoadMcpApprovals.mockReturnValue({
      getState: vi.fn(() => 'rejected'),
    });

    await listMcpServers();

    expect(mockedCreateTransport).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'workspace-server: https://example.com/mcp (http) - Rejected',
      ),
    );
  });
});
