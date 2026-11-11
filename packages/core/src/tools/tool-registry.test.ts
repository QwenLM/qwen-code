/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createEmptyLoadedSettings,
  setTestSessionPermission,
} from '../test-utils/config.js';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
  type MockInstance,
} from 'vitest';
import { Config, type ConfigParameters } from '../config/config.js';

import { ToolRegistry } from './tool-registry.js';
import {
  UPDATE_TOPIC_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SKILL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from './tool-names.js';
import { DiscoveredMCPTool } from '../mcp/tools/mcp-tool.js';
import {
  mcpToTool,
  type FunctionDeclaration,
  type CallableTool,
} from '@google/genai';

import fs from 'node:fs';
import { MockTool } from '../test-utils/mock-tool.js';
import { SIMPLE_SYSTEM_PROMPT_ENV } from '../prompts/bundle-resolver.js';

vi.mock('node:fs');

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

// Mock tool-names to inject test-only legacy aliases
vi.mock('./tool-names.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-names.js')>();
  const mockedAliases: Record<string, string> = {
    legacy_test_tool: 'current_test_tool',
  };
  return {
    ...actual,
    TOOL_LEGACY_ALIASES: mockedAliases,
    // Override getToolAliases to use the mocked aliases map
    getToolAliases: (name: string): string[] => {
      const aliases = new Set<string>([name]);
      const canonicalName = mockedAliases[name] ?? name;
      aliases.add(canonicalName);
      for (const [legacyName, currentName] of Object.entries(mockedAliases)) {
        if (currentName === canonicalName) {
          aliases.add(legacyName);
        }
      }
      return Array.from(aliases);
    },
  };
});

// Helper to create a mock CallableTool for specific test needs
const createMockCallableTool = (
  toolDeclarations: FunctionDeclaration[],
): Mocked<CallableTool> => ({
  tool: vi.fn().mockResolvedValue({ functionDeclarations: toolDeclarations }),
  callTool: vi.fn(),
});

const createMCPTool = (
  serverName: string,
  toolName: string,
  description: string,
  mockCallable: CallableTool = {} as CallableTool,
) => new DiscoveredMCPTool(mockCallable, serverName, toolName, description, {});

const baseConfigParams: ConfigParameters = {
  loadedSettings: createEmptyLoadedSettings(),
  cwd: '/tmp',
  model: 'test-model',
  embeddingModel: 'test-embedding-model',
  targetDir: '/test/dir',
  debugMode: false,
  userMemory: '',
  memoryMdFileCount: 0,
  permissionMode: 'default',
  sessionId: 'test-session-id',
};

