/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { listMcpServers } from './list.js';
import { loadSettings } from '../../config/settings.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
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

describe('mcp list command', () => {
  let mockClient: MockClient;
  let mockTransport: MockTransport;
  let mockExtensionManager: {
    refreshCache: vi.Mock;
    getLoadedExtensions: vi.Mock;
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

  it('should show excluded servers as disabled without testing them', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcp: {
          excluded: ['disabled-server'],
        },
        mcpServers: {
          'enabled-server': { command: '/enabled/server' },
          'disabled-server': { command: '/disabled/server' },
        },
      },
    });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue(undefined);

    await listMcpServers();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'enabled-server: /enabled/server  (stdio) - Connected',
      ),
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'disabled-server: /disabled/server  (stdio) - disabled',
      ),
    );
    expect(mockedCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockedCreateTransport).toHaveBeenCalledWith(
      'enabled-server',
      expect.any(Object),
      false,
    );
  });

  it('should not test servers that are not in mcp.allowed', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcp: {
          allowed: ['enabled-server'],
        },
        mcpServers: {
          'enabled-server': { command: '/enabled/server' },
          'not-allowed-server': { command: '/not-allowed/server' },
        },
      },
    });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue(undefined);

    await listMcpServers();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'enabled-server: /enabled/server  (stdio) - Connected',
      ),
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'not-allowed-server: /not-allowed/server  (stdio) - disabled',
      ),
    );
    expect(mockedCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockedCreateTransport).toHaveBeenCalledWith(
      'enabled-server',
      expect.any(Object),
      false,
    );
  });
});
