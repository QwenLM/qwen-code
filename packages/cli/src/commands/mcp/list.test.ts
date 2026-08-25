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
import {
  createMcpClient,
  createTransport,
  ExtensionManager,
} from '@qwen-code/qwen-code-core';

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
  createMcpClient: vi.fn(),
  MCPServerStatus: {
    CONNECTED: 'CONNECTED',
    CONNECTING: 'CONNECTING',
    DISCONNECTED: 'DISCONNECTED',
  },
  ExtensionManager: vi.fn(),
  runWithTimeout: <T>(task: Promise<T>, timeoutMs: number, _label: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      task.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    }),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  isGatedMcpScope: (scope: string | undefined) =>
    scope === 'project' || scope === 'workspace',
}));

const mockedLoadSettings = loadSettings as Mock;
const mockedAssembleMcpServers = assembleMcpServers as Mock;
const mockedLoadMcpApprovals = loadMcpApprovals as Mock;
const mockedIsWorkspaceTrusted = isWorkspaceTrusted as Mock;
const mockedCreateTransport = createTransport as Mock;
const mockedCreateMcpClient = createMcpClient as Mock;
const MockedExtensionManager = ExtensionManager as Mock;

interface MockClient {
  connect: Mock;
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
      close: vi.fn(),
    };

    mockExtensionManager = {
      refreshCache: vi.fn().mockResolvedValue(undefined),
      getLoadedExtensions: vi.fn().mockReturnValue([]),
    };

    mockedCreateMcpClient.mockReturnValue(mockClient);
    mockedCreateTransport.mockResolvedValue(mockTransport);
    MockedExtensionManager.mockImplementation(() => mockExtensionManager);
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: true,
      source: 'file',
    });
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

  it('passes explicit untrusted workspace state to the extension manager', async () => {
    mockedLoadSettings.mockReturnValue({ merged: { mcpServers: {} } });
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: false,
      source: 'file',
    });

    await listMcpServers();

    expect(MockedExtensionManager).toHaveBeenCalledWith(
      expect.objectContaining({
        isWorkspaceTrusted: false,
      }),
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
    expect(mockedCreateMcpClient).toHaveBeenCalledWith(
      'mcp-test-client',
      expect.objectContaining({ command: '/path/to/server' }),
    );
    expect(mockedCreateMcpClient).toHaveBeenCalledWith(
      'mcp-test-client',
      expect.objectContaining({ url: 'https://example.com/sse' }),
    );
    expect(mockedCreateMcpClient).toHaveBeenCalledWith(
      'mcp-test-client',
      expect.objectContaining({ httpUrl: 'https://example.com/http' }),
    );
    expect(mockClient.connect).toHaveBeenCalledWith(mockTransport, {
      timeout: 10_000,
    });
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

  it('should disconnect when transport startup exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'slow-server': { url: 'https://example.com/sse' },
          },
        },
      });
      mockClient.connect.mockImplementation(() => new Promise(() => {}));

      const listPromise = listMcpServers();
      await vi.advanceTimersByTimeAsync(9999);
      expect(mockTransport.close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await listPromise;

      expect(mockTransport.close).toHaveBeenCalledOnce();
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining(
          'slow-server: https://example.com/sse (sse) - Disconnected (timed out after 10000ms)',
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the connection timeout after a successful connection', async () => {
    vi.useFakeTimers();
    try {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'healthy-server': { url: 'https://example.com/sse' },
          },
        },
      });
      mockClient.connect.mockResolvedValue(undefined);

      await listMcpServers();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
