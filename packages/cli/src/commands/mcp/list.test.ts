/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { listMcpServers } from './list.js';
import { mergeSettings } from '../../config/settings.js';
import {
  createTransport,
  mcpServerRequiresOAuth,
} from '@qwen-code/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { McpServerEnablementManager } from '../../config/mcp/index.js';

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    loadSettings: mockLoadedSettings,
    loadEnvironment: vi.fn(),
    getFlagSettingsInput: vi.fn(),
  };
});
vi.mock('../../config/createCliSettingsService.js', () => ({
  createCliSettingsService: () => ({
    resolve: () => ({ ...mockLoadedSettings(), errors: [] }),
  }),
}));
vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: () => ({ isTrusted: mockLoadedSettings().isTrusted }),
}));
vi.mock('../../config/mcp/projectMcpJson.js', () => ({
  loadProjectMcpJson: vi.fn().mockReturnValue({}),
}));
vi.mock('@qwen-code/core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...original,
    createTransport: vi.fn(),

    MCPServerStatus: {
      CONNECTED: 'CONNECTED',
      CONNECTING: 'CONNECTING',
      DISCONNECTED: 'DISCONNECTED',
      BLOCKED: 'BLOCKED',
      DISABLED: 'DISABLED',
    },
    Storage: class {
      getGlobalSettingsPath = () => '/tmp/gemini/settings.json';
      getConfigDir = () => '/tmp/gemini';
      getWorkspaceSettingsPath = () => '/tmp/gemini/workspace-settings.json';
      getWorkspaceLocalSettingsPath = () => '/tmp/gemini/local-settings.json';
      isWorkspaceHomeDir = () => false;
      getProjectTempDir = () => '/test/home/.qwen/tmp/mocked_hash';
      static getGlobalSettingsPath = () => '/tmp/gemini/settings.json';
      static getGlobalConfigDir = () => '/tmp/gemini';
    },
    CONFIG_DIR: '.qwen',
    getErrorMessage: (e: unknown) =>
      e instanceof Error ? e.message : String(e),
  };
});
vi.mock('@modelcontextprotocol/sdk/client/index.js');

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(),
}));

const mockLoadedSettings = vi.hoisted(() => vi.fn());
const mockedCreateTransport = createTransport as Mock;
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
  let stdoutWriteSpy: Mock;

  beforeEach(() => {
    vi.resetAllMocks();
    McpServerEnablementManager.resetInstance();

    mockTransport = { close: vi.fn() };
    mockClient = {
      connect: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
    };

    MockedClient.mockImplementation(() => mockClient);
    mockedCreateTransport.mockResolvedValue(mockTransport);
    mcpServerRequiresOAuth.clear();
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true) as unknown as Mock;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });




  it('should display disconnected status when connection fails', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'test-server': { command: '/test/server' },
        },
      },
      isTrusted: true,
    });

    mockClient.connect.mockRejectedValue(new Error('Connection failed'));

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) => s.includes('test-server') && s.includes('Disconnected'),
      ),
    ).toBe(true);
  });

  it('should display connected status when connect succeeds but ping fails', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'no-ping-server': { command: '/test/server' },
        },
      },
      isTrusted: true,
    });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockRejectedValue(
      new McpError(ErrorCode.MethodNotFound, 'Method not found'),
    );

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) =>
          s.includes('no-ping-server') && s.includes('Connected'),
      ),
    ).toBe(true);
    expect(mockClient.connect).toHaveBeenCalledWith(mockTransport, {
      timeout: 5000,
    });
    expect(mockClient.ping).toHaveBeenCalledWith({ timeout: 5000 });
  });

  it('should display disconnected status when ping fails for a reason other than method not found', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'dropped-server': { command: '/test/server' },
        },
      },
      isTrusted: true,
    });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockRejectedValue(
      new McpError(ErrorCode.ConnectionClosed, 'Connection closed'),
    );

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) =>
          s.includes('dropped-server') && s.includes('Disconnected'),
      ),
    ).toBe(true);
  });

  it('should display needs authentication status when ping returns authorization error', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'auth-ping-server': { url: 'https://example.com/mcp', type: 'http' },
        },
      },
      isTrusted: true,
    });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockRejectedValue(new Error('HTTP 401 Unauthorized'));

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) =>
          s.includes('auth-ping-server') && s.includes('Needs authentication'),
      ),
    ).toBe(true);
  });

  it('should display needs authentication status when connection returns 401', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'auth-server': { url: 'https://example.com/mcp', type: 'http' },
        },
      },
      isTrusted: true,
    });

    mockClient.connect.mockRejectedValue(new Error('HTTP 401 Unauthorized'));

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) =>
          s.includes('auth-server') && s.includes('Needs authentication'),
      ),
    ).toBe(true);
  });

  it('should display needs authentication status when transport creation returns 401', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'auth-server': { url: 'https://example.com/mcp', type: 'http' },
        },
      },
      isTrusted: true,
    });

    mockedCreateTransport.mockRejectedValue(new Error('HTTP 401 Unauthorized'));

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) =>
          s.includes('auth-server') && s.includes('Needs authentication'),
      ),
    ).toBe(true);
  });

  it('should list config servers', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'config-server': { command: '/config/server' },
        },
      },
      isTrusted: true,
    });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue(undefined);

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) => s.includes('config-server') && s.includes('Connected'),
      ),
    ).toBe(true);
  });

  it('should show stdio servers as disconnected in untrusted folders', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'test-server': { command: '/test/server' },
        },
      },
      isTrusted: false,
    });

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) => s.includes('test-server') && s.includes('Disconnected'),
      ),
    ).toBe(true);
  });

  it('should display blocked status for servers in excluded list', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcp: {
          excluded: ['blocked-server'],
        },
        mcpServers: {
          'blocked-server': { command: '/test/server' },
        },
      },
      isTrusted: true,
    });

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) => s.includes('blocked-server') && s.includes('Blocked'),
      ),
    ).toBe(true);
    expect(mockedCreateTransport).not.toHaveBeenCalled();
  });

  it('should display disabled status for servers with disabled: true in settings.json', async () => {
    const defaultMergedSettings = mergeSettings({}, {}, true);
    mockLoadedSettings.mockReturnValue({
      merged: {
        ...defaultMergedSettings,
        mcpServers: {
          'disabled-server': { command: '/test/server', disabled: true },
        },
      },
      isTrusted: true,
    });

    await listMcpServers();

    const writtenCalls = stdoutWriteSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writtenCalls.some(
        (s: string) => s.includes('disabled-server') && s.includes('Disabled'),
      ),
    ).toBe(true);
    expect(mockedCreateTransport).not.toHaveBeenCalled();
  });
});
