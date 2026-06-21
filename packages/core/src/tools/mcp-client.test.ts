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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthProviderType,
  MCPServerConfig,
  type Config,
} from '../config/config.js';
import { GoogleCredentialProvider } from '../mcp/google-auth-provider.js';
import { MCPOAuthProvider } from '../mcp/oauth-provider.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  addMCPStatusChangeListener,
  createStreamableHttpCompatibilityFetch,
  createTransport,
  discoverPrompts,
  discoverResources,
  getAllMCPServerStatuses,
  getMCPServerStatus,
  hasNetworkTransport,
  isEnabled,
  listMcpPrompts,
  listMcpResources,
  MCPServerStatus,
  McpClient,
  populateMcpServerCommand,
  removeMCPServerStatus,
  removeMCPStatusChangeListener,
  updateMCPServerStatus,
} from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';

const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
const ORIGINAL_ENV = process.env;

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js');
vi.mock('@modelcontextprotocol/sdk/client/index.js');
vi.mock('@google/genai');
vi.mock('../mcp/oauth-provider.js');
vi.mock('../mcp/oauth-token-storage.js');
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));

/**
 * Minimal Config stub for the non-pool `discover()` path, which now reads
 * `cliConfig.getResourceRegistry()` to register discovered resources. The
 * returned registry just needs to accept `registerResource` without
 * throwing — these tests assert on the constructor-injected tool/prompt
 * registries, not the resource one.
 */
function cfgWithResources(): Config {
  return {
    getResourceRegistry: () => ({
      registerResource: vi.fn(),
      removeResourcesByServer: vi.fn(),
    }),
  } as unknown as Config;
}

