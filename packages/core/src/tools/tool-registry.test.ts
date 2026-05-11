/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Mocked } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConfigParameters } from '../config/config.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ToolRegistry, DiscoveredTool } from './tool-registry.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import type { FunctionDeclaration, CallableTool } from '@google/genai';
import { mcpToTool } from '@google/genai';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { MockTool } from '../test-utils/mock-tool.js';

import { McpClientManager } from './mcp-client-manager.js';
import {
  getAllMCPServerStatuses,
  MCPServerStatus,
  removeMCPServerStatus,
  updateMCPServerStatus,
} from './mcp-client.js';
import { ToolErrorType } from './tool-error.js';

vi.mock('node:fs');

// Mock ./mcp-client.js to control its behavior within tool-registry tests
vi.mock('./mcp-client.js', async () => {
  const originalModule = await vi.importActual('./mcp-client.js');
  return {
    ...originalModule,
  };
});

// Mock node:child_process
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    spawn: vi.fn(),
  };
});

// Mock MCP SDK Client and Transports
const mockMcpClientConnect = vi.fn();
const mockMcpClientOnError = vi.fn();
const mockStdioTransportClose = vi.fn();
const mockSseTransportClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const MockClient = vi.fn().mockImplementation(() => ({
    connect: mockMcpClientConnect,
    set onerror(handler: any) {
      mockMcpClientOnError(handler);
    },
  }));
  return { Client: MockClient };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  const MockStdioClientTransport = vi.fn().mockImplementation(() => ({
    stderr: {
      on: vi.fn(),
    },
    close: mockStdioTransportClose,
  }));
  return { StdioClientTransport: MockStdioClientTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  const MockSSEClientTransport = vi.fn().mockImplementation(() => ({
    close: mockSseTransportClose,
  }));
  return { SSEClientTransport: MockSSEClientTransport };
});

// Mock @google/genai mcpToTool
vi.mock('@google/genai', async () => {
  const actualGenai =
    await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    ...actualGenai,
    mcpToTool: vi.fn().mockImplementation(() => ({
      tool: vi.fn().mockResolvedValue({ functionDeclarations: [] }),
      callTool: vi.fn(),
    })),
  };
});

// Helper to create a mock CallableTool for specific test needs
const createMockCallableTool = (
  toolDeclarations: FunctionDeclaration[],
): Mocked<CallableTool> => ({
  tool: vi.fn().mockResolvedValue({ functionDeclarations: toolDeclarations }),
  callTool: vi.fn(),
});

const baseConfigParams: ConfigParameters = {
  cwd: '/tmp',
  model: 'test-model',
  embeddingModel: 'test-embedding-model',
  sandbox: undefined,
  targetDir: '/test/dir',
  debugMode: false,
  userMemory: '',
  geminiMdFileCount: 0,
  approvalMode: ApprovalMode.DEFAULT,
};

