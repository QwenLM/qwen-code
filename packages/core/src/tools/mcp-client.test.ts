/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as GenAiLib from '@google/genai';
import * as ClientLib from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import * as SdkClientStdioLib from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProviderType, type Config } from '../config/config.js';
import { GoogleCredentialProvider } from '../mcp/google-auth-provider.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  addMCPStatusChangeListener,
  createTransport,
  getAllMCPServerStatuses,
  getMCPServerStatus,
  hasNetworkTransport,
  isEnabled,
  MCPServerStatus,
  McpClient,
  populateMcpServerCommand,
  removeMCPServerStatus,
  removeMCPStatusChangeListener,
  updateMCPServerStatus,
} from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';

const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
const ORIGINAL_ENV = process.env;

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js');
vi.mock('@modelcontextprotocol/sdk/client/index.js');
vi.mock('@google/genai');
vi.mock('../mcp/oauth-provider.js');
vi.mock('../mcp/oauth-token-storage.js');

describe('mcp-client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = ORIGINAL_ENV;
  });

  describe('McpClient', () => {
    it('should discover tools', async () => {
      const mockedClient = {
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      const mockedMcpToTool = vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => ({
          functionDeclarations: [
            {
              name: 'testFunction',
            },
          ],
        }),
      } as unknown as GenAiLib.CallableTool);
      const mockedToolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const client = new McpClient(
        'test-server',
        {
          command: 'test-command',
        },
        mockedToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover({} as Config);
      expect(mockedMcpToTool).toHaveBeenCalledOnce();
    });

    it('should not skip tools even if a parameter is missing a type', async () => {
      const mockedClient = {
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        tool: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [
              {
                name: 'validTool',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {
                    param1: { type: 'string' },
                  },
                },
              },
              {
                name: 'invalidTool',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {
                    param1: { description: 'a param with no type' },
                  },
                },
              },
            ],
          }),
      } as unknown as GenAiLib.CallableTool);
      const mockedToolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const client = new McpClient(
        'test-server',
        {
          command: 'test-command',
        },
        mockedToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover({} as Config);
      expect(mockedToolRegistry.registerTool).toHaveBeenCalledTimes(2);
    });

    it('should handle errors when discovering prompts', async () => {
      const mockedClient = {
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('Test error')),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [] }),
      } as unknown as GenAiLib.CallableTool);
      const client = new McpClient(
        'test-server',
        {
          command: 'test-command',
        },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await expect(client.discover({} as Config)).rejects.toThrow(
        'No prompts or tools found on the server.',
      );
    });

    it('flips status to DISCONNECTED when discover() throws', async () => {
      // `Config.getFailedMcpServerNames()` filters by
      // `status !== CONNECTED`, so a server that connects successfully
      // but whose `discover()` then crashes (e.g. tools/list rejects, or
      // the "no prompts or tools found" guard fires) must be marked
      // DISCONNECTED before the error propagates. Without this, the
      // server stays CONNECTED in the global registry, the non-interactive
      // failure banner silently omits it, and the Footer's MCP health
      // pill keeps counting it as healthy.
      const mockedClient = {
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('tools/list crashed')),
        close: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [] }),
      } as unknown as GenAiLib.CallableTool);
      const serverName = `discover-error-${Date.now()}`;
      const client = new McpClient(
        serverName,
        {
          command: 'test-command',
        },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      // Sanity: connect succeeded so the status is CONNECTED before the
      // discover failure we're about to assert against.
      expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);

      await expect(client.discover({} as Config)).rejects.toThrow();

      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.DISCONNECTED);
    });
  });
  describe('appendMcpServerCommand', () => {
    it('should do nothing if no MCP servers or command are configured', () => {
      const out = populateMcpServerCommand({}, undefined);
      expect(out).toEqual({});
    });

    it('should discover tools via mcpServerCommand', () => {
      const commandString = 'command --arg1 value1';
      const out = populateMcpServerCommand({}, commandString);
      expect(out).toEqual({
        mcp: {
          command: 'command',
          args: ['--arg1', 'value1'],
        },
      });
    });

    it('should handle error if mcpServerCommand parsing fails', () => {
      expect(() => populateMcpServerCommand({}, 'derp && herp')).toThrowError();
    });
  });

  describe('createTransport', () => {
    describe('should connect via httpUrl', () => {
      it('without headers', async () => {
        const transport = await createTransport(
          'test-server',
          {
            httpUrl: 'http://test-server',
          },
          false,
        );

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._url).toEqual(new URL('http://test-server'));
      });

      it('with headers', async () => {
        const transport = await createTransport(
          'test-server',
          {
            httpUrl: 'http://test-server',
            headers: { Authorization: 'derp' },
          },
          false,
        );

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._url).toEqual(new URL('http://test-server'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._requestInit?.headers).toEqual({
          Authorization: 'derp',
        });
      });
    });

    describe('should connect via url', () => {
      it('without headers', async () => {
        const transport = await createTransport(
          'test-server',
          {
            url: 'http://test-server',
          },
          false,
        );
        expect(transport).toBeInstanceOf(SSEClientTransport);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._url).toEqual(new URL('http://test-server'));
      });

      it('with headers', async () => {
        const transport = await createTransport(
          'test-server',
          {
            url: 'http://test-server',
            headers: { Authorization: 'derp' },
          },
          false,
        );

        expect(transport).toBeInstanceOf(SSEClientTransport);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._url).toEqual(new URL('http://test-server'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._requestInit?.headers).toEqual({
          Authorization: 'derp',
        });
      });
    });

    it('should connect via command', async () => {
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport(
        'test-server',
        {
          command: 'test-command',
          args: ['--foo', 'bar'],
          env: { FOO: 'bar' },
          cwd: 'test/cwd',
        },
        false,
      );

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: ['--foo', 'bar'],
        cwd: 'test/cwd',
        // Use objectContaining because normalizePathEnvForWindows deduplicates
        // PATH entries on Windows, so the env won't be an exact spread match.
        env: expect.objectContaining({ FOO: 'bar' }),
        stderr: 'pipe',
      });
    });

    it('should normalize PATH-like env keys on Windows for stdio transport', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      process.env = {
        ...ORIGINAL_ENV,
        PATH: 'C:\\Windows\\System32;C:\\Shared\\Tools',
        Path: 'C:\\Users\\tester\\bin;C:\\Shared\\Tools',
      };
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport(
        'test-server',
        {
          command: 'test-command',
          env: { FOO: 'bar' },
        },
        false,
      );

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: [],
        cwd: undefined,
        env: expect.objectContaining({
          PATH: 'C:\\Windows\\System32;C:\\Shared\\Tools;C:\\Users\\tester\\bin',
          FOO: 'bar',
        }),
        stderr: 'pipe',
      });
      const transportOptions = mockedTransport.mock.calls[0]?.[0];
      expect(transportOptions?.env?.['Path']).toBeUndefined();
    });

    it('should let server config PATH override parent PATH on Windows', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      process.env = {
        ...ORIGINAL_ENV,
        PATH: 'C:\\Windows\\System32;C:\\Shared\\Tools',
        Path: 'C:\\Users\\tester\\bin;C:\\Shared\\Tools',
      };
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport(
        'test-server',
        {
          command: 'test-command',
          env: { PATH: 'C:\\ServerToolchain\\bin' },
        },
        false,
      );

      const transportOptions = mockedTransport.mock.calls[0]?.[0];
      // Server-provided PATH should fully replace the parent PATH, not merge
      expect(transportOptions?.env?.['PATH']).toBe('C:\\ServerToolchain\\bin');
      expect(transportOptions?.env?.['Path']).toBeUndefined();
    });

    it('should connect via command without cwd', async () => {
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport(
        'test-server',
        {
          command: 'test-command',
          args: ['--foo', 'bar'],
        },
        false,
      );

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: ['--foo', 'bar'],
        cwd: undefined,
        env: expect.any(Object),
        stderr: 'pipe',
      });
    });

    it('should throw if cwd does not exist', async () => {
      mockExistsSync.mockReturnValueOnce(false);

      await expect(
        createTransport(
          'test-server',
          {
            command: 'test-command',
            cwd: '/nonexistent/path',
          },
          false,
        ),
      ).rejects.toThrow(
        "MCP server 'test-server': configured cwd does not exist: /nonexistent/path",
      );
    });

    describe('useGoogleCredentialProvider', () => {
      it('should use GoogleCredentialProvider when specified', async () => {
        const transport = await createTransport(
          'test-server',
          {
            httpUrl: 'http://test.googleapis.com',
            authProviderType: AuthProviderType.GOOGLE_CREDENTIALS,
            oauth: {
              scopes: ['scope1'],
            },
          },
          false,
        );

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const authProvider = (transport as any)._authProvider;
        expect(authProvider).toBeInstanceOf(GoogleCredentialProvider);
      });

      it('should use GoogleCredentialProvider with SSE transport', async () => {
        const transport = await createTransport(
          'test-server',
          {
            url: 'http://test.googleapis.com',
            authProviderType: AuthProviderType.GOOGLE_CREDENTIALS,
            oauth: {
              scopes: ['scope1'],
            },
          },
          false,
        );

        expect(transport).toBeInstanceOf(SSEClientTransport);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const authProvider = (transport as any)._authProvider;
        expect(authProvider).toBeInstanceOf(GoogleCredentialProvider);
      });

      it('should throw an error if no URL is provided with GoogleCredentialProvider', async () => {
        await expect(
          createTransport(
            'test-server',
            {
              authProviderType: AuthProviderType.GOOGLE_CREDENTIALS,
              oauth: {
                scopes: ['scope1'],
              },
            },
            false,
          ),
        ).rejects.toThrow(
          'URL must be provided in the config for Google Credentials provider',
        );
      });
    });
  });
  describe('isEnabled', () => {
    const funcDecl = { name: 'myTool' };
    const serverName = 'myServer';

    it('should return true if no include or exclude lists are provided', () => {
      const mcpServerConfig = {};
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(true);
    });

    it('should return false if the tool is in the exclude list', () => {
      const mcpServerConfig = { excludeTools: ['myTool'] };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(false);
    });

    it('should return true if the tool is in the include list', () => {
      const mcpServerConfig = { includeTools: ['myTool'] };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(true);
    });

    it('should return true if the tool is in the include list with parentheses', () => {
      const mcpServerConfig = { includeTools: ['myTool()'] };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(true);
    });

    it('should return false if the include list exists but does not contain the tool', () => {
      const mcpServerConfig = { includeTools: ['anotherTool'] };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(false);
    });

    it('should return false if the tool is in both the include and exclude lists', () => {
      const mcpServerConfig = {
        includeTools: ['myTool'],
        excludeTools: ['myTool'],
      };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(false);
    });

    it('should return false if the function declaration has no name', () => {
      const namelessFuncDecl = {};
      const mcpServerConfig = {};
      expect(isEnabled(namelessFuncDecl, serverName, mcpServerConfig)).toBe(
        false,
      );
    });
  });

  describe('removeMCPServerStatus', () => {
    afterEach(() => {
      // Clean up any state left in the module-level registry between tests.
      for (const name of getAllMCPServerStatuses().keys()) {
        removeMCPServerStatus(name);
      }
    });

    it('removes the entry from the global status map', () => {
      updateMCPServerStatus('srv-a', MCPServerStatus.DISCONNECTED);
      expect(getAllMCPServerStatuses().has('srv-a')).toBe(true);

      removeMCPServerStatus('srv-a');

      expect(getAllMCPServerStatuses().has('srv-a')).toBe(false);
      // getMCPServerStatus falls back to DISCONNECTED for unknown servers,
      // but the snapshot map should no longer include the entry.
      expect(getMCPServerStatus('srv-a')).toBe(MCPServerStatus.DISCONNECTED);
    });

    it('notifies listeners with undefined to signal removal', () => {
      const events: Array<[string, MCPServerStatus | undefined]> = [];
      const listener = (name: string, status: MCPServerStatus | undefined) => {
        events.push([name, status]);
      };
      addMCPStatusChangeListener(listener);

      updateMCPServerStatus('srv-b', MCPServerStatus.CONNECTED);
      removeMCPServerStatus('srv-b');

      removeMCPStatusChangeListener(listener);

      expect(events).toEqual([
        ['srv-b', MCPServerStatus.CONNECTED],
        ['srv-b', undefined],
      ]);
    });

    it('is a no-op (no listener fired) when the server is not tracked', () => {
      const listener = vi.fn();
      addMCPStatusChangeListener(listener);

      removeMCPServerStatus('never-registered');

      removeMCPStatusChangeListener(listener);
      expect(listener).not.toHaveBeenCalled();
    });

    it('a stale status update from an in-flight connect cannot resurrect a removed server', async () => {
      // Race scenario from PR review: `disableMcpServer` removes the entry,
      // but `McpClient.connect()`'s catch block could still fire afterwards
      // and call `updateStatus(DISCONNECTED)`. The `isDisconnecting` guard
      // inside `McpClient.updateStatus` must prevent that resurrection.
      const mockedClient = {
        connect: vi.fn().mockRejectedValue(new Error('connect failed')),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        close: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue({
        close: vi.fn(),
      } as unknown as SdkClientStdioLib.StdioClientTransport);

      const client = new McpClient(
        'racy-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );

      // Kick off connect() but don't await it; it will reject and run its
      // catch block which calls updateStatus(DISCONNECTED).
      const connectPromise = client.connect();

      // Simulate the disable path running before connect's catch fires.
      await client.disconnect();
      removeMCPServerStatus('racy-server');

      // Now let the rejected connect propagate.
      await expect(connectPromise).rejects.toThrow('connect failed');

      // The entry must remain absent — no resurrection.
      expect(getAllMCPServerStatuses().has('racy-server')).toBe(false);
    });

    it('disconnect() propagates DISCONNECTED to the global registry', async () => {
      // Regression: a previous version set `isDisconnecting = true` BEFORE
      // calling `updateStatus(DISCONNECTED)`, and `updateStatus`'s guard
      // (designed to block stale `connect()` catch updates) silently
      // swallowed the write. The global registry stayed CONNECTED forever,
      // so `Config.getFailedMcpServerNames()` (which filters
      // `status !== CONNECTED`) omitted timeout-disconnected servers from
      // the non-interactive failure banner and the Footer's MCP health
      // pill kept counting them as healthy.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        close: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      const mockedTransport = { close: vi.fn().mockResolvedValue(undefined) };
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        mockedTransport as unknown as SdkClientStdioLib.StdioClientTransport,
      );

      const client = new McpClient(
        'healthy-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        { getDirectories: () => [] } as unknown as WorkspaceContext,
        false,
      );

      await client.connect();
      // After connect, the registry should show CONNECTED.
      expect(getMCPServerStatus('healthy-server')).toBe(
        MCPServerStatus.CONNECTED,
      );

      await client.disconnect();
      // After an intentional disconnect, the global registry MUST reflect
      // DISCONNECTED — otherwise downstream code (failure banner, health
      // pill) treats the server as still healthy.
      expect(getMCPServerStatus('healthy-server')).toBe(
        MCPServerStatus.DISCONNECTED,
      );

      // Cleanup the registry entry so this test doesn't leak.
      removeMCPServerStatus('healthy-server');
    });
  });

  describe('hasNetworkTransport', () => {
    it('should return true if only url is provided', () => {
      const config = { url: 'http://example.com' };
      expect(hasNetworkTransport(config)).toBe(true);
    });

    it('should return true if only httpUrl is provided', () => {
      const config = { httpUrl: 'http://example.com' };
      expect(hasNetworkTransport(config)).toBe(true);
    });

    it('should return true if both url and httpUrl are provided', () => {
      const config = {
        url: 'http://example.com/sse',
        httpUrl: 'http://example.com/http',
      };
      expect(hasNetworkTransport(config)).toBe(true);
    });

    it('should return false if neither url nor httpUrl is provided', () => {
      const config = { command: 'do-something' };
      expect(hasNetworkTransport(config)).toBe(false);
    });

    it('should return false for an empty config object', () => {
      const config = {};
      expect(hasNetworkTransport(config)).toBe(false);
    });
  });
});
