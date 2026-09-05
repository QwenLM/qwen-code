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

const mockGetMCPServerStatus = vi.hoisted(() => vi.fn());
const mockGetMCPServerLastError = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  Config: vi.fn(),
  FileDiscoveryService: vi.fn(),
  ExtensionManager: vi.fn(),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  getMCPServerStatus: mockGetMCPServerStatus,
  getMCPServerLastError: mockGetMCPServerLastError,
  MCPServerStatus: {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
  },
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
    getMcpServerUnavailableReason: vi.Mock;
    isMcpServerDisabled: vi.Mock;
    isMcpServerPendingApproval: vi.Mock;
    isTrustedFolder: vi.Mock;
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
      // Default: nothing is skipped, so verification failures report the
      // generic connection message.
      getMcpServerUnavailableReason: vi.fn().mockReturnValue(undefined),
      isMcpServerDisabled: vi.fn().mockReturnValue(false),
      isMcpServerPendingApproval: vi.fn().mockReturnValue(false),
      isTrustedFolder: vi.fn().mockReturnValue(true),
    };

    mockExtensionManager = {
      refreshCache: vi.fn().mockResolvedValue(undefined),
      getLoadedExtensions: vi.fn().mockReturnValue([]),
    };

    MockedConfig.mockImplementation(() => mockConfig);
    MockedExtensionManager.mockImplementation(() => mockExtensionManager);
    mockGetPendingGatedMcpServers.mockReturnValue([]);
    // Discovery is best-effort and swallows connect errors, so the command
    // verifies the outcome through the status registry; default to a live
    // connection so success-path tests stay green.
    mockGetMCPServerStatus.mockReturnValue('connected');
    // No recorded failure cause by default; failure-path tests opt in.
    mockGetMCPServerLastError.mockReturnValue(undefined);
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
      // The handler's `process.exit(1)` does not terminate stdio MCP servers
      // the failed attempt spawned; shutdown must run on the failure path too.
      expect(mockConfig.shutdown).toHaveBeenCalled();
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
      // All servers verified live → no failure exit.
      expect(mockProcessExit).not.toHaveBeenCalled();
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
      // A partial failure must still exit non-zero so wrapper scripts
      // (`qwen mcp reconnect --all || alert`) can see it — matching the
      // single-server path, which exits 1 for the identical failure.
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect 1 of 2 configured server(s).',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      // The process-scope note must print on the failure path too — that is
      // exactly when the user's running session still has broken tools.
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining(
          'cannot refresh the MCP tools of an already-running Qwen Code session',
        ),
      );
    });
  });

  describe('process scope (issue #9944)', () => {
    it('initializes the throwaway config without background MCP discovery', async () => {
      // The command runs its own targeted `discoverToolsForServer`; the
      // background incremental pass would race `config.shutdown()` and
      // re-arm health-check timers that keep the process alive forever.
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

      expect(mockConfig.initialize).toHaveBeenCalledWith({
        skipMcpDiscovery: true,
      });
    });

    it('clarifies that single-server success only covers this process', async () => {
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
        expect.stringContaining(
          'cannot refresh the MCP tools of an already-running Qwen Code session',
        ),
      );
    });

    it('clarifies that --all success only covers this process', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { command: '/path/to/server1' },
          },
        },
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining(
          'cannot refresh the MCP tools of an already-running Qwen Code session',
        ),
      );
    });

    it('clarifies that single-server failure only covers this process', async () => {
      // The note must not be success-only: a failed reconnect is exactly
      // when the user's running session still has broken tools and might
      // read the exit-1 output as session-level state. `--all` already
      // prints the note on failure; pin the single-server path to match.
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });
      mockGetMCPServerStatus.mockReturnValue('disconnected');

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining(
          'cannot refresh the MCP tools of an already-running Qwen Code session',
        ),
      );
    });
  });

  describe('connection verification (issue #9944)', () => {
    // `discoverToolsForServer` swallows connect errors, so a bare "it
    // returned" is not proof the server is reachable. The command must
    // verify the live status instead of printing a false success.
    it('reports failure when a single server never reached CONNECTED', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { httpUrl: 'http://127.0.0.1:3939/mcp' },
          },
        },
      });
      mockGetMCPServerStatus.mockReturnValue('disconnected');

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(mockToolRegistry.discoverToolsForServer).toHaveBeenCalledWith(
        'test-server',
      );
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect to server "test-server": connection attempt finished without a live connection (status: disconnected)',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
        'Successfully reconnected to server "test-server".',
      );
      // Verification failure throws before the success output; shutdown must
      // still run or the spawned server is orphaned by `process.exit(1)`.
      expect(mockConfig.shutdown).toHaveBeenCalled();
    });

    it('marks --all entries failed when they never reached CONNECTED', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { command: '/path/to/server1' },
            'server-two': { command: '/path/to/server2' },
          },
        },
      });
      mockGetMCPServerStatus.mockImplementation((name: string) =>
        name === 'server-one' ? 'connected' : 'disconnected',
      );

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✓ server-one: Reconnected successfully',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✗ server-two: Failed - connection attempt finished without a live connection (status: disconnected)',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining(
          'cannot refresh the MCP tools of an already-running Qwen Code session',
        ),
      );
    });

    it('surfaces the recorded failure cause when verification fails', async () => {
      // Discovery swallows the connect error (debugLogger only), but the
      // client records the cause in the status registry before it is
      // swallowed. The failure output must carry it — a bare
      // "(status: disconnected)" sends debugging in no direction at all.
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { httpUrl: 'http://127.0.0.1:3939/mcp' },
          },
        },
      });
      mockGetMCPServerStatus.mockReturnValue('disconnected');
      mockGetMCPServerLastError.mockReturnValue(
        'connect ECONNREFUSED 127.0.0.1:3939',
      );

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect to server "test-server": connection attempt finished without a live connection (status: disconnected): connect ECONNREFUSED 127.0.0.1:3939',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('--all surfaces the recorded failure cause per server', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { httpUrl: 'http://127.0.0.1:3939/mcp' },
          },
        },
      });
      mockGetMCPServerStatus.mockReturnValue('disconnected');
      mockGetMCPServerLastError.mockReturnValue('HTTP 401 Unauthorized');

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✗ server-one: Failed - connection attempt finished without a live connection (status: disconnected): HTTP 401 Unauthorized',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe('skip-vs-failure reporting (issue #9944)', () => {
    // Discovery skips disabled / pending-approval / untrusted-folder servers
    // BEFORE any connection attempt, and the status registry defaults
    // never-seen servers to DISCONNECTED. Reporting those as failed
    // connection attempts would send debugging in the wrong direction —
    // the client never tried to connect.
    it.each([
      ['disabled', 'isMcpServerDisabled', 'server is disabled in settings'],
      [
        'pending approval',
        'isMcpServerPendingApproval',
        'server is pending approval (.mcp.json)',
      ],
    ] as const)(
      'reports a %s server as skipped instead of a failed connection',
      async (_label, predicate, reason) => {
        mockedLoadSettings.mockReturnValue({
          merged: {
            mcpServers: {
              'test-server': { command: '/path/to/server' },
            },
          },
        });
        mockGetMCPServerStatus.mockReturnValue('disconnected');
        mockConfig[predicate].mockReturnValue(true);

        const handler = reconnectCommand.handler as (
          argv: Record<string, unknown>,
        ) => Promise<void>;
        await handler({ 'server-name': 'test-server', all: false });

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          `Failed to reconnect to server "test-server": no connection attempt was made: ${reason}`,
        );
        expect(mockProcessExit).toHaveBeenCalledWith(1);
      },
    );

    it('reports an untrusted workspace as the skip reason', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });
      mockGetMCPServerStatus.mockReturnValue('disconnected');
      mockConfig.isTrustedFolder.mockReturnValue(false);

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect to server "test-server": no connection attempt was made: workspace folder is not trusted',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('--all reports a deliberately skipped server without counting it as a failure', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { command: '/path/to/server1' },
            'server-two': { command: '/path/to/server2', scope: 'workspace' },
          },
        },
      });
      mockGetMCPServerStatus.mockImplementation((name: string) =>
        name === 'server-one' ? 'connected' : 'disconnected',
      );
      mockConfig.isMcpServerPendingApproval.mockImplementation(
        (name: string) => name === 'server-two',
      );

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✓ server-one: Reconnected successfully',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '- server-two: Skipped - server is pending approval (.mcp.json)',
      );
      // Nothing was attempted-and-failed: no failure summary, exit 0. A
      // wrapper running `qwen mcp reconnect --all || alert` must not alert
      // on an intentional skip.
      expect(mockWriteStderrLine).not.toHaveBeenCalled();
      expect(mockProcessExit).not.toHaveBeenCalled();
    });

    it('--all counts only attempted-and-failed servers when skips are present', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { command: '/path/to/server1' },
            'server-two': { command: '/path/to/server2', scope: 'workspace' },
          },
        },
      });
      mockGetMCPServerStatus.mockReturnValue('disconnected');
      mockConfig.isMcpServerPendingApproval.mockImplementation(
        (name: string) => name === 'server-two',
      );

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✗ server-one: Failed - connection attempt finished without a live connection (status: disconnected)',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '- server-two: Skipped - server is pending approval (.mcp.json)',
      );
      // 1 attempted-and-failed of 2 configured — the skip is not counted.
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect 1 of 2 configured server(s).',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('reports an excluded server with the mcp.excluded reason, not the disabled flag', async () => {
      // A real Config answers `isMcpServerDisabled` = true for an
      // `mcp.excluded` server, so pre-fix the skip was misattributed to a
      // per-server disabled flag that does not exist. The admission
      // classifier (`getMcpServerUnavailableReason`) must win.
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });
      mockGetMCPServerStatus.mockReturnValue('disconnected');
      mockConfig.getMcpServerUnavailableReason.mockReturnValue('excluded');
      mockConfig.isMcpServerDisabled.mockReturnValue(true);

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect to server "test-server": no connection attempt was made: server is excluded in settings (mcp.excluded)',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('reports an allow-list-blocked server as skipped instead of a failed connection', async () => {
      // A server the `mcp.allowed` list keeps out is a deliberate skip;
      // pre-fix it fell through every classifier branch and was reported
      // as a failed connection attempt (status: disconnected).
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });
      mockGetMCPServerStatus.mockReturnValue('disconnected');
      mockConfig.getMcpServerUnavailableReason.mockReturnValue('not_allowed');

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        'Failed to reconnect to server "test-server": no connection attempt was made: server is not in the mcp.allowed list',
      );
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it('--all reports an allow-list-blocked server as skipped without counting it as a failure', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { command: '/path/to/server1' },
            'server-two': { command: '/path/to/server2' },
          },
        },
      });
      mockGetMCPServerStatus.mockImplementation((name: string) =>
        name === 'server-one' ? 'connected' : 'disconnected',
      );
      mockConfig.getMcpServerUnavailableReason.mockImplementation(
        (name: string) => (name === 'server-two' ? 'not_allowed' : undefined),
      );

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✓ server-one: Reconnected successfully',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '- server-two: Skipped - server is not in the mcp.allowed list',
      );
      // An intentional skip must not count toward the failure total —
      // otherwise one allow-list-blocked server forces exit 1 forever.
      expect(mockWriteStderrLine).not.toHaveBeenCalled();
      expect(mockProcessExit).not.toHaveBeenCalled();
    });

    it('--all reports an excluded server as skipped without counting it as a failure', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'server-one': { command: '/path/to/server1' },
            'server-two': { command: '/path/to/server2' },
          },
        },
      });
      mockGetMCPServerStatus.mockImplementation((name: string) =>
        name === 'server-one' ? 'connected' : 'disconnected',
      );
      mockConfig.getMcpServerUnavailableReason.mockImplementation(
        (name: string) => (name === 'server-two' ? 'excluded' : undefined),
      );

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': undefined, all: true });

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '✓ server-one: Reconnected successfully',
      );
      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        '- server-two: Skipped - server is excluded in settings (mcp.excluded)',
      );
      expect(mockWriteStderrLine).not.toHaveBeenCalled();
      expect(mockProcessExit).not.toHaveBeenCalled();
    });
  });

  describe('workspace trust in the throwaway config (issue #9944)', () => {
    // createMinimalConfig must carry the real workspace trust state so the
    // untrusted-skip branch is reachable and consistent with a normal
    // session's discovery gate, which skips MCP servers in untrusted folders.
    it('passes an untrusted workspace to the reconnect config', async () => {
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

      expect(MockedConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          trustedFolder: false,
        }),
      );
    });

    it('defaults to trusted when workspace trust is undecided', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
        },
      });
      mockedIsWorkspaceTrusted.mockReturnValue({
        isTrusted: undefined,
        source: undefined,
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(MockedConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          trustedFolder: true,
        }),
      );
    });
  });

  describe('allow/exclude gates in the throwaway config (issue #9944)', () => {
    // The real session wires `mcp.allowed` / `mcp.excluded` from settings
    // into Config (loadCliConfig); without the same wiring here the command
    // would still reach a server the user disabled, or one kept off the
    // allow-list — connections a normal session would never attempt.
    it('passes the settings excluded list so excluded servers stay skipped', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
          mcp: {
            excluded: ['test-server'],
          },
        },
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(MockedConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          excludedMcpServers: ['test-server'],
        }),
      );
    });

    it('passes the settings allowed list so the allow-list is respected', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
          mcp: {
            allowed: ['other-server'],
          },
        },
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(MockedConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedMcpServers: ['other-server'],
        }),
      );
    });

    it('filters empty entries from both gates like the real session wiring', async () => {
      mockedLoadSettings.mockReturnValue({
        merged: {
          mcpServers: {
            'test-server': { command: '/path/to/server' },
          },
          mcp: {
            allowed: ['kept', ''],
            excluded: ['dropped', '', 'dropped'],
          },
        },
      });

      const handler = reconnectCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await handler({ 'server-name': 'test-server', all: false });

      expect(MockedConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedMcpServers: ['kept'],
          excludedMcpServers: ['dropped'],
        }),
      );
    });

    it('leaves both gates undefined when settings has no mcp lists', async () => {
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

      expect(MockedConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedMcpServers: undefined,
          excludedMcpServers: undefined,
        }),
      );
    });
  });
});