describe('mcp-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
        getInstructions: vi.fn(),
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
      await client.discover(cfgWithResources());
      expect(mockedMcpToTool).toHaveBeenCalledOnce();
    });

    it('stores server instructions returned during initialization', async () => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getInstructions: vi.fn().mockReturnValue('Use concise replies.'),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );

      const client = new McpClient(
        'test-server',
        {
          command: 'test-command',
        },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        {} as PromptRegistry,
        {
          getDirectories: vi.fn().mockReturnValue([]),
        } as unknown as WorkspaceContext,
        false,
      );

      await client.connect();

      expect(client.getInstructions()).toBe('Use concise replies.');
    });

    it('readResource does not gate on the resources capability (lenient read)', async () => {
      // Regression guard for the discover/read parity bug: a server that
      // answers resources/read but under-declares the `resources` capability
      // must still be readable (matching the lenient `listMcpResources`).
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({}), // not declared
        request: vi.fn().mockResolvedValue({
          contents: [{ uri: 'res://doc', text: 'BODY' }],
        }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      const client = new McpClient(
        'srv',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      const result = await client.readResource('res://doc');
      expect(mockedClient.request).toHaveBeenCalledWith(
        { method: 'resources/read', params: { uri: 'res://doc' } },
        expect.anything(),
        undefined,
      );
      expect((result.contents[0] as { text: string }).text).toBe('BODY');
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
        getInstructions: vi.fn(),
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
      await client.discover(cfgWithResources());
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
        getInstructions: vi.fn(),
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
      await expect(client.discover(cfgWithResources())).rejects.toThrow(
        'No prompts, tools, or resources found on the server.',
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
        getInstructions: vi.fn(),
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

      await expect(client.discover(cfgWithResources())).rejects.toThrow();

      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.DISCONNECTED);
    });

    it('discoverAndReturn returns tools and prompts WITHOUT registering them', async () => {
      // F2 (#4175) pool path: a single shared McpClient produces this
      // snapshot once; per-session SessionMcpView instances each register
      // a filtered copy. The bare method must therefore NOT touch any
      // registry — otherwise sharing a snapshot across sessions would
      // double-register or cross-contaminate.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({
          prompts: [{ name: 'pure-prompt', description: 'p' }],
        }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
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
            functionDeclarations: [{ name: 'pure-tool' }],
          }),
      } as unknown as GenAiLib.CallableTool);
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const promptRegistry = {
        registerPrompt: vi.fn(),
      } as unknown as PromptRegistry;
      const client = new McpClient(
        'pure-server',
        { command: 'test-command' },
        toolRegistry,
        promptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      const snapshot = await client.discoverAndReturn(cfgWithResources());

      expect(snapshot.tools).toHaveLength(1);
      expect(snapshot.tools[0].serverToolName).toBe('pure-tool');
      expect(snapshot.prompts).toHaveLength(1);
      expect(snapshot.prompts[0].name).toBe('pure-prompt');
      expect(snapshot.prompts[0].serverName).toBe('pure-server');
      expect(typeof snapshot.prompts[0].invoke).toBe('function');
      // The critical assertion: registries untouched.
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
      expect(promptRegistry.registerPrompt).not.toHaveBeenCalled();
    });

    it('discoverAndReturn with { applyConfigFilters: false } ignores config filters and trust for shared pool snapshots', async () => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
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
              { name: 'allowed' },
              { name: 'filtered_out' },
            ],
          }),
      } as unknown as GenAiLib.CallableTool);
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const client = new McpClient(
        'pure-filter-server',
        new MCPServerConfig(
          'test-command',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          ['allowed'],
          ['filtered_out'],
        ),
        toolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      // R23 T1: pool callers explicitly opt out of filters via the
      // `applyConfigFilters: false` opts argument. Default
      // `discoverAndReturn(cliConfig)` (no opts) applies filters,
      // matching the legacy `discover()` semantics expected by
      // non-pool consumers.
      const snapshot = await client.discoverAndReturn(cfgWithResources(), {
        applyConfigFilters: false,
      });

      expect(snapshot.tools.map((tool) => tool.serverToolName)).toEqual([
        'allowed',
        'filtered_out',
      ]);
      expect(snapshot.tools.every((tool) => tool.trust === undefined)).toBe(
        true,
      );
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
    });

    it('discoverAndReturn (default) applies config filters and trust — legacy non-pool callers (R23 T1)', async () => {
      // R23 T1 regression: pre-fix `discoverAndReturn` hardcoded
      // `{ applyConfigFilters: false }`, so legacy `discover()`
      // (which delegates here) silently lost filtering and trust.
      // Operators with `trust: true` saw unexpected permission
      // prompts, and `excludeTools` was ignored.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
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
              { name: 'allowed' },
              { name: 'filtered_out' },
            ],
          }),
      } as unknown as GenAiLib.CallableTool);
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const client = new McpClient(
        'legacy-filter-server',
        new MCPServerConfig(
          'test-command',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          ['allowed'],
          ['filtered_out'],
        ),
        toolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      // No opts → default applyConfigFilters=true → filters applied.
      const snapshot = await client.discoverAndReturn(cfgWithResources());

      // `excludeTools: ['filtered_out']` excludes the second tool;
      // `includeTools: ['allowed']` keeps the first.
      expect(snapshot.tools.map((tool) => tool.serverToolName)).toEqual([
        'allowed',
      ]);
      // `trust: true` config → tools carry trust=true (pre-fix this
      // was always undefined because discoverAndReturn forced
      // applyConfigFilters=false).
      expect(snapshot.tools[0].trust).toBe(true);
    });

    it('discoverAndReturn throws "No prompts or tools found" when both empty', async () => {
      // Preserves the discover() pre-F2 invariant — the wrapping
      // McpClientManager / pool entry uses this signal to mark the
      // entry as failed (vs "server up, just empty").
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({ prompts: [] }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
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
      // Forward defense (per code-reviewer P2.4): also assert registries
      // were NOT touched even on the throw path. Catches a future
      // refactor in commits 2-6 that accidentally registers a partial
      // batch before the "no prompts or tools" guard fires.
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const promptRegistry = {
        registerPrompt: vi.fn(),
      } as unknown as PromptRegistry;
      const client = new McpClient(
        'empty-server',
        { command: 'test-command' },
        toolRegistry,
        promptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await expect(
        client.discoverAndReturn(cfgWithResources()),
      ).rejects.toThrow('No prompts, tools, or resources found on the server.');
      // Status flipped to DISCONNECTED (same as discover() path).
      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      // Registries strictly untouched even on throw — pure method invariant.
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
      expect(promptRegistry.registerPrompt).not.toHaveBeenCalled();
    });

    it('discoverAndReturn throws when called before connect()', async () => {
      const client = new McpClient(
        'unconnected-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      // Status starts DISCONNECTED; discoverAndReturn must reject without
      // hitting the network.
      await expect(
        client.discoverAndReturn(cfgWithResources()),
      ).rejects.toThrow('Client is not connected.');
    });

    it('discover() delegates to discoverAndReturn and registers both tools and prompts', async () => {
      // Backward-compat sanity: the historical discover() entry point
      // still produces side effects in BOTH registries. Previously
      // prompt registration was a side effect inside discoverPrompts;
      // post-F2-1 it is an explicit step in discover() after
      // discoverAndReturn returns.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({
          prompts: [{ name: 'p1' }, { name: 'p2' }],
        }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
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
            functionDeclarations: [{ name: 't1' }],
          }),
      } as unknown as GenAiLib.CallableTool);
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const promptRegistry = {
        registerPrompt: vi.fn(),
      } as unknown as PromptRegistry;
      const client = new McpClient(
        'compat-server',
        { command: 'test-command' },
        toolRegistry,
        promptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover(cfgWithResources());
      expect(toolRegistry.registerTool).toHaveBeenCalledTimes(1);
      expect(promptRegistry.registerPrompt).toHaveBeenCalledTimes(2);
    });

    it('discover() registers discovered resources into the Config ResourceRegistry', async () => {
      const registerResource = vi.fn();
      const removeResourcesByServer = vi.fn();
      const cfg = {
        getResourceRegistry: () => ({
          registerResource,
          removeResourcesByServer,
        }),
      } as unknown as Config;
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi
          .fn()
          .mockImplementation((req: { method?: string }) =>
            req.method === 'resources/list'
              ? Promise.resolve({ resources: [{ uri: 'res://a', name: 'a' }] })
              : Promise.resolve({ prompts: [] }),
          ),
        getInstructions: vi.fn(),
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
        'srv',
        { command: 'test-command' },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        { registerPrompt: vi.fn() } as unknown as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover(cfg);
      // Clear-then-register so re-discovery (reconnect) is idempotent and a
      // dropped resource doesn't linger.
      expect(removeResourcesByServer).toHaveBeenCalledWith('srv');
      expect(registerResource).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'res://a', serverName: 'srv' }),
      );
    });

    it('discover() does NOT clear resources when the list returns empty (transient-failure guard)', async () => {
      // listMcpResources swallows a transient resources/list failure to [].
      // With tools present (discovery still succeeds), an empty resource list
      // must NOT wipe the registry.
      const registerResource = vi.fn();
      const removeResourcesByServer = vi.fn();
      const cfg = {
        getResourceRegistry: () => ({
          registerResource,
          removeResourcesByServer,
        }),
      } as unknown as Config;
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockResolvedValue({ resources: [], prompts: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      // A tool exists so discovery does not fail with "no prompts/tools/resources".
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [{ name: 't1' }] }),
      } as unknown as GenAiLib.CallableTool);
      const client = new McpClient(
        'srv',
        { command: 'test-command' },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        { registerPrompt: vi.fn() } as unknown as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover(cfg);
      expect(removeResourcesByServer).not.toHaveBeenCalled();
      expect(registerResource).not.toHaveBeenCalled();
    });

    it('discoverAndReturn connects a resource-only server (does not throw)', async () => {
      // The failed-discovery guard now counts resources: a server exposing
      // only resources (no tools/prompts) is a successful discovery.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi
          .fn()
          .mockImplementation((req: { method?: string }) =>
            req.method === 'resources/list'
              ? Promise.resolve({ resources: [{ uri: 'res://a', name: 'a' }] })
              : Promise.resolve({ prompts: [] }),
          ),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
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
        'srv',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      const snap = await client.discoverAndReturn(cfgWithResources());
      expect(snap.resources).toHaveLength(1);
      expect(snap.tools).toHaveLength(0);
      expect(snap.prompts).toHaveLength(0);
    });
  });

  describe('listMcpPrompts (F2 pure helper)', () => {
    it('returns enriched DiscoveredMCPPrompt[] with serverName + bound invoke', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({
          prompts: [
            { name: 'greet', description: 'Greet a user' },
            { name: 'farewell' },
          ],
        }),
      } as unknown as ClientLib.Client;

      const result = await listMcpPrompts('my-server', mockClient);
      expect(result).toHaveLength(2);
      expect(result[0].serverName).toBe('my-server');
      expect(result[0].name).toBe('greet');
      expect(typeof result[0].invoke).toBe('function');
      expect(result[1].name).toBe('farewell');
    });

    it('attempts prompts/list even when the prompts capability is undeclared (lenient)', async () => {
      // Regression guard: pre-fix this returned [] WITHOUT a request when
      // `capabilities.prompts` was absent, hiding prompts from servers that
      // under-declare the capability. We now always attempt the call.
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({}),
        request: vi
          .fn()
          .mockRejectedValue(new Error('MCP error -32601: Method not found')),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('no-prompts', mockClient);
      expect(result).toEqual([]);
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(1);
    });

    it('lists prompts from a server that omits the prompts capability but still answers', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({}),
        request: vi.fn().mockResolvedValue({
          prompts: [{ name: 'greet' }],
        }),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('under-declared', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('greet');
      expect(result[0].serverName).toBe('under-declared');
    });

    it('returns [] on protocol error (server up but list call rejects)', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('flaky', mockClient);
      expect(result).toEqual([]);
    });
  });

  describe('listMcpResources', () => {
    it('returns enriched DiscoveredMCPResource[] with serverName', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockResolvedValue({
          resources: [
            { uri: 'file:///a.txt', name: 'a' },
            { uri: 'file:///b.txt', name: 'b', mimeType: 'text/plain' },
          ],
        }),
      } as unknown as ClientLib.Client;

      const result = await listMcpResources('my-server', mockClient);
      expect(result).toHaveLength(2);
      expect(result[0].serverName).toBe('my-server');
      expect(result[0].uri).toBe('file:///a.txt');
      expect(result[1].mimeType).toBe('text/plain');
      // Resources carry no bound invoke (unlike prompts).
      expect((result[0] as Record<string, unknown>)['invoke']).toBeUndefined();
    });

    it('attempts resources/list even when the resources capability is undeclared (lenient)', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({}),
        request: vi
          .fn()
          .mockRejectedValue(new Error('MCP error -32601: Method not found')),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('no-resources', mockClient);
      expect(result).toEqual([]);
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(1);
    });

    it('returns [] on protocol error (server up but list call rejects)', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('flaky', mockClient);
      expect(result).toEqual([]);
    });

    it('treats JSON-RPC code -32601 as method-absent even when the message differs (no error logged)', async () => {
      // A spec-compliant server signals an unimplemented method by the
      // numeric code; the message text is not guaranteed (it may be
      // localized or worded "Method not implemented"). It must not be
      // logged as an error.
      const err = Object.assign(new Error('Método no implementado'), {
        code: -32601,
      });
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({}),
        request: vi.fn().mockRejectedValue(err),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('localized', mockClient);
      expect(result).toEqual([]);
      expect(mockDebugLogger.error).not.toHaveBeenCalled();
    });

    it('logs genuinely unexpected errors (not method-absent)', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockRejectedValue(new Error('connection reset')),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('broken', mockClient);
      expect(result).toEqual([]);
      expect(mockDebugLogger.error).toHaveBeenCalled();
    });
  });

  describe('discoverResources wrapper', () => {
    it('registers discovered resources into the supplied ResourceRegistry', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///x.txt', name: 'x' }],
        }),
      } as unknown as ClientLib.Client;
      const resourceRegistry = {
        registerResource: vi.fn(),
      } as unknown as ResourceRegistry;
      const out = await discoverResources(
        'wrapper-server',
        mockClient,
        resourceRegistry,
      );
      expect(resourceRegistry.registerResource).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(1);
      expect(out[0].uri).toBe('file:///x.txt');
      expect(out[0].serverName).toBe('wrapper-server');
    });
  });

  describe('discoverPrompts wrapper (backward compat after F2-1 split)', () => {
    it('still registers prompts into the supplied PromptRegistry', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({
          prompts: [{ name: 'register-me' }],
        }),
      } as unknown as ClientLib.Client;
      const promptRegistry = {
        registerPrompt: vi.fn(),
      } as unknown as PromptRegistry;
      const out = await discoverPrompts(
        'wrapper-server',
        mockClient,
        promptRegistry,
      );
      expect(promptRegistry.registerPrompt).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('register-me');
      // Historical contract: return type strips serverName/invoke.
      expect((out[0] as Record<string, unknown>)['serverName']).toBeUndefined();
      expect((out[0] as Record<string, unknown>)['invoke']).toBeUndefined();
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._fetch).toEqual(expect.any(Function));
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._fetch).toEqual(expect.any(Function));
      });

      it('treats 400 from optional GET SSE stream as unsupported', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('bad method', { status: 400 }));
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'spring-ai',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        });

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(405);
        expect(response.statusText).toBe('Method Not Allowed');
        expect(await response.text()).toBe('');
      });

      it('omits response body diagnostics when the fallback body is empty', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 400 }));
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'empty-body',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        });

        expect(response.status).toBe(405);
        expect(mockDebugLogger.warn).toHaveBeenCalledWith(
          expect.not.stringContaining('Response body:'),
        );
      });

      it('truncates Streamable HTTP GET SSE error body diagnostics', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('x'.repeat(1024), { status: 400 }));
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'large-error-body',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        });

        expect(response.status).toBe(405);
        expect(mockDebugLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `Response body: ${JSON.stringify(`${'x'.repeat(512)}...`)}`,
          ),
        );
        expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('x'.repeat(600)),
        );
      });

      it('treats parameterized GET SSE Accept headers as unsupported', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('bad method', { status: 400 }));
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'spring-ai',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'GET',
          headers: {
            Accept: 'application/json, text/event-stream; charset=utf-8',
          },
        });

        expect(response.status).toBe(405);
      });

      it('does not hide Streamable HTTP GET SSE server errors', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('server exploded', { status: 502 }));
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'server-error',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        });

        expect(response.status).toBe(502);
      });

      it('does not rewrite the SDK-native GET SSE unsupported sentinel', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('method not allowed', { status: 405 }),
          );
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'native-unsupported',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        });

        expect(response.status).toBe(405);
        expect(await response.text()).toBe('method not allowed');
      });

      it('does not rewrite resumable GET SSE errors with Last-Event-ID', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('{"error":"invalid cursor"}', { status: 400 }),
          );
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'resume-error',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            'Last-Event-ID': 'event-123',
          },
        });

        expect(response.status).toBe(400);
        expect(await response.text()).toBe('{"error":"invalid cursor"}');
      });

      it('does not rewrite non-SSE GET responses', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('bad request', { status: 400 }));
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'plain-get',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        expect(response.status).toBe(400);
      });

      it('does not rewrite POST responses', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('bad request', { status: 400 }));
        const fetchWithFallback = createStreamableHttpCompatibilityFetch(
          'post-test',
          fetchFn,
        );

        const response = await fetchWithFallback('http://test-server/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        expect(response.status).toBe(400);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._fetch).toEqual(expect.any(Function));
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

    describe('authenticated Streamable HTTP compatibility fetch', () => {
      it('wires the compatibility fetch for OAuth httpUrl transports', async () => {
        const getValidToken = vi.fn().mockResolvedValue('oauth-token');
        vi.mocked(MCPOAuthProvider).mockImplementation(
          () =>
            ({
              getValidToken,
            }) as unknown as MCPOAuthProvider,
        );

        const transport = await createTransport(
          'oauth-test-server',
          {
            httpUrl: 'http://test-server',
            oauth: {
              enabled: true,
              clientId: 'client-id',
            },
          },
          false,
        );

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(getValidToken).toHaveBeenCalledWith('oauth-test-server', {
          enabled: true,
          clientId: 'client-id',
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._fetch).toEqual(expect.any(Function));
      });

      it('wires the compatibility fetch for service account httpUrl transports', async () => {
        const transport = await createTransport(
          'service-account-test-server',
          {
            httpUrl: 'http://test-server',
            authProviderType: AuthProviderType.SERVICE_ACCOUNT_IMPERSONATION,
            targetAudience: 'client.apps.googleusercontent.com',
            targetServiceAccount:
              'service-account@example-project.iam.gserviceaccount.com',
          },
          false,
        );

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((transport as any)._fetch).toEqual(expect.any(Function));
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
        getInstructions: vi.fn(),
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
        getInstructions: vi.fn(),
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
