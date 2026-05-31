/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  isProjectMcpServerPendingApproval: (
    config: { source?: string; pendingApproval?: boolean } | undefined,
  ) => config?.source === 'project' && config.pendingApproval === true,
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

    expect(mockWriteStdoutLine).toHaveBeenCalledWith('MCP servers:\n');
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

  it('shows project .mcp.json servers as pending without connecting', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-mcp-list-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          project: {
            command: 'node',
            args: ['server.js'],
          },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mockedLoadSettings.mockReturnValue({ merged: { mcpServers: {} } });

    await listMcpServers();

    expect(mockedCreateTransport).not.toHaveBeenCalled();
    expect(mockClient.connect).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'project: node server.js (stdio) - Pending approval',
      ),
    );
  });

  it('keeps settings servers active when .mcp.json uses the same name', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-mcp-list-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          server: {
            command: 'node',
            args: ['project.js'],
          },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: {
          server: { command: 'node', args: ['settings.js'] },
        },
      },
    });
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue(undefined);

    await listMcpServers();

    expect(mockedCreateTransport).toHaveBeenCalledOnce();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('server: node settings.js (stdio) - Connected'),
    );
  });

  it('keeps a pending project server when an extension uses the same name', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-mcp-list-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          server: {
            command: 'node',
            args: ['project.js'],
          },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mockedLoadSettings.mockReturnValue({ merged: { mcpServers: {} } });
    mockExtensionManager.getLoadedExtensions.mockReturnValue([
      {
        isActive: true,
        config: {
          name: 'test-extension',
          mcpServers: { server: { command: '/ext/server' } },
        },
      },
    ]);

    await listMcpServers();

    expect(mockedCreateTransport).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'server: node project.js (stdio) - Pending approval',
      ),
    );
  });
});