describe('ToolRegistry', () => {
  let config: Config;
  let toolRegistry: ToolRegistry;
  let mockConfigGetExcludedTools: MockInstance<
    typeof Config.prototype.getExcludeTools
  >;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats);
    config = new Config(baseConfigParams);
    // These tests exercise the request-facing registry. Only the main
    // registry applies configured exclusions and interactive-tool filtering.
    toolRegistry = new ToolRegistry(config, true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockMcpClientConnect.mockReset().mockResolvedValue(undefined);
    mockStdioTransportClose.mockReset();
    mockSseTransportClose.mockReset();
    vi.mocked(mcpToTool).mockClear();
    vi.mocked(mcpToTool).mockReturnValue(createMockCallableTool([]));

    mockConfigGetExcludedTools = vi.spyOn(config, 'getExcludeTools');
    vi.spyOn(config, 'getMcpServers');
    vi.spyOn(config, 'getMcpServerCommand');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('registerTool', () => {
    it('should register a new tool', () => {
      const tool = new MockTool({ name: 'mock-tool' });
      toolRegistry.registerTool(tool);
      expect(toolRegistry.getTool('mock-tool')).toBe(tool);
    });

    it('should pass modelId to getSchema when getting function declarations', () => {
      const tool = new MockTool({ name: 'mock-tool' });
      const getSchemaSpy = vi.spyOn(tool, 'getSchema');
      toolRegistry.registerTool(tool);

      const modelId = 'test-model-id';
      toolRegistry.getFunctionDeclarations(modelId);

      expect(getSchemaSpy).toHaveBeenCalledWith(modelId);
    });

    it('should invalidate the model schema cache when its bundle changes', () => {
      const tool = new MockTool({ name: 'mock-tool' });
      const getSchemaSpy = vi.spyOn(tool, 'getSchema');
      toolRegistry.registerTool(tool);
      vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, '0');

      toolRegistry.getFunctionDeclarations('same-model');
      vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, '1');
      toolRegistry.getFunctionDeclarations('same-model');

      expect(getSchemaSpy).toHaveBeenCalledTimes(2);
    });

    it('includes pre-read prompt behavior in the schema cache key', () => {
      const tool = new MockTool({ name: 'mock-tool' });
      const getSchemaSpy = vi.spyOn(tool, 'getSchema');
      toolRegistry.registerTool(tool);

      const strict = toolRegistry.getFunctionDeclarations('same-model', {
        preReadLineDropped: false,
      });
      const relaxed = toolRegistry.getFunctionDeclarations('same-model', {
        preReadLineDropped: true,
      });
      const relaxedAgain = toolRegistry.getFunctionDeclarations('same-model', {
        preReadLineDropped: true,
      });

      expect(getSchemaSpy).toHaveBeenCalledTimes(2);
      expect(relaxedAgain).toBe(relaxed);
      expect(strict).not.toBe(relaxed);
    });
  });

  it.each(['ShellTool', 'ShellTool(echo *)'])(
    'matches product tool configuration names in main agent tools: %s',
    (configuredTool) => {
      class ProductShellTool extends MockTool {
        override readonly configurationName = 'ShellTool';
      }
      vi.spyOn(config, 'getMainAgentTools').mockReturnValue([configuredTool]);
      toolRegistry.registerTool(new ProductShellTool({ name: 'Bash' }));
      toolRegistry.registerTool(new MockTool({ name: 'unlisted-tool' }));

      expect(
        toolRegistry.getFunctionDeclarations().map((tool) => tool.name),
      ).toEqual(['Bash']);
      expect(
        toolRegistry.getModelFunctionDeclarations().map((tool) => tool.name),
      ).toEqual(['Bash']);
    },
  );

  describe('removeMcpToolsByServer', () => {
    it('should remove all tools from a specific server', () => {
      const serverName = 'test-server';
      const mcpTool1 = createMCPTool(serverName, 'tool1', 'desc1');
      const mcpTool2 = createMCPTool(serverName, 'tool2', 'desc2');
      const otherTool = createMCPTool('other-server', 'tool3', 'desc3');

      toolRegistry.registerTool(mcpTool1);
      toolRegistry.registerTool(mcpTool2);
      toolRegistry.registerTool(otherTool);

      expect(toolRegistry.getToolsByServer(serverName)).toHaveLength(2);

      toolRegistry.removeMcpToolsByServer(serverName);

      expect(toolRegistry.getToolsByServer(serverName)).toHaveLength(0);
      expect(toolRegistry.getToolsByServer('other-server')).toHaveLength(1);
    });
  });

  describe('excluded tools', () => {
    const simpleTool = new MockTool({
      name: 'tool-a',
      displayName: 'Tool a',
    });
    const excludedTool = new ExcludedMockTool({
      name: 'excluded-tool-class',
      displayName: 'Excluded Tool Class',
    });
    const mcpTool = createMCPTool(
      'mcp-server',
      'excluded-mcp-tool',
      'description',
    );
    const allowedTool = new MockTool({
      name: 'allowed-tool',
      displayName: 'Allowed Tool',
    });

    it.each([
      {
        name: 'should match simple names',
        tools: [simpleTool],
        excludedTools: ['tool-a'],
      },
      {
        name: 'should match simple MCP tool names',
        tools: [mcpTool],
        excludedTools: [mcpTool.name],
      },
      {
        name: 'should match qualified MCP tool names',
        tools: [mcpTool],
        excludedTools: [mcpTool.name],
      },
      {
        name: 'should match class names',
        tools: [excludedTool],
        excludedTools: ['ExcludedMockTool'],
      },
      {
        name: 'should exclude a tool when its legacy alias is in excludeTools',
        tools: [
          new MockTool({
            name: 'current_test_tool',
            displayName: 'Current Test Tool',
          }),
        ],
        excludedTools: ['legacy_test_tool'],
      },
      {
        name: 'should exclude a tool when its current name is in excludeTools and tool is registered under current name',
        tools: [
          new MockTool({
            name: 'current_test_tool',
            displayName: 'Current Test Tool',
          }),
        ],
        excludedTools: ['current_test_tool'],
      },
    ])('$name', ({ tools, excludedTools }) => {
      toolRegistry.registerTool(allowedTool);
      for (const tool of tools) {
        toolRegistry.registerTool(tool);
      }
      mockConfigGetExcludedTools.mockReturnValue(new Set(excludedTools));

      expect(toolRegistry.getAllTools()).toEqual([allowedTool]);
      expect(toolRegistry.getAllToolNames()).toEqual([allowedTool.name]);
      expect(toolRegistry.getFunctionDeclarations()).toEqual(
        toolRegistry.getFunctionDeclarationsFiltered([allowedTool.name]),
      );
      for (const tool of tools) {
        expect(toolRegistry.getTool(tool.name)).toBeUndefined();
        expect(
          toolRegistry.getFunctionDeclarationsFiltered([tool.name]),
        ).toHaveLength(0);
        if (tool instanceof DiscoveredMCPTool) {
          expect(toolRegistry.getToolsByServer(tool.serverName)).toHaveLength(
            0,
          );
        }
      }
    });
  });

  describe('MCP wildcard deny rules hide tools end to end', () => {
    const setDenyRules = (rules: string[]): void => {
      // Tool hiding reads only the deny rule set (Config.getExcludeTools ->
      // permission.getRules()); give the config the minimal permission-module
      // surface that carries it.
      setTestSessionPermission(config, {
        getRules: () => ({ allow: {}, deny: { userSettings: rules }, ask: {} }),
      } as any);
    };

    const registerFixtures = (): {
      test3Alpha: DiscoveredMCPTool;
      test3Beta: DiscoveredMCPTool;
      test1Ping: DiscoveredMCPTool;
      regular: MockTool;
    } => {
      const test3Alpha = createMCPTool('test3', 'alpha', 'd');
      const test3Beta = createMCPTool('test3', 'beta', 'd');
      const test1Ping = createMCPTool('test1', 'ping', 'd');
      const regular = new MockTool({ name: 'regular-tool' });
      for (const tool of [test3Alpha, test3Beta, test1Ping, regular]) {
        toolRegistry.registerTool(tool);
      }
      return { test3Alpha, test3Beta, test1Ping, regular };
    };

    const expectHidden = (names: string[]): void => {
      const allNames = toolRegistry.getAllToolNames();
      const declarationNames = toolRegistry
        .getFunctionDeclarations()
        .map((d) => d.name);
      for (const name of names) {
        expect(allNames).not.toContain(name);
        expect(declarationNames).not.toContain(name);
        // getTool backs the scheduler's tool lookup; undefined there is what
        // turns an invocation of a hidden tool into "Tool ... not found".
        expect(toolRegistry.getTool(name)).toBeUndefined();
      }
    };

    it('hides the exact denied MCP tool only (baseline)', () => {
      setDenyRules(['mcp__test1__ping']);
      const { test3Alpha, test1Ping } = registerFixtures();

      expectHidden(['mcp__test1__ping']);
      expect(toolRegistry.getTool('mcp__test3__alpha')).toBe(test3Alpha);
      expect(toolRegistry.getAllToolNames()).not.toContain(
        test1Ping.getFullyQualifiedName(),
      );
    });

    it('hides every tool of a server denied via mcp__server__*', () => {
      setDenyRules(['mcp__test3__*']);
      const { test1Ping, regular } = registerFixtures();

      expectHidden(['mcp__test3__alpha', 'mcp__test3__beta']);
      expect(toolRegistry.getTool('mcp__test1__ping')).toBe(test1Ping);
      expect(toolRegistry.getTool('regular-tool')).toBe(regular);
    });

    it('hides all MCP tools for the global mcp__* deny rule', () => {
      setDenyRules(['mcp__*']);
      const { regular } = registerFixtures();

      expectHidden(['mcp__test3__alpha', 'mcp__test3__beta', 'mcp__test1__ping']);
      expect(toolRegistry.getTool('regular-tool')).toBe(regular);
      expect(toolRegistry.getAllToolNames()).toContain('regular-tool');
    });

    it('hides every tool of a server denied via the bare server name', () => {
      setDenyRules(['mcp__test3']);
      const { test1Ping } = registerFixtures();

      expectHidden(['mcp__test3__alpha', 'mcp__test3__beta']);
      expect(toolRegistry.getTool('mcp__test1__ping')).toBe(test1Ping);
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
    it('should return all registered tool names with qualified names for MCP tools', () => {
      // Register tools with displayNames in non-alphabetical order
      const toolC = new MockTool({ name: 'c-tool', displayName: 'Tool C' });
      const toolA = new MockTool({ name: 'a-tool', displayName: 'Tool A' });
      const mcpTool = createMCPTool('my-server', 'my-tool', 'desc');

      toolRegistry.registerTool(toolC);
      toolRegistry.registerTool(toolA);
      toolRegistry.registerTool(mcpTool);

      const toolNames = toolRegistry.getAllToolNames();

      // Assert that the returned array contains all tool names, with MCP qualified
      expect(toolNames).toContain('c-tool');
      expect(toolNames).toContain('a-tool');
      expect(toolNames).toContain('mcp__my-server__my-tool');
      expect(toolNames).toHaveLength(3);
    });

    it('should deduplicate tool names', () => {
      const serverName = 'my-server';
      const toolName = 'my-tool';
      const mcpTool = createMCPTool(serverName, toolName, 'desc');

      // Register same MCP tool twice
      toolRegistry.registerTool(mcpTool);
      toolRegistry.registerTool(mcpTool);

      const toolNames = toolRegistry.getAllToolNames();
      expect(toolNames).toEqual([`mcp__${serverName}__${toolName}`]);
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
      const mcpTool1_c = createMCPTool(server1Name, 'zebra-tool', 'd1');
      const mcpTool1_a = createMCPTool(server1Name, 'apple-tool', 'd2');
      const mcpTool1_b = createMCPTool(server1Name, 'banana-tool', 'd3');
      const mcpTool2 = createMCPTool(server2Name, 'tool-on-server2', 'd4');
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

  describe('sortTools', () => {
    it('should sort tools by priority: built-in, then MCP (by server name)', () => {
      const builtIn1 = new MockTool({ name: 'builtin-1' });
      const builtIn2 = new MockTool({ name: 'builtin-2' });
      const mcpZebra = createMCPTool('zebra-server', 'mcp-zebra', 'desc');
      const mcpApple = createMCPTool('apple-server', 'mcp-apple', 'desc');

      // Register in mixed order
      toolRegistry.registerTool(mcpZebra);
      toolRegistry.registerTool(builtIn1);
      toolRegistry.registerTool(mcpApple);
      toolRegistry.registerTool(builtIn2);

      toolRegistry.sortTools();

      expect(toolRegistry.getAllToolNames()).toEqual([
        'builtin-1',
        'builtin-2',
        'mcp__apple-server__mcp-apple',
        'mcp__zebra-server__mcp-zebra',
      ]);
    });

    it('should keep request tool schemas deterministic when Skill is rebuilt after startup sorting', () => {
      const readTool = new MockTool({ name: READ_FILE_TOOL_NAME });
      const skillTool = new MockTool({ name: SKILL_TOOL_NAME });
      const mcpTool = createMCPTool('extensions', 'lookup', 'desc');

      toolRegistry.registerTool(mcpTool);
      toolRegistry.registerTool(skillTool);
      toolRegistry.registerTool(readTool);
      toolRegistry.sortTools();

      const parentRequestToolOrder = toolRegistry
        .getFunctionDeclarations()
        .map((declaration) => declaration.name);

      // Side Chat starts a new process and repeats skill discovery. Rebuilding
      // Skill after a one-time startup sort must not move it behind MCP tools.
      toolRegistry.unregisterTool(SKILL_TOOL_NAME);
      toolRegistry.registerTool(new MockTool({ name: SKILL_TOOL_NAME }));

      const forkRequestToolOrder = toolRegistry
        .getFunctionDeclarations()
        .map((declaration) => declaration.name);

      expect(forkRequestToolOrder).toEqual(parentRequestToolOrder);
    });

    it('should keep request tool schemas deterministic without an explicit sortTools call', () => {
      // Independent CLI processes can finish registration in any order (Skill
      // discovery racing MCP startup). The canonical order is an invariant of
      // the registry, so no caller has to remember to sort.
      const registerIn = (names: string[]): string[] => {
        const registry = new ToolRegistry(config, true);
        for (const name of names) {
          registry.registerTool(
            name.startsWith('mcp__')
              ? createMCPTool('extensions', 'lookup', 'desc')
              : new MockTool({ name }),
          );
        }
        return registry
          .getFunctionDeclarations()
          .flatMap((declaration) =>
            declaration.name ? [declaration.name] : [],
          );
      };

      const order = [READ_FILE_TOOL_NAME, SKILL_TOOL_NAME, 'mcp__x'];
      expect(registerIn([...order].reverse())).toEqual(registerIn(order));
    });
  });

  describe('getTool', () => {
    it('should retrieve an MCP tool by its fully qualified name', () => {
      const serverName = 'my-server';
      const toolName = 'my-tool';
      const mcpTool = createMCPTool(serverName, toolName, 'description');

      // Register tool
      toolRegistry.registerTool(mcpTool);

      // Verify it is available as 'mcp__my-server__my-tool'
      const fullyQualifiedName = `mcp__${serverName}__${toolName}`;
      const retrievedTool = toolRegistry.getTool(fullyQualifiedName);

      expect(retrievedTool).toBeDefined();
      expect(retrievedTool?.name).toBe(fullyQualifiedName);
    });

    it('should retrieve an MCP tool by its fully qualified name when tool name has special characters', () => {
      const serverName = 'my-server';
      // Use a space which is invalid and will be replaced by underscore
      const toolName = 'my tool';
      const validToolName = 'my_tool';
      const mcpTool = createMCPTool(serverName, toolName, 'description');

      // Register tool
      toolRegistry.registerTool(mcpTool);

      // Verify it is available as 'mcp__my-server__my_tool'
      const fullyQualifiedName = `mcp__${serverName}__${validToolName}`;
      const retrievedTool = toolRegistry.getTool(fullyQualifiedName);

      expect(retrievedTool).toBeDefined();
      expect(retrievedTool?.name).toBe(fullyQualifiedName);
    });

    it('should resolve qualified names in getFunctionDeclarationsFiltered', () => {
      const serverName = 'my-server';
      const toolName = 'my-tool';
      const mcpTool = createMCPTool(serverName, toolName, 'description');

      toolRegistry.registerTool(mcpTool);

      const fullyQualifiedName = `mcp__${serverName}__${toolName}`;
      const declarations = toolRegistry.getFunctionDeclarationsFiltered([
        fullyQualifiedName,
      ]);

      expect(declarations).toHaveLength(1);
      expect(declarations[0].name).toBe(fullyQualifiedName);
    });

    it('should retrieve a tool using its legacy alias', async () => {
      const legacyName = 'legacy_test_tool';
      const currentName = 'current_test_tool';

      const mockTool = new MockTool({
        name: currentName,
        description: 'Test Tool',
      });

      toolRegistry.registerTool(mockTool);

      const retrievedTool = toolRegistry.getTool(legacyName);
      expect(retrievedTool).toBeDefined();
      expect(retrievedTool?.name).toBe(currentName);
    });
  });

  describe('getFunctionDeclarations', () => {
    it('should use fully qualified names for MCP tools in declarations', () => {
      const serverName = 'my-server';
      const toolName = 'my-tool';
      const mcpTool = createMCPTool(serverName, toolName, 'description');

      toolRegistry.registerTool(mcpTool);

      const declarations = toolRegistry.getFunctionDeclarations();
      expect(declarations).toHaveLength(1);
      expect(declarations[0].name).toBe(`mcp__${serverName}__${toolName}`);
    });

    it('should deduplicate MCP tools in declarations', () => {
      const serverName = 'my-server';
      const toolName = 'my-tool';
      const mcpTool = createMCPTool(serverName, toolName, 'description');

      toolRegistry.registerTool(mcpTool);
      toolRegistry.registerTool(mcpTool);

      const declarations = toolRegistry.getFunctionDeclarations();
      expect(declarations).toHaveLength(1);
      expect(declarations[0].name).toBe(`mcp__${serverName}__${toolName}`);
    });
  });

  describe('plan mode', () => {
    it('should only return policy-allowed tools in plan mode', () => {
      // Register several tools
      const globTool = new MockTool({
        name: GLOB_TOOL_NAME,
        displayName: 'Glob',
      });
      const readFileTool = new MockTool({
        name: READ_FILE_TOOL_NAME,
        displayName: 'Read',
      });
      const shellTool = new MockTool({ name: 'shell', displayName: 'Bash' });
      const writeTool = new MockTool({
        name: WRITE_FILE_TOOL_NAME,
        displayName: 'Write',
      });

      toolRegistry.registerTool(globTool);
      toolRegistry.registerTool(readFileTool);
      toolRegistry.registerTool(shellTool);
      toolRegistry.registerTool(writeTool);

      // Mock config in PLAN mode: exclude write_file but NOT shell.
      // Shell is available in plan mode; read-only enforcement is at the
      // permission layer (checkShellPermission), not tool registry removal.
      mockConfigGetExcludedTools.mockReturnValue(
        new Set([WRITE_FILE_TOOL_NAME]),
      );

      const allTools = toolRegistry.getAllTools();
      const toolNames = allTools.map((t) => t.name);

      expect(toolNames).toContain(GLOB_TOOL_NAME);
      expect(toolNames).toContain(READ_FILE_TOOL_NAME);
      expect(toolNames).toContain('shell');
      expect(toolNames).not.toContain(WRITE_FILE_TOOL_NAME);
    });

    it('should include read-only MCP tools when allowed by policy in plan mode', () => {
      const readOnlyMcp = createMCPTool(
        'test-server',
        'read-only-tool',
        'A read-only MCP tool',
      );
      // Set readOnlyHint to true via toolAnnotations
      Object.defineProperty(readOnlyMcp, 'isReadOnly', { value: true });

      toolRegistry.registerTool(readOnlyMcp);

      // Policy allows this tool (not in excluded set)
      mockConfigGetExcludedTools.mockReturnValue(new Set());

      const allTools = toolRegistry.getAllTools();
      const toolNames = allTools.map((t) => t.name);
      expect(toolNames).toContain('mcp__test-server__read-only-tool');
    });

    it('should exclude non-read-only MCP tools when denied by policy in plan mode', () => {
      const writeMcp = createMCPTool(
        'test-server',
        'write-mcp-tool',
        'A write MCP tool',
      );

      toolRegistry.registerTool(writeMcp);

      // Policy excludes this tool
      mockConfigGetExcludedTools.mockReturnValue(
        new Set(['mcp__test-server__write-mcp-tool']),
      );

      const allTools = toolRegistry.getAllTools();
      const toolNames = allTools.map((t) => t.name);
      expect(toolNames).not.toContain('mcp__test-server__write-mcp-tool');
    });

    it('should exclude topic tool when narration is disabled in config', () => {
      const topicTool = new MockTool({
        name: UPDATE_TOPIC_TOOL_NAME,
        displayName: 'Topic Tool',
      });
      toolRegistry.registerTool(topicTool);

      vi.spyOn(config, 'isTopicUpdateNarrationEnabled').mockReturnValue(false);
      mockConfigGetExcludedTools.mockReturnValue(new Set());

      expect(toolRegistry.getAllToolNames()).not.toContain(
        UPDATE_TOPIC_TOOL_NAME,
      );
      expect(toolRegistry.getTool(UPDATE_TOPIC_TOOL_NAME)).toBeUndefined();
    });

    it('should NOT exclude topic tool when narration is enabled in config', () => {
      const topicTool = new MockTool({
        name: UPDATE_TOPIC_TOOL_NAME,
        displayName: 'Topic Tool',
      });
      toolRegistry.registerTool(topicTool);

      vi.spyOn(config, 'isTopicUpdateNarrationEnabled').mockReturnValue(true);
      mockConfigGetExcludedTools.mockReturnValue(new Set());

      expect(toolRegistry.getAllToolNames()).toContain(UPDATE_TOPIC_TOOL_NAME);
      expect(toolRegistry.getTool(UPDATE_TOPIC_TOOL_NAME)).toBe(topicTool);
    });

    it('should show enter_plan_mode in both plan mode and non-plan mode', () => {
      const enterTool = new MockTool({ name: ENTER_PLAN_MODE_TOOL_NAME });
      toolRegistry.registerTool(enterTool);

      // Not in plan mode
      vi.spyOn(config, 'getPermissionMode').mockReturnValue('default');
      expect(toolRegistry.getAllToolNames()).toContain(
        ENTER_PLAN_MODE_TOOL_NAME,
      );

      // In plan mode — tool must still be present; idempotent guard in execute() handles re-entry
      vi.spyOn(config, 'getPermissionMode').mockReturnValue('default');
      expect(toolRegistry.getAllToolNames()).toContain(
        ENTER_PLAN_MODE_TOOL_NAME,
      );
    });

    it('should show exit_plan_mode in both plan mode and non-plan mode', () => {
      const exitTool = new MockTool({ name: EXIT_PLAN_MODE_TOOL_NAME });
      toolRegistry.registerTool(exitTool);

      // Not in plan mode — tool is visible (system-reminder constrains when model can call it)
      vi.spyOn(config, 'getPermissionMode').mockReturnValue('default');
      expect(toolRegistry.getAllToolNames()).toContain(
        EXIT_PLAN_MODE_TOOL_NAME,
      );

      // In plan mode
      vi.spyOn(config, 'getPermissionMode').mockReturnValue('default');
      expect(toolRegistry.getAllToolNames()).toContain(
        EXIT_PLAN_MODE_TOOL_NAME,
      );
    });
  });
});

/**
 * Used for tests that exclude by class name.
 */
class ExcludedMockTool extends MockTool {
  constructor(options: ConstructorParameters<typeof MockTool>[0]) {
    super(options);
  }
}