describe('ToolRegistry', () => {
  let config: Config;
  let toolRegistry: ToolRegistry;
  let mockConfigGetToolDiscoveryCommand: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats);
    config = new Config(baseConfigParams);
    toolRegistry = new ToolRegistry(config);

    mockMcpClientConnect.mockReset().mockResolvedValue(undefined);
    mockStdioTransportClose.mockReset();
    mockSseTransportClose.mockReset();
    vi.mocked(mcpToTool).mockClear();
    vi.mocked(mcpToTool).mockReturnValue(createMockCallableTool([]));

    mockConfigGetToolDiscoveryCommand = vi.spyOn(
      config,
      'getToolDiscoveryCommand',
    );
    vi.spyOn(config, 'getMcpServers');
    vi.spyOn(config, 'getMcpServerCommand');
    vi.spyOn(config, 'getPromptRegistry').mockReturnValue({
      clear: vi.fn(),
      removePromptsByServer: vi.fn(),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('registerTool', () => {
    it('should register a new tool', () => {
      const tool = new MockTool({ name: 'mock-tool' });
      toolRegistry.registerTool(tool);
      expect(toolRegistry.getTool('mock-tool')).toBe(tool);
    });
  });

  describe('getAllTools', () => {
    it('should return all registered tools sorted alphabetically by displayName', () => {
      // Register tools with displayNames in non-alphabetical order
      const toolC = new MockTool({ name: 'c-tool', displayName: 'Tool C' });
      const toolA = new MockTool({ name: 'a-tool', displayName: 'Tool A' });
      const toolB = new MockTool({ name: 'b-tool', displayName: 'Tool B' });

      toolRegistry.registerTool(toolC);
      toolRegistry.registerTool(toolA);
      toolRegistry.registerTool(toolB);

      const allTools = toolRegistry.getAllTools();
      const displayNames = allTools.map((t) => t.displayName);

      // Assert that the returned array is sorted by displayName
      expect(displayNames).toEqual(['Tool A', 'Tool B', 'Tool C']);
    });
  });

  describe('getAllToolNames', () => {
    it('should return all registered tool names', () => {
      // Register tools with displayNames in non-alphabetical order
      const toolC = new MockTool({ name: 'c-tool', displayName: 'Tool C' });
      const toolA = new MockTool({ name: 'a-tool', displayName: 'Tool A' });
      const toolB = new MockTool({ name: 'b-tool', displayName: 'Tool B' });

      toolRegistry.registerTool(toolC);
      toolRegistry.registerTool(toolA);
      toolRegistry.registerTool(toolB);

      const toolNames = toolRegistry.getAllToolNames();

      // Assert that the returned array contains all tool names
      expect(toolNames).toEqual(['c-tool', 'a-tool', 'b-tool']);
    });

    it('should include factory-registered tools that have not yet been loaded', () => {
      toolRegistry.registerTool(new MockTool({ name: 'loaded-tool' }));
      toolRegistry.registerFactory('lazy-tool', async () => {
        throw new Error('should not be called');
      });

      const names = toolRegistry.getAllToolNames();

      expect(names).toContain('loaded-tool');
      expect(names).toContain('lazy-tool');
    });
  });

  describe('deferred tool filtering', () => {
    it('excludes shouldDefer tools from getFunctionDeclarations by default', () => {
      toolRegistry.registerTool(new MockTool({ name: 'visible' }));
      toolRegistry.registerTool(
        new MockTool({ name: 'hidden', shouldDefer: true }),
      );

      const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);
      expect(names).toEqual(['visible']);
    });

    it('includes deferred tools when includeDeferred is true', () => {
      toolRegistry.registerTool(new MockTool({ name: 'visible' }));
      toolRegistry.registerTool(
        new MockTool({ name: 'hidden', shouldDefer: true }),
      );

      const names = toolRegistry
        .getFunctionDeclarations({ includeDeferred: true })
        .map((d) => d.name);
      expect(names).toEqual(expect.arrayContaining(['visible', 'hidden']));
      expect(names).toHaveLength(2);
    });

    it('always keeps alwaysLoad tools visible even when shouldDefer is true', () => {
      toolRegistry.registerTool(
        new MockTool({
          name: 'always-visible',
          shouldDefer: true,
          alwaysLoad: true,
        }),
      );

      const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);
      expect(names).toEqual(['always-visible']);
    });

    it('includes revealed deferred tools in getFunctionDeclarations', () => {
      toolRegistry.registerTool(
        new MockTool({ name: 'hidden', shouldDefer: true }),
      );
      toolRegistry.registerTool(
        new MockTool({ name: 'other-hidden', shouldDefer: true }),
      );

      toolRegistry.revealDeferredTool('hidden');

      const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);
      expect(names).toEqual(['hidden']);
      expect(toolRegistry.isDeferredToolRevealed('hidden')).toBe(true);
      expect(toolRegistry.isDeferredToolRevealed('other-hidden')).toBe(false);
    });

    it('getDeferredToolSummary lists deferred tools sorted by name', () => {
      toolRegistry.registerTool(new MockTool({ name: 'zebra' }));
      toolRegistry.registerTool(
        new MockTool({
          name: 'bravo',
          description: 'bravo desc',
          shouldDefer: true,
        }),
      );
      toolRegistry.registerTool(
        new MockTool({
          name: 'alpha',
          description: 'alpha desc',
          shouldDefer: true,
        }),
      );
      toolRegistry.registerTool(
        new MockTool({
          name: 'charlie',
          description: 'charlie desc',
          shouldDefer: true,
          alwaysLoad: true, // excluded from summary
        }),
      );

      const summary = toolRegistry.getDeferredToolSummary();
      expect(summary).toEqual([
        { name: 'alpha', description: 'alpha desc' },
        { name: 'bravo', description: 'bravo desc' },
      ]);
    });

    it('removeMcpToolsByServer also drops revealedDeferred entries', async () => {
      // Pin the regression: a server-disconnect-then-reconnect cycle that
      // re-registers a tool of the same name must NOT inherit
      // `revealed: true` from before the disconnect — that would leak
      // into `getFunctionDeclarations` before the model has any way to
      // know the tool exists this session.
      const mcpCallable = {} as CallableTool;
      const tool = new DiscoveredMCPTool(
        mcpCallable,
        'slack',
        'send_message',
        'send a message',
        {},
      );
      toolRegistry.registerTool(tool);
      // Use the actual generated tool name (mcp__slack__send_message) — the
      // reveal-state map is keyed by that, not the server-tool-name alone.
      const toolName = tool.name;
      toolRegistry.revealDeferredTool(toolName);
      expect(toolRegistry.isDeferredToolRevealed(toolName)).toBe(true);

      toolRegistry.removeMcpToolsByServer('slack');
      expect(toolRegistry.isDeferredToolRevealed(toolName)).toBe(false);
    });
  });

  describe('getToolsByServer', () => {
    it('should return an empty array if no tools match the server name', () => {
      toolRegistry.registerTool(new MockTool({ name: 'mock-tool' }));
      expect(toolRegistry.getToolsByServer('any-mcp-server')).toEqual([]);
    });

    it('should return only tools matching the server name, sorted by name', async () => {
      const server1Name = 'mcp-server-uno';
      const server2Name = 'mcp-server-dos';
      const mockCallable = {} as CallableTool;
      const mcpTool1_c = new DiscoveredMCPTool(
        mockCallable,
        server1Name,
        'zebra-tool',
        'd1',
        {},
      );
      const mcpTool1_a = new DiscoveredMCPTool(
        mockCallable,
        server1Name,
        'apple-tool',
        'd2',
        {},
      );
      const mcpTool1_b = new DiscoveredMCPTool(
        mockCallable,
        server1Name,
        'banana-tool',
        'd3',
        {},
      );

      const mcpTool2 = new DiscoveredMCPTool(
        mockCallable,
        server2Name,
        'tool-on-server2',
        'd4',
        {},
      );
      const nonMcpTool = new MockTool({ name: 'regular-tool' });

      toolRegistry.registerTool(mcpTool1_c);
      toolRegistry.registerTool(mcpTool1_a);
      toolRegistry.registerTool(mcpTool1_b);
      toolRegistry.registerTool(mcpTool2);
      toolRegistry.registerTool(nonMcpTool);

      const toolsFromServer1 = toolRegistry.getToolsByServer(server1Name);
      const toolNames = toolsFromServer1.map((t) => t.name);

      // Assert that the array has the correct tools and is sorted by name
      expect(toolsFromServer1).toHaveLength(3);
      expect(toolNames).toEqual([
        'mcp__mcp-server-uno__apple-tool',
        'mcp__mcp-server-uno__banana-tool',
        'mcp__mcp-server-uno__zebra-tool',
      ]);

      // Assert that all returned tools are indeed from the correct server
      for (const tool of toolsFromServer1) {
        expect((tool as DiscoveredMCPTool).serverName).toBe(server1Name);
      }

      // Assert that the other server's tools are returned correctly
      const toolsFromServer2 = toolRegistry.getToolsByServer(server2Name);
      expect(toolsFromServer2).toHaveLength(1);
      expect(toolsFromServer2[0].name).toBe(mcpTool2.name);
    });
  });

  describe('discoverTools', () => {
    it('should will preserve tool parametersJsonSchema during discovery from command', async () => {
      const discoveryCommand = 'my-discovery-command';
      mockConfigGetToolDiscoveryCommand.mockReturnValue(discoveryCommand);

      const unsanitizedToolDeclaration: FunctionDeclaration = {
        name: 'tool-with-bad-format',
        description: 'A tool with an invalid format property',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            some_string: {
              type: 'string',
              format: 'uuid', // This is an unsupported format
            },
          },
        },
      };

      const mockSpawn = vi.mocked(spawn);
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockChildProcess as any);

      // Simulate stdout data
      mockChildProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(
            Buffer.from(
              JSON.stringify([
                { function_declarations: [unsanitizedToolDeclaration] },
              ]),
            ),
          );
        }
        return mockChildProcess as any;
      });

      // Simulate process close
      mockChildProcess.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
        return mockChildProcess as any;
      });

      await toolRegistry.discoverAllTools();

      const discoveredTool = toolRegistry.getTool('tool-with-bad-format');
      expect(discoveredTool).toBeDefined();

      const registeredParams = (discoveredTool as DiscoveredTool).schema
        .parametersJsonSchema;
      expect(registeredParams).toStrictEqual({
        type: 'object',
        properties: {
          some_string: {
            type: 'string',
            format: 'uuid',
          },
        },
      });
    });

    it('should return a DISCOVERED_TOOL_EXECUTION_ERROR on tool failure', async () => {
      const discoveryCommand = 'my-discovery-command';
      mockConfigGetToolDiscoveryCommand.mockReturnValue(discoveryCommand);
      vi.spyOn(config, 'getToolCallCommand').mockReturnValue('my-call-command');

      const toolDeclaration: FunctionDeclaration = {
        name: 'failing-tool',
        description: 'A tool that fails',
        parametersJsonSchema: {
          type: 'object',
          properties: {},
        },
      };

      const mockSpawn = vi.mocked(spawn);
      // --- Discovery Mock ---
      const discoveryProcess = {
        stdout: { on: vi.fn(), removeListener: vi.fn() },
        stderr: { on: vi.fn(), removeListener: vi.fn() },
        on: vi.fn(),
      };
      mockSpawn.mockReturnValueOnce(discoveryProcess as any);

      discoveryProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(
            Buffer.from(
              JSON.stringify([{ functionDeclarations: [toolDeclaration] }]),
            ),
          );
        }
      });
      discoveryProcess.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
      });

      await toolRegistry.discoverAllTools();
      const discoveredTool = toolRegistry.getTool('failing-tool');
      expect(discoveredTool).toBeDefined();

      // --- Execution Mock ---
      const executionProcess = {
        stdout: { on: vi.fn(), removeListener: vi.fn() },
        stderr: { on: vi.fn(), removeListener: vi.fn() },
        stdin: { write: vi.fn(), end: vi.fn() },
        on: vi.fn(),
        connected: true,
        disconnect: vi.fn(),
        removeListener: vi.fn(),
      };
      mockSpawn.mockReturnValueOnce(executionProcess as any);

      executionProcess.stderr.on.mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from('Something went wrong'));
        }
      });
      executionProcess.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          callback(1); // Non-zero exit code
        }
      });

      const invocation = (discoveredTool as DiscoveredTool).build({});
      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(
        ToolErrorType.DISCOVERED_TOOL_EXECUTION_ERROR,
      );
      expect(result.llmContent).toContain('Stderr: Something went wrong');
      expect(result.llmContent).toContain('Exit Code: 1');
    });

    it('should discover tools using MCP servers defined in getMcpServers', async () => {
      const discoverSpy = vi.spyOn(
        McpClientManager.prototype,
        'discoverAllMcpTools',
      );
      mockConfigGetToolDiscoveryCommand.mockReturnValue(undefined);
      vi.spyOn(config, 'getMcpServerCommand').mockReturnValue(undefined);
      const mcpServerConfigVal = {
        'my-mcp-server': {
          command: 'mcp-server-cmd',
          args: ['--port', '1234'],
          trust: true,
        },
      };
      vi.spyOn(config, 'getMcpServers').mockReturnValue(mcpServerConfigVal);

      await toolRegistry.discoverAllTools();

      expect(discoverSpy).toHaveBeenCalled();
    });
  });

  describe('DiscoveredToolInvocation', () => {
    it('should return the stringified params from getDescription', () => {
      const tool = new DiscoveredTool(config, 'test-tool', 'A test tool', {});
      const params = { param: 'testValue' };
      const invocation = tool.build(params);
      const description = invocation.getDescription();
      expect(description).toBe(JSON.stringify(params));
    });
  });

  describe('ensureTool concurrency', () => {
    it('runs the factory only once when two calls are made concurrently', async () => {
      let callCount = 0;
      const tool = new MockTool({ name: 'concurrent-tool' });
      toolRegistry.registerFactory('concurrent-tool', async () => {
        callCount++;
        return tool;
      });

      const [result1, result2] = await Promise.all([
        toolRegistry.ensureTool('concurrent-tool'),
        toolRegistry.ensureTool('concurrent-tool'),
      ]);

      expect(callCount).toBe(1);
      expect(result1).toBe(tool);
      expect(result2).toBe(tool);
    });

    it('runs the factory only once when warmAll() and ensureTool() overlap', async () => {
      let callCount = 0;
      const tool = new MockTool({ name: 'overlap-tool' });
      toolRegistry.registerFactory('overlap-tool', async () => {
        callCount++;
        return tool;
      });

      const warmPromise = toolRegistry.warmAll();
      const ensurePromise = toolRegistry.ensureTool('overlap-tool');
      await Promise.all([warmPromise, ensurePromise]);

      expect(callCount).toBe(1);
    });

    it('clears the inflight entry on failure so subsequent calls can retry', async () => {
      let callCount = 0;
      const tool = new MockTool({ name: 'retry-tool' });
      toolRegistry.registerFactory('retry-tool', async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient failure');
        return tool;
      });

      await expect(toolRegistry.ensureTool('retry-tool')).rejects.toThrow(
        'transient failure',
      );

      // Factory remains in the registry after a failure — the second call retries it.
      const result = await toolRegistry.ensureTool('retry-tool');
      expect(result).toBe(tool);
      expect(callCount).toBe(2);
    });
  });

  describe('warmAll strict mode', () => {
    it('throws when a factory fails and strict is true', async () => {
      toolRegistry.registerFactory('bad-tool', async () => {
        throw new Error('factory error');
      });

      await expect(toolRegistry.warmAll({ strict: true })).rejects.toThrow(
        'factory error',
      );
    });

    it('does not throw when a factory fails and strict is false (default)', async () => {
      toolRegistry.registerFactory('bad-tool', async () => {
        throw new Error('factory error');
      });

      await expect(toolRegistry.warmAll()).resolves.toBeUndefined();
    });

    it('still loads successful tools before throwing in strict mode', async () => {
      const goodTool = new MockTool({ name: 'good-tool' });
      toolRegistry.registerFactory('good-tool', async () => goodTool);
      toolRegistry.registerFactory('bad-tool', async () => {
        throw new Error('factory error');
      });

      await expect(toolRegistry.warmAll({ strict: true })).rejects.toThrow(
        'factory error',
      );

      // The good tool should still have been loaded despite the failure.
      expect(await toolRegistry.ensureTool('good-tool')).toBe(goodTool);
    });
  });

  describe('disableMcpServer', () => {
    afterEach(() => {
      for (const name of getAllMCPServerStatuses().keys()) {
        removeMCPServerStatus(name);
      }
    });

    it('still removes the registry entry and updates the exclusion list when disconnect throws', async () => {
      updateMCPServerStatus('flaky-server', MCPServerStatus.DISCONNECTED);
      vi.spyOn(config, 'getExcludedMcpServers').mockReturnValue([]);
      const setExcludedSpy = vi
        .spyOn(config, 'setExcludedMcpServers')
        .mockImplementation(() => {});
      vi.spyOn(
        McpClientManager.prototype,
        'disconnectServer',
      ).mockRejectedValue(new Error('boom'));

      await expect(
        toolRegistry.disableMcpServer('flaky-server'),
      ).rejects.toThrow('boom');

      // Even though disconnect threw, the global status entry must be cleared
      // so the health pill stops counting the server, and the exclusion list
      // must still be updated so the server doesn't reappear on next discovery.
      expect(getAllMCPServerStatuses().has('flaky-server')).toBe(false);
      expect(setExcludedSpy).toHaveBeenCalledWith(['flaky-server']);
    });

    it('still removes the registry entry when the exclusion-list update throws', async () => {
      // Defensive: if a future config implementation makes setExcludedMcpServers
      // throw, the status registry must still be cleaned up — otherwise the
      // health pill would keep a stale entry forever.
      updateMCPServerStatus('flaky-server', MCPServerStatus.DISCONNECTED);
      vi.spyOn(config, 'getExcludedMcpServers').mockReturnValue([]);
      vi.spyOn(config, 'setExcludedMcpServers').mockImplementation(() => {
        throw new Error('config write failed');
      });
      vi.spyOn(
        McpClientManager.prototype,
        'disconnectServer',
      ).mockResolvedValue(undefined);

      await expect(
        toolRegistry.disableMcpServer('flaky-server'),
      ).rejects.toThrow('config write failed');

      expect(getAllMCPServerStatuses().has('flaky-server')).toBe(false);
    });

    it('removes the server from the global status registry so the health pill stops counting it', async () => {
      // Simulate an MCP server that connected and then dropped — the global
      // registry would carry a DISCONNECTED entry for it.
      updateMCPServerStatus('flaky-server', MCPServerStatus.DISCONNECTED);
      expect(getAllMCPServerStatuses().has('flaky-server')).toBe(true);

      const setExcludedSpy = vi
        .spyOn(config, 'setExcludedMcpServers')
        .mockImplementation(() => {});
      vi.spyOn(config, 'getExcludedMcpServers').mockReturnValue([]);
      // disableMcpServer delegates the actual transport teardown to the
      // McpClientManager — stub it out so we can isolate the status-registry
      // behavior.
      vi.spyOn(
        McpClientManager.prototype,
        'disconnectServer',
      ).mockResolvedValue(undefined);

      await toolRegistry.disableMcpServer('flaky-server');

      expect(getAllMCPServerStatuses().has('flaky-server')).toBe(false);
      expect(setExcludedSpy).toHaveBeenCalledWith(['flaky-server']);
    });

    it('updates the exclusion list before dropping the status entry', async () => {
      // Order matters: doctorChecks classifies a server as "disabled" only
      // when it appears in the exclusion list. If the status entry is
      // dropped before the exclusion list is updated, there's a window
      // where the server is reported as a connectivity failure instead of
      // an intentional disable.
      updateMCPServerStatus('flaky-server', MCPServerStatus.DISCONNECTED);
      vi.spyOn(config, 'getExcludedMcpServers').mockReturnValue([]);
      vi.spyOn(
        McpClientManager.prototype,
        'disconnectServer',
      ).mockResolvedValue(undefined);

      const callOrder: string[] = [];
      vi.spyOn(config, 'setExcludedMcpServers').mockImplementation(() => {
        callOrder.push(
          `setExcludedMcpServers:hasStatus=${getAllMCPServerStatuses().has(
            'flaky-server',
          )}`,
        );
      });

      await toolRegistry.disableMcpServer('flaky-server');

      // When setExcludedMcpServers ran, the status entry must still be
      // present — i.e. the exclusion list is updated first.
      expect(callOrder).toEqual(['setExcludedMcpServers:hasStatus=true']);
      expect(getAllMCPServerStatuses().has('flaky-server')).toBe(false);
    });
  });

  describe('stop', () => {
    it('disposes tools that were still inflight when stop() was called', async () => {
      let resolveFactory!: (tool: MockTool) => void;
      const factoryPromise = new Promise<MockTool>((resolve) => {
        resolveFactory = resolve;
      });

      const disposeSpy = vi.fn();
      const tool = new MockTool({ name: 'inflight-tool' });
      (tool as unknown as { dispose: () => void }).dispose = disposeSpy;

      toolRegistry.registerFactory('inflight-tool', () => factoryPromise);

      // Start loading the tool but don't await — it's inflight when stop() is called.
      const ensurePromise = toolRegistry.ensureTool('inflight-tool');

      // Resolve the factory after stop() has started but before it returns.
      const stopPromise = toolRegistry.stop();
      resolveFactory(tool);

      await stopPromise;
      await ensurePromise;

      expect(disposeSpy).toHaveBeenCalledOnce();
    });
  });
});
