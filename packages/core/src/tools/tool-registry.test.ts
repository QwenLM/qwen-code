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
import { PermissionManager } from '../permissions/permission-manager.js';
import {
  ToolRegistry,
  DiscoveredTool,
  deferredDeclarationFingerprint,
} from './tool-registry.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { ExitPlanModeTool } from './exitPlanMode.js';
import type { FunctionDeclaration, CallableTool } from '@google/genai';
import { mcpToTool } from '@google/genai';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { MockTool } from '../test-utils/mock-tool.js';
import type { AnyDeclarativeTool, MediaPolicyToolDescriptor } from './tools.js';
import { CHARS_PER_TOKEN } from '../services/tokenEstimation.js';

import { McpClientManager } from './mcp-client-manager.js';
import {
  getAllMCPServerStatuses,
  MCPServerStatus,
  removeMCPServerStatus,
  updateMCPServerStatus,
} from './mcp-client.js';
import { ToolErrorType } from './tool-error.js';
import {
  generateLegacyMcpToolName,
  normalizeMcpToolName,
} from '../utils/tool-name-utils.js';
import { ToolMode } from './code-mode.js';

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
  memoryFileCount: 0,
  approvalMode: ApprovalMode.DEFAULT,
};

const mcp = (
  server: string,
  name: string,
  description = 'description',
  schema: unknown = {},
) =>
  new DiscoveredMCPTool({} as CallableTool, server, name, description, schema);

const deferred = (
  name: string,
  extra: Partial<ConstructorParameters<typeof MockTool>[0]> = {},
) => new MockTool({ name, shouldDefer: true, ...extra });

/** Registers each tool in order; a string is a plain MockTool of that name. */
function register(
  registry: ToolRegistry,
  ...tools: Array<string | AnyDeclarativeTool>
): void {
  for (const tool of tools) {
    registry.registerTool(
      typeof tool === 'string' ? new MockTool({ name: tool }) : tool,
    );
  }
}

function lazy(registry: ToolRegistry, name: string): void {
  registry.registerFactory(name, async () => new MockTool({ name }));
}

const registryFor = (params: Partial<ConfigParameters> = {}) =>
  new ToolRegistry(new Config({ ...baseConfigParams, ...params }));

const declared = (
  registry: ToolRegistry,
  options?: { includeDeferred?: boolean },
) => registry.getFunctionDeclarations(options).map((d) => d.name);

const declaredFiltered = (registry: ToolRegistry, names: string[]) =>
  registry.getFunctionDeclarationsFiltered(names).map((d) => d.name);

const summaryNames = (registry: ToolRegistry) =>
  registry.getDeferredToolSummary().map((t) => t.name);

const decl = (name: string, description: string): FunctionDeclaration => ({
  name,
  description,
  parametersJsonSchema: { type: 'object', properties: {} },
});

/** Makes the mocked `on` call its `event` listener with `arg` right away. */
const fireOn = (
  on: ReturnType<typeof vi.fn>,
  event: string,
  arg: unknown,
  returnValue?: unknown,
) =>
  on.mockImplementation((name, callback) => {
    if (name === event) callback(arg);
    return returnValue;
  });

describe('ToolRegistry', () => {
  let config: Config;
  let toolRegistry: ToolRegistry;
  let mockConfigGetToolDiscoveryCommand: ReturnType<typeof vi.spyOn>;

  it('registers only runnable read tools for agent-host sessions through every registration path', async () => {
    const config = new Config({
      ...baseConfigParams,
      safeMode: true,
      coreTools: ['read_file', 'grep_search', 'list_directory'],
    });
    config.setSessionSource('agent-host', 'host_1');
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    for (const name of [
      'agent',
      'tool_call',
      'mcp__ambient__read',
      'unknown',
    ]) {
      const tool = new MockTool({ name });
      registry.registerTool(tool);
      registry.registerFactory(name, async () => tool);
      registry.registerPermissionDeferredFactory(name, async () => tool);
    }
    expect(registry.getAllToolNames().sort()).toEqual([
      'grep_search',
      'list_directory',
      'read_file',
    ]);
  });

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
    vi.spyOn(config, 'getResourceRegistry').mockReturnValue({
      clear: vi.fn(),
      removeResourcesByServer: vi.fn(),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const appTool = (
    server: string,
    name: string,
    visibility?: readonly string[],
    resourceUri = 'ui://app/view',
  ) =>
    new DiscoveredMCPTool(
      createMockCallableTool([]),
      server,
      name,
      'App tool',
      { type: 'object', properties: {} },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      resourceUri,
      undefined,
      undefined,
      visibility,
    );

  it('keeps App-only tools outside every model lookup and clears them on removal', () => {
    const tool = appTool('tableau', 'get-token', ['app']);
    toolRegistry.registerTool(tool);
    expect(toolRegistry.getMcpAppTool('tableau', 'get-token')).toBe(tool);
    expect(toolRegistry.getMcpAppTool('other', 'get-token')).toBeUndefined();
    expect(toolRegistry.getMcpAppTool('tableau', tool.name)).toBeUndefined();
    expect(toolRegistry.getTool(tool.name)).toBeUndefined();
    expect(toolRegistry.getAllToolNames()).not.toContain(tool.name);
    expect(toolRegistry.getAllTools()).not.toContain(tool);
    expect(toolRegistry.getFunctionDeclarations()).not.toContainEqual(
      tool.schema,
    );
    toolRegistry.removeMcpToolsByServer('tableau');
    expect(toolRegistry.getMcpAppTool('tableau', 'get-token')).toBeUndefined();
  });

  it('honors App visibility and disabled rules while retaining model-only App resources', () => {
    const model = appTool('tableau', 'show', ['model']);
    const disabled = appTool('tableau', 'disabled', ['app']);
    vi.spyOn(config, 'getDisabledTools').mockReturnValue(
      new Set([disabled.name]),
    );
    for (const tool of [
      model,
      disabled,
      appTool('tableau', 'empty', []),
      appTool('tableau', 'unknown', ['unknown']),
      appTool('tableau', 'default'),
    ]) {
      toolRegistry.registerTool(tool);
    }
    expect(toolRegistry.hasMcpAppResource('tableau', 'ui://app/view')).toBe(
      true,
    );
    for (const name of ['show', 'disabled', 'empty', 'unknown']) {
      expect(toolRegistry.getMcpAppTool('tableau', name)).toBeUndefined();
    }
    expect(toolRegistry.getMcpAppTool('tableau', 'default')).toBeDefined();
    expect(toolRegistry.getTool(model.name)).toBe(model);
  });

  it('copies App-only tools and model-only source resources, then clears only the re-discovered server', async () => {
    const source = new ToolRegistry(config);
    source.registerTool(appTool('tableau', 'token', ['app']));
    source.registerTool(
      appTool('tableau', 'source', ['model'], 'ui://model/source'),
    );
    source.registerTool(appTool('other', 'token', ['app']));
    toolRegistry.copyDiscoveredToolsFrom(source);
    expect(toolRegistry.getMcpAppTool('tableau', 'token')).toBeDefined();
    expect(toolRegistry.getTool('mcp__tableau__token')).toBeUndefined();
    expect(toolRegistry.hasMcpAppResource('tableau', 'ui://model/source')).toBe(
      true,
    );
    vi.spyOn(
      McpClientManager.prototype,
      'discoverMcpToolsForServer',
    ).mockResolvedValue();
    await toolRegistry.discoverToolsForServer('tableau');
    expect(toolRegistry.getMcpAppTool('tableau', 'token')).toBeUndefined();
    expect(toolRegistry.hasMcpAppResource('tableau', 'ui://model/source')).toBe(
      false,
    );
    expect(toolRegistry.getMcpAppTool('other', 'token')).toBeDefined();
  });

  it('clears App-only tools on full discovery and shutdown', async () => {
    vi.spyOn(
      McpClientManager.prototype,
      'discoverAllMcpTools',
    ).mockResolvedValue();
    vi.spyOn(McpClientManager.prototype, 'stop').mockResolvedValue();
    toolRegistry.registerTool(appTool('tableau', 'token', ['app']));
    await toolRegistry.discoverMcpTools();
    expect(toolRegistry.getMcpAppTool('tableau', 'token')).toBeUndefined();
    toolRegistry.registerTool(appTool('tableau', 'token', ['app']));
    await toolRegistry.stop();
    expect(toolRegistry.getMcpAppTool('tableau', 'token')).toBeUndefined();
  });

  it('hides a loaded image tool while disabled and restores it when re-enabled', async () => {
    const enabled = vi
      .spyOn(config, 'isImageGenerationEnabled')
      .mockReturnValue(true);
    const tool = new MockTool({ name: 'image_gen', shouldDefer: true });
    toolRegistry.registerTool(tool);
    toolRegistry.revealDeferredTool('image_gen');
    expect(toolRegistry.getFunctionDeclarations()).toContainEqual(tool.schema);
    enabled.mockReturnValue(false);
    expect(
      toolRegistry.getFunctionDeclarations({ includeDeferred: true }),
    ).not.toContainEqual(tool.schema);
    expect(declaredFiltered(toolRegistry, ['image_gen'])).toEqual([]);
    expect(toolRegistry.getAllTools()).not.toContain(tool);
    expect(toolRegistry.getAllToolNames()).not.toContain('image_gen');
    expect(summaryNames(toolRegistry).includes('image_gen')).toBe(false);
    expect(toolRegistry.getTool('image_gen')).toBeUndefined();
    expect(await toolRegistry.ensureTool('image_gen')).toBeUndefined();
    enabled.mockReturnValue(true);
    expect(await toolRegistry.ensureTool('image_gen')).toBe(tool);
    expect(toolRegistry.getFunctionDeclarations()).toContainEqual(tool.schema);
  });

  it.each(['image_gen', 'propose_goal'] as const)(
    'updates code mode bindings when %s availability changes',
    async (name) => {
      const baseUrl = 'https://images.example/v1';
      const config = new Config({
        ...baseConfigParams,
        codeModeOnly: true,
        experimentalZedIntegration: true,
        modelProvidersConfig: {
          openai: [
            {
              id: 'qwen-image-2.0',
              baseUrl,
              imageOnly: true,
              envKey: 'TEST_IMAGE_API_KEY',
            },
          ],
        },
      });
      config.setGoalProposalHostSupported(true);
      const registry = new ToolRegistry(config);
      const tool = new MockTool({ name });
      register(registry, tool, 'exec', 'other_tool');
      for (const enabled of [true, false, true]) {
        if (name === 'image_gen')
          await config.setImageModel(
            enabled ? `openai:qwen-image-2.0\0${baseUrl}` : '',
          );
        else config.setGoalProposalTurnKey(enabled ? 'user-turn' : undefined);
        const bindings = registry
          .getCodeModeBindingPlan()
          .bindings.map((binding) => binding.name);
        expect(bindings.includes(name)).toBe(enabled);
        expect(bindings).toContain('other_tool');
        for (const declarations of [
          registry.getFunctionDeclarations(),
          registry.getFunctionDeclarationsFiltered([name, 'other_tool']),
        ]) {
          const exec = declarations.find(
            (declaration) => declaration.name === 'exec',
          );
          expect(exec?.description).toContain('tools.other_tool(args:');
          expect(exec?.description?.includes(`tools.${name}(args:`)).toBe(
            enabled,
          );
        }
        if (name === 'image_gen') {
          expect(config.isImageGenerationEnabled()).toBe(enabled);
          expect(registry.getTool(name)).toBe(enabled ? tool : undefined);
          expect(await registry.ensureTool(name)).toBe(
            enabled ? tool : undefined,
          );
        } else expect(config.isGoalProposalAvailable()).toBe(enabled);
      }
    },
  );

  describe('registerTool', () => {
    it('should register a new tool', () => {
      const tool = new MockTool({ name: 'mock-tool' });
      toolRegistry.registerTool(tool);
      expect(toolRegistry.getTool('mock-tool')).toBe(tool);
    });

    it('unregisters an eager tool', () => {
      register(toolRegistry, 'eager');

      toolRegistry.unregisterTool('eager');

      expect(toolRegistry.getTool('eager')).toBeUndefined();
    });

    it('renames an MCP tool whose name shadows a registered lazy factory', async () => {
      // The synthetic `structured_output` tool registers via `registerFactory`
      // (lazy). Without this guard, an MCP server discovering a tool named
      // `structured_output` would silently shadow the factory: `tools.has(name)`
      // is false (factories live in a separate map), the MCP tool registers
      // as-is, and the next `ensureTool('structured_output')` resolves from the
      // eager map and discards the factory. Same for any other lazy built-in.
      // The fix folds factory collisions into the same auto-rename path MCP
      // tools already get for eager-tool collisions.
      lazy(toolRegistry, 'structured_output');
      toolRegistry.registerTool(mcp('rogue-server', 'structured_output'));

      // The MCP tool must have been auto-qualified and live under its
      // namespaced name, not under `structured_output`.
      const renamed = toolRegistry.getTool(
        'mcp__rogue-server__structured_output',
      );
      expect(renamed).toBeDefined();
      expect(renamed).toBeInstanceOf(DiscoveredMCPTool);

      // The factory must still be the canonical owner of `structured_output`:
      // `ensureTool` resolves it without going through the MCP tool.
      const resolved = await toolRegistry.ensureTool('structured_output');
      expect(resolved).toBeDefined();
      expect(resolved).not.toBeInstanceOf(DiscoveredMCPTool);
      expect(resolved!.name).toBe('structured_output');
    });

    it('skips tools whose name is in Config.disabledTools (#4175 Wave 4 PR 17)', () => {
      const registry = registryFor({
        disabledTools: ['Bash', 'mcp__github__create_issue'],
      });
      register(registry, 'Bash', 'Read', 'mcp__github__create_issue');
      expect(registry.getTool('Bash')).toBeUndefined();
      expect(registry.getTool('Read')).toBeDefined();
      expect(registry.getTool('mcp__github__create_issue')).toBeUndefined();
    });

    /** `legacyName` (disabled) is an old spelling of the tool's new name. */
    function expectLegacyNameHonored(
      legacyName: string,
      server: string,
      serverToolName: string,
    ): void {
      const registry = registryFor({ disabledTools: [legacyName] });
      const mcpTool = mcp(server, serverToolName);

      expect(mcpTool.name).not.toBe(legacyName);
      registry.registerTool(mcpTool);
      expect(registry.getTool(mcpTool.name)).toBeUndefined();
    }

    it('honors a legacy dotted disabled MCP tool name', () => {
      expectLegacyNameHonored(
        'mcp__zybio__literature.search_pubmed',
        'zybio',
        'literature.search_pubmed',
      );
    });

    it('honors a legacy truncated disabled MCP tool name', () => {
      const rawName = `mcp__server__${'x'.repeat(80)}`;
      const legacyName = rawName.slice(0, 28) + '___' + rawName.slice(-32);
      expectLegacyNameHonored(legacyName, 'server', 'x'.repeat(80));
    });

    it('publishes the exact raw identity through getPermissionAliases (#10199)', () => {
      const registry = new ToolRegistry(config);
      const mcpTool = mcp('foo:bar', 'a.b');
      registry.registerTool(mcpTool);

      // The exact raw spelling comes first — it is the only spelling the
      // permission matcher accepts as provenance for legacy unsafe rules —
      // followed by the legacy reduction for pre-normalization settings.
      expect(registry.getPermissionAliases(mcpTool.name)).toEqual([
        'mcp__foo:bar__a.b',
        generateLegacyMcpToolName('mcp__foo:bar__a.b'),
      ]);
      expect(registry.getPermissionAliases('read_file')).toBeUndefined();
    });

    it('disables an MCP tool whose disabledTools entry uses the legacy spelling', () => {
      // The legacy reduction is the spelling `isToolDisabled`'s surviving
      // `normalizeMcpToolName(entry) === name` arm cannot reach, so only the
      // alias channel can disable this tool.
      const legacyName = generateLegacyMcpToolName('mcp__foo:bar__a.b');
      const registry = registryFor({ disabledTools: [legacyName] });
      const mcpTool = mcp('foo:bar', 'a.b');

      expect(mcpTool.name).not.toBe(legacyName);
      expect(normalizeMcpToolName(legacyName)).not.toBe(mcpTool.name);
      registry.registerTool(mcpTool);
      expect(registry.getTool(mcpTool.name)).toBeUndefined();
    });

    it('keeps a legacy disabledTools entry effective when the reduction is withheld from permissionAliases (R4-2)', () => {
      // A 24-char server key: the truncation cut reaches the key segment, so
      // the R12-1 gate withholds the legacy reduction from the permission
      // channel — but `disabledTools` over-matching is the permitted
      // fail-closed direction, and a pre-normalization entry must still
      // suppress registration (main's behavior, restored via the ungated
      // disabledToolAliases channel).
      const server = 's'.repeat(24);
      const rawName = `mcp__${server}__${'t'.repeat(40)}`;
      const legacyName = generateLegacyMcpToolName(rawName);
      const registry = registryFor({ disabledTools: [legacyName] });
      const mcpTool = mcp(server, 't'.repeat(40));

      // Premise: the permission channel withholds this reduction, and the
      // normalize fallback cannot reach it either — only the ungated
      // disabled-tools channel can.
      expect(mcpTool.permissionAliases).not.toContain(legacyName);
      expect(normalizeMcpToolName(legacyName)).not.toBe(mcpTool.name);
      registry.registerTool(mcpTool);
      expect(registry.getTool(mcpTool.name)).toBeUndefined();
    });

    it('keeps a legacy disabledTools entry effective at the app-tool and registry-copy sites after setDisabledTools (R14-3)', () => {
      // Same 24-char-key / 40-char-tool fixture as R4-2 above: the R12-1
      // gate withholds this tool's legacy reduction from permissionAliases,
      // so only the ungated disabledToolAliases channel can suppress it.
      // Registration happens while disabledTools is empty (the tool lands
      // in mcpAppTools); the ACP settings-reload path then calls
      // config.setDisabledTools with the legacy spelling verbatim — no
      // re-registration — and every consumer site must honor it.
      const server = 's'.repeat(24);
      const serverToolName = 't'.repeat(40);
      const legacyName = generateLegacyMcpToolName(
        `mcp__${server}__${serverToolName}`,
      );
      const registry = new ToolRegistry(config);
      const mcpTool = appTool(server, serverToolName, ['app']);

      // Premise: the permission channel withholds this reduction, and the
      // normalize fallback cannot reach it either.
      expect(mcpTool.permissionAliases).not.toContain(legacyName);
      expect(normalizeMcpToolName(legacyName)).not.toBe(mcpTool.name);

      registry.registerTool(mcpTool);
      expect(registry.getMcpAppTool(server, serverToolName)).toBe(mcpTool);

      // Mid-session disable in the pre-normalization legacy spelling, with
      // no re-registration (acpAgent's settings-reload path).
      config.setDisabledTools(new Set([legacyName]));

      expect(registry.getMcpAppTool(server, serverToolName)).toBeUndefined();
      expect(registry.hasMcpAppResource(server, 'ui://app/view')).toBe(false);

      const dest = new ToolRegistry(config);
      dest.copyDiscoveredToolsFrom(registry);
      expect(dest.getMcpAppTool(server, serverToolName)).toBeUndefined();
    });

    it('skips lazy factories whose name is in Config.disabledTools', async () => {
      const registry = registryFor({ disabledTools: ['structured_output'] });
      lazy(registry, 'structured_output');
      lazy(registry, 'sequential_thinking');
      // Disabled factory never materializes.
      expect(await registry.ensureTool('structured_output')).toBeUndefined();
      // Non-disabled factory still materializes.
      const live = await registry.ensureTool('sequential_thinking');
      expect(live).toBeDefined();
      expect(live!.name).toBe('sequential_thinking');
    });

    it('does not retroactively unregister tools registered before toggle (next-refresh semantic)', () => {
      // Toggle semantics are documented as "effective on next refresh / ACP
      // child spawn"; a Set lookup at register time cannot undo a prior
      // registration. This test pins the contract.
      const registry = new ToolRegistry(config);
      register(registry, 'live-tool');
      expect(registry.getTool('live-tool')).toBeDefined();
      // Simulate a "fresh Config" with the tool now disabled.
      const next = registryFor({ disabledTools: ['live-tool'] });
      register(next, 'live-tool');
      // The new registry skips; the old registry is unaffected.
      expect(next.getTool('live-tool')).toBeUndefined();
      expect(registry.getTool('live-tool')).toBeDefined();
    });

    it('honors disabledTools against the renamed name when an MCP tool collides with a lazy factory (#4282 fold-in 2 CV3)', async () => {
      // Operator disabled `mcp__rogue-server__structured_output`, the
      // renamed-and-exposed name. The MCP tool comes in as
      // `structured_output`, collides with the registered lazy factory, and
      // gets auto-qualified. The post-rename re-check must observe the
      // disabled set against the FINAL registration name and skip insertion.
      const registry = registryFor({
        disabledTools: ['mcp__rogue-server__structured_output'],
      });
      lazy(registry, 'structured_output');
      registry.registerTool(mcp('rogue-server', 'structured_output'));
      // The renamed MCP tool must NOT have been inserted.
      expect(
        registry.getTool('mcp__rogue-server__structured_output'),
      ).toBeUndefined();
      // The lazy factory still owns the canonical name.
      const resolved = await registry.ensureTool('structured_output');
      expect(resolved).toBeDefined();
      expect(resolved).not.toBeInstanceOf(DiscoveredMCPTool);
    });
  });

  /** Registers tools with names and displayNames in non-alphabetical order. */
  function registerOutOfOrder(): void {
    register(
      toolRegistry,
      new MockTool({ name: 'c-tool', displayName: 'Tool C' }),
      new MockTool({ name: 'a-tool', displayName: 'Tool A' }),
      new MockTool({ name: 'b-tool', displayName: 'Tool B' }),
    );
  }

  describe('getAllTools', () => {
    it('should return all registered tools sorted alphabetically by displayName', () => {
      registerOutOfOrder();

      const displayNames = toolRegistry.getAllTools().map((t) => t.displayName);

      // Assert that the returned array is sorted by displayName
      expect(displayNames).toEqual(['Tool A', 'Tool B', 'Tool C']);
    });
  });

  describe('getAllToolNames', () => {
    it('should return all registered tool names', () => {
      registerOutOfOrder();

      // Assert that the returned array contains all tool names
      expect(toolRegistry.getAllToolNames()).toEqual([
        'c-tool',
        'a-tool',
        'b-tool',
      ]);
    });

    it('should include factory-registered tools that have not yet been loaded', () => {
      register(toolRegistry, 'loaded-tool');
      toolRegistry.registerFactory('lazy-tool', async () => {
        throw new Error('should not be called');
      });

      const names = toolRegistry.getAllToolNames();

      expect(names).toContain('loaded-tool');
      expect(names).toContain('lazy-tool');
    });
  });

  describe('media-policy tool visibility', () => {
    class MockMediaPolicyTool extends MockTool {
      override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
        return {
          kind: 'media_policy',
          inputMediaTypes: ['image'],
          outputs: [{ kind: 'media', required: true }],
        };
      }
    }

    const mediaTool = () =>
      new MockMediaPolicyTool({ name: 'omni_compress_image' });

    it('excludes media-policy tools from getFunctionDeclarations by default', () => {
      register(toolRegistry, 'visible', mediaTool());

      expect(declared(toolRegistry)).toEqual(['visible']);
    });

    it('keeps media-policy tools hidden even with includeDeferred: true', () => {
      // agent-core's wildcard/default branches call
      // getFunctionDeclarations({ includeDeferred: true }); the media-policy
      // filter must hold there too.
      register(toolRegistry, mediaTool());

      expect(declared(toolRegistry, { includeDeferred: true })).toEqual([]);
    });

    it('excludes media-policy tools from getFunctionDeclarationsFiltered even when named explicitly', () => {
      register(toolRegistry, 'visible', mediaTool());

      expect(
        declaredFiltered(toolRegistry, ['visible', 'omni_compress_image']),
      ).toEqual(['visible']);
    });

    it.each([false, true])(
      'applies modelAccess=%s to CodeModeOnly bindings',
      (enabled) => {
        const registry = registryFor({
          codeModeOnly: true,
          omniPolicyTools: {
            omni_compress_image: { modelAccess: { enabled } },
          },
        });
        const tool = mediaTool();
        register(registry, tool, 'exec');
        expect(
          registry
            .getCodeModeBindingPlan()
            .bindings.some((binding) => binding.name === tool.name),
        ).toBe(enabled);
        for (const declarations of [
          registry.getFunctionDeclarations(),
          registry.getFunctionDeclarationsFiltered(['exec', tool.name]),
        ]) {
          expect(
            declarations
              .find((item) => item.name === 'exec')
              ?.description?.includes('tools.omni_compress_image('),
          ).toBe(enabled);
        }
        expect(registry.getTool(tool.name)).toBe(tool);
      },
    );

    it('declares media-policy tools when modelAccess.enabled is true', () => {
      const registry = registryFor({
        omniPolicyTools: {
          omni_compress_image: { modelAccess: { enabled: true } },
        },
      });
      register(registry, mediaTool());

      expect(declared(registry)).toEqual(['omni_compress_image']);
      expect(declaredFiltered(registry, ['omni_compress_image'])).toEqual([
        'omni_compress_image',
      ]);
    });
  });

  describe('deferred tool filtering', () => {
    it('exposes structured memory tools only in structured recall mode', () => {
      toolRegistry.registerTool(new MockTool({ name: 'search_memory' }));
      toolRegistry.registerTool(new MockTool({ name: 'manage_memory' }));
      toolRegistry.registerTool(new MockTool({ name: 'read_file' }));
      const mode = vi.spyOn(config, 'getMemoryRecallMode');

      mode.mockReturnValue('legacy');
      expect(
        toolRegistry
          .getFunctionDeclarations()
          .map((declaration) => declaration.name),
      ).toEqual(['read_file']);

      mode.mockReturnValue('structured');
      expect(
        toolRegistry
          .getFunctionDeclarations()
          .map((declaration) => declaration.name),
      ).toEqual(['manage_memory', 'read_file', 'search_memory']);
    });

    it('does not declare exec for an explicitly empty code-mode allowlist', () => {
      vi.spyOn(config, 'getToolMode').mockReturnValue(ToolMode.CodeModeOnly);
      toolRegistry.registerTool(new MockTool({ name: 'exec' }));
      toolRegistry.registerTool(new MockTool({ name: 'read_file' }));
      expect(toolRegistry.getFunctionDeclarationsFiltered([])).toEqual([]);
      expect(
        toolRegistry
          .getFunctionDeclarationsFiltered(['read_file'])
          .map((tool) => tool.name),
      ).toContain('exec');
    });

    it('keeps structured memory tools out of the code-mode bindings in legacy mode', () => {
      // A code-mode session reaches these tools through the exec binding plan,
      // not through getFunctionDeclarations, so the recall-mode filter has to
      // be applied there too — otherwise legacy mode advertises tools whose
      // every call is denied.
      toolRegistry.registerTool(new MockTool({ name: 'search_memory' }));
      toolRegistry.registerTool(new MockTool({ name: 'manage_memory' }));
      toolRegistry.registerTool(new MockTool({ name: 'read_file' }));
      const mode = vi.spyOn(config, 'getMemoryRecallMode');

      mode.mockReturnValue('legacy');
      expect(
        toolRegistry
          .getCodeModeBindingPlan()
          .bindings.map((binding) => binding.name)
          .sort(),
      ).toEqual(['read_file']);

      mode.mockReturnValue('structured');
      expect(
        toolRegistry
          .getCodeModeBindingPlan()
          .bindings.map((binding) => binding.name)
          .sort(),
      ).toEqual(['manage_memory', 'read_file', 'search_memory']);
    });

    /** An ACP config whose host supports Goal proposals. */
    function acpGoalConfig(): Config {
      const acpConfig = new Config({
        ...baseConfigParams,
        experimentalZedIntegration: true,
      });
      acpConfig.setGoalProposalHostSupported(true);
      return acpConfig;
    }

    it('sorts visible function declarations by canonical name', () => {
      register(toolRegistry, 'zeta', 'alpha', 'middle');

      expect(declared(toolRegistry)).toEqual(['alpha', 'middle', 'zeta']);
    });

    it('only declares Goal proposals during an ACP turn with a responder', () => {
      const acpConfig = acpGoalConfig();
      const registry = new ToolRegistry(acpConfig);
      register(registry, 'other_tool', 'propose_goal');
      const both = ['other_tool', 'propose_goal'];
      expect(declared(registry)).toEqual(['other_tool']);
      expect(declaredFiltered(registry, both)).toEqual(['other_tool']);
      acpConfig.setGoalProposalTurnKey('user-turn');
      expect(declared(registry)).toEqual(['other_tool', 'propose_goal']);
      expect(declaredFiltered(registry, both)).toEqual([
        'other_tool',
        'propose_goal',
      ]);
      acpConfig.setGoalProposalTurnKey(undefined);
      expect(declared(registry)).toEqual(['other_tool']);
    });

    it('keeps Goal proposals declared in an interactive terminal', () => {
      const registry = registryFor({ interactive: true });
      register(registry, 'propose_goal');

      expect(declared(registry)).toEqual(['propose_goal']);
    });

    it('excludes shouldDefer tools from getFunctionDeclarations by default', () => {
      register(toolRegistry, 'visible', deferred('hidden'));

      expect(declared(toolRegistry)).toEqual(['visible']);
    });

    it('includes deferred tools when includeDeferred is true', () => {
      register(toolRegistry, 'visible-z', deferred('hidden-a'), 'visible-a');

      expect(declared(toolRegistry, { includeDeferred: true })).toEqual([
        'hidden-a',
        'visible-a',
        'visible-z',
      ]);
    });

    it('filters deferred tools before sorting visible declarations', () => {
      register(toolRegistry, 'visible-z', deferred('hidden-a'), 'visible-a');

      expect(declared(toolRegistry)).toEqual(['visible-a', 'visible-z']);
    });

    it('always keeps alwaysLoad tools visible even when shouldDefer is true', () => {
      register(toolRegistry, deferred('z', { alwaysLoad: true }), 'a');

      expect(declared(toolRegistry)).toEqual(['a', 'z']);
    });

    // Regression for #5210: the real exit_plan_mode is deferred-category but
    // must stay declared, otherwise the model cannot call it in plan mode.
    it('keeps the real exit_plan_mode tool declared (#5210)', () => {
      register(toolRegistry, new ExitPlanModeTool(config));

      expect(declared(toolRegistry)).toContain('exit_plan_mode');
      expect(summaryNames(toolRegistry)).not.toContain('exit_plan_mode');
    });

    it('includes revealed deferred tools in getFunctionDeclarations', () => {
      register(
        toolRegistry,
        'visible-m',
        deferred('hidden-a'),
        deferred('other-hidden'),
        'visible-z',
      );

      toolRegistry.revealDeferredTool('hidden-a');

      expect(declared(toolRegistry)).toEqual([
        'hidden-a',
        'visible-m',
        'visible-z',
      ]);
      expect(toolRegistry.isDeferredToolRevealed('hidden-a')).toBe(true);
      expect(toolRegistry.isDeferredToolRevealed('other-hidden')).toBe(false);
    });

    it('sorts MCP declarations deterministically regardless of registration order', () => {
      const github = () =>
        mcp('github', 'search_issues', 'Search GitHub issues');
      const filesystem = () =>
        mcp('filesystem', 'read_tree', 'Read filesystem tree');
      const registryA = new ToolRegistry(config);
      const registryB = new ToolRegistry(config);
      register(registryA, github(), filesystem());
      register(registryB, filesystem(), github());
      for (const registry of [registryA, registryB]) {
        registry.revealDeferredTool('mcp__github__search_issues');
        registry.revealDeferredTool('mcp__filesystem__read_tree');
      }

      const namesA = declared(registryA);

      expect(namesA).toEqual([
        'mcp__filesystem__read_tree',
        'mcp__github__search_issues',
      ]);
      expect(declared(registryB)).toEqual(namesA);
    });

    it('getDeferredToolSummary lists deferred tools sorted by name', () => {
      register(
        toolRegistry,
        'zebra',
        deferred('bravo', { description: 'bravo desc' }),
        deferred('alpha', { description: 'alpha desc' }),
        // alwaysLoad: excluded from summary
        deferred('charlie', { description: 'charlie desc', alwaysLoad: true }),
      );

      expect(toolRegistry.getDeferredToolSummary()).toEqual([
        { name: 'alpha', description: 'alpha desc' },
        { name: 'bravo', description: 'bravo desc' },
      ]);
    });

    describe('preloadDeferredToolsWithinBudget', () => {
      const makeMcpTool = (serverToolName: string) =>
        mcp('files', serverToolName, `${serverToolName} description`);
      const tokensFor = (...tools: Array<{ schema: unknown }>) =>
        Math.ceil(
          tools.reduce(
            (chars, tool) => chars + JSON.stringify(tool.schema).length,
            0,
          ) / CHARS_PER_TOKEN,
        );

      it('reveals all deferred tools, bundled and MCP, when their schemas fit the budget', () => {
        const toolA = makeMcpTool('read_tree');
        const toolB = makeMcpTool('write_tree');
        const bundled = deferred('bundled');
        register(toolRegistry, toolA, toolB, bundled);

        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(toolA, toolB, bundled),
        );

        expect(revealed).toBe(3);
        const names = declared(toolRegistry);
        expect(names).toContain(toolA.name);
        expect(names).toContain(toolB.name);
        expect(names).toContain('bundled');
      });

      it('reveals nothing when the combined schemas exceed the budget', () => {
        const toolA = makeMcpTool('read_tree');
        const toolB = makeMcpTool('write_tree');
        register(toolRegistry, toolA, toolB);

        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(toolA, toolB) - 1,
        );

        expect(revealed).toBe(0);
        expect(toolRegistry.isDeferredToolRevealed(toolA.name)).toBe(false);
        expect(toolRegistry.isDeferredToolRevealed(toolB.name)).toBe(false);
      });

      it('counts bundled deferred tools toward the budget (all-or-nothing)', () => {
        const mcpTool = makeMcpTool('read_tree');
        register(toolRegistry, mcpTool, deferred('bundled'));

        // Budget covers the MCP tool alone; the bundled tool pushes the union
        // over. A partial (MCP-only) reveal would leave the prefix unstable
        // anyway, so nothing is revealed.
        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(mcpTool),
        );

        expect(revealed).toBe(0);
        expect(toolRegistry.isDeferredToolRevealed(mcpTool.name)).toBe(false);
        expect(toolRegistry.isDeferredToolRevealed('bundled')).toBe(false);
      });

      it('counts already-revealed tools toward the budget', () => {
        const toolA = makeMcpTool('read_tree');
        const toolB = makeMcpTool('write_tree');
        register(toolRegistry, toolA, toolB);
        toolRegistry.revealDeferredTool(toolA.name);

        // Budget covers one tool but not both: the already-revealed tool must
        // keep the second one deferred rather than ratcheting past the budget
        // one reveal at a time.
        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(toolB),
        );

        expect(revealed).toBe(0);
        expect(toolRegistry.isDeferredToolRevealed(toolB.name)).toBe(false);
      });

      it('excludes visible deferred tools from the preload budget', () => {
        const visibleTool = deferred('visible', {
          description: 'x'.repeat(CHARS_PER_TOKEN * 10),
        });
        const deferredTool = deferred('deferred');
        const registry = registryFor({ visibleTools: [visibleTool.name] });
        register(registry, visibleTool, deferredTool);

        const revealed = registry.preloadDeferredToolsWithinBudget(
          tokensFor(deferredTool),
        );

        expect(revealed).toBe(1);
        expect(registry.isDeferredToolRevealed(deferredTool.name)).toBe(true);
        expect(declared(registry)).toEqual(
          expect.arrayContaining([visibleTool.name, deferredTool.name]),
        );
      });

      it('excludes always-loaded tools from the preload budget', () => {
        const alwaysLoadedTool = deferred('always-loaded', {
          description: 'x'.repeat(CHARS_PER_TOKEN * 10),
          alwaysLoad: true,
        });
        const deferredTool = deferred('deferred');
        register(toolRegistry, alwaysLoadedTool, deferredTool);

        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(deferredTool),
        );

        expect(revealed).toBe(1);
        expect(toolRegistry.isDeferredToolRevealed(deferredTool.name)).toBe(
          true,
        );
        expect(declared(toolRegistry)).toEqual(
          expect.arrayContaining([alwaysLoadedTool.name, deferredTool.name]),
        );
      });
    });

    const cronList = () =>
      mcp('schedule-server', 'cron_list', 'list scheduled jobs');

    it('getDeferredToolSummary includes MCP server names', () => {
      register(toolRegistry, cronList());

      expect(toolRegistry.getDeferredToolSummary()).toEqual([
        {
          name: 'mcp__schedule-server__cron_list',
          description: 'list scheduled jobs',
          serverName: 'schedule-server',
        },
      ]);
    });

    it('getDeferredToolSummary is empty in CodeModeOnly', () => {
      // Code Mode discovers tools without a startup catalog or Direct-mode
      // bridge reminders.
      const registry = registryFor({ codeModeOnly: true });
      register(registry, deferred('deferred'), cronList());

      expect(registry.getDeferredToolSummary()).toEqual([]);
    });

    it('removeMcpToolsByServer also drops revealedDeferred entries', async () => {
      // Pin the regression: a server-disconnect-then-reconnect cycle that
      // re-registers a tool of the same name must NOT inherit
      // `revealed: true` from before the disconnect — that would leak into
      // `getFunctionDeclarations` before the model has any way to know the
      // tool exists this session.
      const tool = mcp('slack', 'send_message', 'send a message');
      toolRegistry.registerTool(tool);
      // Use the actual generated tool name (mcp__slack__send_message): the
      // reveal-state map is keyed by that, not the server-tool-name alone.
      const toolName = tool.name;
      toolRegistry.revealDeferredTool(toolName);
      expect(toolRegistry.isDeferredToolRevealed(toolName)).toBe(true);

      toolRegistry.removeMcpToolsByServer('slack');
      expect(toolRegistry.isDeferredToolRevealed(toolName)).toBe(false);
    });

    it('keeps the reviewed declaration after removal so a changed replacement is refused (#11321)', () => {
      const tool = mcp('slack', 'send_message', 'send a message', {
        type: 'object',
        properties: { text: { type: 'string' } },
      });
      toolRegistry.registerTool(tool);
      toolRegistry.recordReviewedDeclaration(tool);
      const recorded = toolRegistry.getReviewedDeclaration(tool.name);
      expect(recorded).toBe(deferredDeclarationFingerprint(tool));

      toolRegistry.removeMcpToolsByServer('slack');

      // Deliberately NOT pruned. A disconnect does not take the reviewed
      // schema out of history, and the entry can only match the same server,
      // schema name and parameter schema — so it either still describes the
      // live tool or forces a re-review. History replacement is what clears
      // it (#12569).
      expect(toolRegistry.getReviewedDeclaration(tool.name)).toBe(recorded);

      // A replacement republishing a changed contract does not match it.
      const replacement = mcp('slack', 'send_message', 'send a message', {
        type: 'object',
        properties: { channel: { type: 'string' } },
      });
      expect(deferredDeclarationFingerprint(replacement)).not.toBe(recorded);
    });

    it('clearReviewedDeclarations forgets every review (#12569)', () => {
      const first = new MockTool({ name: 'first_deferred', shouldDefer: true });
      const second = new MockTool({
        name: 'second_deferred',
        shouldDefer: true,
      });
      toolRegistry.registerTool(first);
      toolRegistry.registerTool(second);
      toolRegistry.recordReviewedDeclaration(first);
      toolRegistry.recordReviewedDeclaration(second);

      toolRegistry.clearReviewedDeclarations();

      expect(toolRegistry.getReviewedDeclaration(first.name)).toBeUndefined();
      expect(toolRegistry.getReviewedDeclaration(second.name)).toBeUndefined();
    });

    it('includes deferred tools listed in visibleTools in function declarations', () => {
      const registry = registryFor({ visibleTools: ['should-appear'] });
      register(
        registry,
        'always-visible',
        deferred('should-appear'),
        deferred('still-hidden'),
      );

      const names = declared(registry);
      expect(names).toContain('always-visible');
      expect(names).toContain('should-appear');
      expect(names).not.toContain('still-hidden');
    });

    it('excludes visibleTools items from deferred tool summary', () => {
      const registry = registryFor({ visibleTools: ['alpha'] });
      register(
        registry,
        deferred('alpha', { description: 'a' }),
        deferred('beta', { description: 'b' }),
      );

      expect(registry.getDeferredToolSummary()).toEqual([
        { name: 'beta', description: 'b' },
      ]);
    });

    it('excludes unavailable Goal proposals from the deferred summary', () => {
      const acpConfig = acpGoalConfig();
      const registry = new ToolRegistry(acpConfig);
      register(
        registry,
        deferred('propose_goal', { description: 'propose a Goal' }),
      );

      expect(registry.getDeferredToolSummary()).toEqual([]);
      acpConfig.setGoalProposalTurnKey('user-turn');
      expect(registry.getDeferredToolSummary()).toEqual([
        { name: 'propose_goal', description: 'propose a Goal' },
      ]);
    });

    it('visibleTools has no effect on non-deferred tools', () => {
      const registry = registryFor({ visibleTools: ['regular'] });
      register(registry, 'regular');

      expect(declared(registry)).toContain('regular');
      expect(registry.getDeferredToolSummary()).toEqual([]);
    });

    it('disabledTools takes priority over visibleTools', () => {
      const registry = registryFor({
        disabledTools: ['contested'],
        visibleTools: ['contested'],
      });
      register(registry, deferred('contested'));

      expect(declared(registry)).not.toContain('contested');
    });

    it('visible tool survives clearRevealedDeferredTools', () => {
      const registry = registryFor({ visibleTools: ['web_fetch'] });
      register(registry, deferred('web_fetch'), deferred('monitor'));

      // Both start visible (web_fetch via visibleTools, monitor is hidden)
      expect(declared(registry)).toContain('web_fetch');

      registry.clearRevealedDeferredTools();

      // web_fetch stays — it's not in revealedDeferred
      expect(declared(registry)).toContain('web_fetch');
    });

    it('pinned reveal survives clearRevealedDeferredTools, discovered reveals do not', () => {
      const registry = registryFor();
      register(registry, deferred('daemon-setup'), deferred('discovered'));
      registry.revealDeferredTool('daemon-setup');
      registry.pinDeferredToolReveal('daemon-setup');
      registry.revealDeferredTool('discovered');

      registry.clearRevealedDeferredTools();

      // A transient reveal is dropped by the reset...
      expect(registry.isDeferredToolRevealed('discovered')).toBe(false);
      expect(declared(registry)).not.toContain('discovered');
      // ...but the pinned session-setup reveal survives it, so the fresh
      // session's declaration list still offers the tool (a `/clear` whose
      // budget-based preload withholds it would otherwise strand it).
      expect(registry.isDeferredToolRevealed('daemon-setup')).toBe(true);
      expect(declared(registry)).toContain('daemon-setup');
    });

    it('pin for an unregistered tool reveals nothing on clear', () => {
      const registry = registryFor();
      registry.pinDeferredToolReveal('ghost');

      registry.clearRevealedDeferredTools();

      expect(registry.isDeferredToolRevealed('ghost')).toBe(false);
    });
  });

  // #10075: built-in tools an active `settings.tools.eager` allowlist does not
  // name are demoted to deferred instead of being dropped from the registry,
  // so they stay listed in /tools and reachable through the `tool_search` +
  // `tool_call` bridge while their schemas stay out of the eager model
  // request (#9827).
  describe('permission-deferred tools (#10075)', () => {
    const HIDDEN = 'hidden_by_allowlist';

    async function addPermissionDeferred(registry = toolRegistry) {
      registry.registerPermissionDeferredFactory(
        HIDDEN,
        async () => new MockTool({ name: HIDDEN }),
      );
      await registry.warmAll();
    }

    it('registers the tool but hides it from the eager declarations', async () => {
      register(toolRegistry, 'visible');
      await addPermissionDeferred();

      // Registered: listed for /tools and resolvable like any other tool.
      expect(toolRegistry.getAllToolNames()).toContain(HIDDEN);
      expect(toolRegistry.getTool(HIDDEN)).toBeDefined();
      expect(toolRegistry.isPermissionDeferred(HIDDEN)).toBe(true);

      // Hidden from the eager model request...
      expect(declared(toolRegistry)).toEqual(['visible']);
      // ...but present in diagnostics / includeDeferred views...
      expect(declared(toolRegistry, { includeDeferred: true })).toContain(
        HIDDEN,
      );
      // ...and discoverable through the deferred summary (ToolSearch + ToolCall).
      expect(summaryNames(toolRegistry)).toContain(HIDDEN);
      expect(toolRegistry.isDeferredAndHidden(HIDDEN)).toBe(true);
    });

    it('keeps the tool visible when listed in visibleTools', async () => {
      const registry = registryFor({ visibleTools: [HIDDEN] });
      await addPermissionDeferred(registry);

      expect(declared(registry)).toContain(HIDDEN);
      expect(registry.isDeferredAndHidden(HIDDEN)).toBe(false);
      expect(summaryNames(registry)).not.toContain(HIDDEN);
    });

    it('includes a permission-deferred schema after an explicit reveal', async () => {
      await addPermissionDeferred();

      toolRegistry.revealDeferredTool(HIDDEN);

      expect(declared(toolRegistry)).toContain(HIDDEN);
      expect(toolRegistry.isDeferredAndHidden(HIDDEN)).toBe(false);
    });

    it('is never auto-revealed by the budget preload (#9827)', async () => {
      // An ordinary deferred tool is preloaded when its schema fits the
      // budget; a permission-deferred tool must stay hidden regardless —
      // auto-revealing it would re-add exactly the schema the allowlist keeps
      // out of the eager request.
      register(toolRegistry, deferred('ordinary-deferred'));
      await addPermissionDeferred();

      const revealed = toolRegistry.preloadDeferredToolsWithinBudget(1_000_000);

      expect(revealed).toBe(1);
      expect(toolRegistry.isDeferredToolRevealed('ordinary-deferred')).toBe(
        true,
      );
      expect(toolRegistry.isDeferredToolRevealed(HIDDEN)).toBe(false);
      expect(declared(toolRegistry)).toEqual(['ordinary-deferred']);
    });
  });

  describe('getToolsByServer', () => {
    it('should return an empty array if no tools match the server name', () => {
      register(toolRegistry, 'mock-tool');
      expect(toolRegistry.getToolsByServer('any-mcp-server')).toEqual([]);
    });

    it('should return only tools matching the server name, sorted by name', async () => {
      const server1Name = 'mcp-server-uno';
      const server2Name = 'mcp-server-dos';
      const mcpTool2 = mcp(server2Name, 'tool-on-server2', 'd4');
      register(
        toolRegistry,
        mcp(server1Name, 'zebra-tool', 'd1'),
        mcp(server1Name, 'apple-tool', 'd2'),
        mcp(server1Name, 'banana-tool', 'd3'),
        mcpTool2,
        'regular-tool',
      );

      const toolsFromServer1 = toolRegistry.getToolsByServer(server1Name);

      // Assert that the array has the correct tools and is sorted by name
      expect(toolsFromServer1).toHaveLength(3);
      expect(toolsFromServer1.map((t) => t.name)).toEqual([
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
    /**
     * Runs discovery through a discovery command whose child prints
     * `declarations` (as `function_declarations`) and exits 0.
     */
    async function discoverFromCommand(declarations: FunctionDeclaration[]) {
      mockConfigGetToolDiscoveryCommand.mockReturnValue('my-discovery-command');
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockChildProcess as any);
      // Simulate stdout data, then process close.
      const payload = [{ function_declarations: declarations }];
      fireOn(
        mockChildProcess.stdout.on,
        'data',
        Buffer.from(JSON.stringify(payload)),
        mockChildProcess,
      );
      fireOn(mockChildProcess.on, 'close', 0, mockChildProcess);
      await toolRegistry.discoverAllTools();
    }

    /** Activates a `tools.eager` allowlist with the given permission rules. */
    function useEagerAllowList(rules: {
      allow: string[];
      ask?: string[];
      deny?: string[];
      eager: string[];
    }): void {
      const pm = new PermissionManager({
        getPermissionsAllow: () => rules.allow,
        getPermissionsAsk: () => rules.ask ?? [],
        getPermissionsDeny: () => rules.deny ?? [],
        getCoreTools: () => undefined,
        getEagerTools: () => rules.eager,
        getProjectRoot: () => '/test/dir',
        getCwd: () => '/test/dir',
        getApprovalMode: () => 'default',
      });
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      vi.spyOn(config, 'getPermissionManager').mockReturnValue(pm);
    }

    it('should will preserve tool parametersJsonSchema during discovery from command', async () => {
      await discoverFromCommand([
        {
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
        },
      ]);

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

    it('defers command-discovered tools the tools.eager allowlist omits (#9827, #10075)', async () => {
      // An omitted discovered tool keeps its schema out of the eager model
      // request while staying registered and reachable via ToolSearch —
      // matching the registerLazy path built-ins go through. Dropping it
      // instead would recreate #10075's silent disappearance under a
      // different knob.
      useEagerAllowList({
        allow: ['covered_discovered_tool'],
        eager: ['covered_discovered_tool'],
      });

      await discoverFromCommand([
        decl('covered_discovered_tool', 'Covered by an allow rule'),
        decl('uncovered_discovered_tool', 'Not covered by any allow rule'),
      ]);

      expect(toolRegistry.getTool('covered_discovered_tool')).toBeDefined();
      expect(toolRegistry.getTool('uncovered_discovered_tool')).toBeDefined();
      // Registered, but held back from the eager request.
      expect(toolRegistry.isPermissionDeferred('covered_discovered_tool')).toBe(
        false,
      );
      expect(
        toolRegistry.isPermissionDeferred('uncovered_discovered_tool'),
      ).toBe(true);

      const copiedRegistry = new ToolRegistry(config);
      copiedRegistry.copyDiscoveredToolsFrom(toolRegistry);
      expect(
        copiedRegistry.isPermissionDeferred('uncovered_discovered_tool'),
      ).toBe(true);
      expect(declared(copiedRegistry)).not.toContain(
        'uncovered_discovered_tool',
      );
    });

    it('removes a command-discovered tool hit by a whole-tool deny rule even under an active tools.eager allowlist (#9827)', async () => {
      // settings.md pins the sibling semantic of the discovery gate: "A
      // whole-tool deny rule (no specifier) also removes the tool from the
      // registry — for built-in tools and tools found via
      // tools.discoveryCommand". The denied tool below IS covered by an allow
      // rule, so the allowlist gate alone would have kept it registered —
      // only the deny branch of isToolEnabled can reject it, which is exactly
      // what this test pins.
      const both = ['allowed_discovered_tool', 'denied_discovered_tool'];
      useEagerAllowList({
        allow: both,
        deny: ['denied_discovered_tool'],
        eager: both,
      });

      await discoverFromCommand([
        decl('allowed_discovered_tool', 'Covered by an allow rule'),
        decl(
          'denied_discovered_tool',
          'Covered by an allow rule AND a whole-tool deny rule',
        ),
      ]);

      expect(toolRegistry.getTool('allowed_discovered_tool')).toBeDefined();
      expect(toolRegistry.getTool('denied_discovered_tool')).toBeUndefined();
    });

    it('permission rules never deregister a command-discovered tool (#10075)', async () => {
      // Neither an allow rule nor an ask rule decides registration any more;
      // only tools.eager decides eager-vs-deferred, and only a deny rule
      // removes anything. The tool the eager list omits proves the gate is
      // genuinely active, so the registrations below cannot be a gate-bypass
      // artefact.
      useEagerAllowList({
        allow: ['allowed_discovered_tool'],
        ask: ['asked_discovered_tool'],
        eager: ['allowed_discovered_tool'],
      });

      await discoverFromCommand([
        decl('allowed_discovered_tool', 'Covered by an allow rule'),
        decl('asked_discovered_tool', 'Covered by an ask rule'),
        decl(
          'uncovered_discovered_tool',
          'Not covered by any allow or ask rule',
        ),
      ]);

      expect(toolRegistry.getTool('allowed_discovered_tool')).toBeDefined();
      expect(toolRegistry.getTool('asked_discovered_tool')).toBeDefined();
      expect(toolRegistry.getTool('uncovered_discovered_tool')).toBeDefined();
      // The ask-covered tool is not in tools.eager, so it defers like any
      // other omitted tool — "always confirm" never means "unavailable".
      expect(toolRegistry.isPermissionDeferred('asked_discovered_tool')).toBe(
        true,
      );
      expect(
        toolRegistry.isPermissionDeferred('uncovered_discovered_tool'),
      ).toBe(true);
    });

    /**
     * Discovers `declaration` through a spawned discovery child, then executes
     * it through a spawned tool-call child that writes `stderr` and exits with
     * `exitCode`.
     */
    async function discoverAndExecute(
      declaration: FunctionDeclaration,
      exitCode: number,
      stderr?: string,
    ) {
      mockConfigGetToolDiscoveryCommand.mockReturnValue('my-discovery-command');
      vi.spyOn(config, 'getToolCallCommand').mockReturnValue('my-call-command');
      const mockSpawn = vi.mocked(spawn);
      // --- Discovery Mock ---
      const discoveryProcess = {
        stdout: { on: vi.fn(), removeListener: vi.fn() },
        stderr: { on: vi.fn(), removeListener: vi.fn() },
        on: vi.fn(),
      };
      mockSpawn.mockReturnValueOnce(discoveryProcess as any);
      const payload = [{ functionDeclarations: [declaration] }];
      fireOn(
        discoveryProcess.stdout.on,
        'data',
        Buffer.from(JSON.stringify(payload)),
      );
      fireOn(discoveryProcess.on, 'close', 0);

      await toolRegistry.discoverAllTools();
      const discoveredTool = toolRegistry.getTool(declaration.name!);
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
      if (stderr !== undefined) {
        fireOn(executionProcess.stderr.on, 'data', Buffer.from(stderr));
      }
      fireOn(executionProcess.on, 'close', exitCode);

      return (discoveredTool as DiscoveredTool)
        .build({})
        .execute(new AbortController().signal);
    }

    it('strips Qwen-internal daemon secrets from the discovery and tool-call child env (#6601)', async () => {
      vi.stubEnv('QWEN_SERVER_TOKEN', 'serve-secret');
      vi.stubEnv('QWEN_DAEMON_TOKEN', 'daemon-secret');
      try {
        await discoverAndExecute(decl('secret-probe', 'A tool'), 0);

        // Both the discovery command and the tool-call command are child
        // processes launched on the agent's behalf, so neither may inherit
        // the internal daemon secrets.
        const mockSpawn = vi.mocked(spawn);
        for (const call of mockSpawn.mock.calls) {
          const env = (call[2] as { env: NodeJS.ProcessEnv }).env;
          expect(env['QWEN_SERVER_TOKEN']).toBeUndefined();
          expect(env['QWEN_DAEMON_TOKEN']).toBeUndefined();
          // Benign inherited env is preserved.
          expect(env['PATH']).toBeDefined();
        }
        expect(mockSpawn.mock.calls).toHaveLength(2);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('should return a DISCOVERED_TOOL_EXECUTION_ERROR on tool failure', async () => {
      const result = await discoverAndExecute(
        decl('failing-tool', 'A tool that fails'),
        1, // Non-zero exit code
        'Something went wrong',
      );

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
      vi.spyOn(config, 'getMcpServers').mockReturnValue({
        'my-mcp-server': {
          command: 'mcp-server-cmd',
          args: ['--port', '1234'],
          trust: true,
        },
      });

      await toolRegistry.discoverAllTools();

      expect(discoverSpy).toHaveBeenCalled();
    });
  });

  describe('DiscoveredToolInvocation', () => {
    it('should return the stringified params from getDescription', () => {
      const tool = new DiscoveredTool(config, 'test-tool', 'A test tool', {});
      const params = { param: 'testValue' };
      expect(tool.build(params).getDescription()).toBe(JSON.stringify(params));
    });
  });

  describe('ensureTool concurrency', () => {
    function countingFactory(tool: MockTool, failFirst = false) {
      const counter = { calls: 0 };
      toolRegistry.registerFactory(tool.name, async () => {
        counter.calls++;
        if (failFirst && counter.calls === 1) {
          throw new Error('transient failure');
        }
        return tool;
      });
      return counter;
    }

    it('runs the factory only once when two calls are made concurrently', async () => {
      const tool = new MockTool({ name: 'concurrent-tool' });
      const counter = countingFactory(tool);

      const [result1, result2] = await Promise.all([
        toolRegistry.ensureTool('concurrent-tool'),
        toolRegistry.ensureTool('concurrent-tool'),
      ]);

      expect(counter.calls).toBe(1);
      expect(result1).toBe(tool);
      expect(result2).toBe(tool);
    });

    it('runs the factory only once when warmAll() and ensureTool() overlap', async () => {
      const counter = countingFactory(new MockTool({ name: 'overlap-tool' }));

      const warmPromise = toolRegistry.warmAll();
      const ensurePromise = toolRegistry.ensureTool('overlap-tool');
      await Promise.all([warmPromise, ensurePromise]);

      expect(counter.calls).toBe(1);
    });

    it('clears the inflight entry on failure so subsequent calls can retry', async () => {
      const tool = new MockTool({ name: 'retry-tool' });
      const counter = countingFactory(tool, true);

      await expect(toolRegistry.ensureTool('retry-tool')).rejects.toThrow(
        'transient failure',
      );

      // Factory remains in the registry after a failure — the second call retries it.
      const result = await toolRegistry.ensureTool('retry-tool');
      expect(result).toBe(tool);
      expect(counter.calls).toBe(2);
    });
  });

  describe('warmAll strict mode', () => {
    const registerBadFactory = () =>
      toolRegistry.registerFactory('bad-tool', async () => {
        throw new Error('factory error');
      });

    it('throws when a factory fails and strict is true', async () => {
      registerBadFactory();

      await expect(toolRegistry.warmAll({ strict: true })).rejects.toThrow(
        'factory error',
      );
    });

    it('does not throw when a factory fails and strict is false (default)', async () => {
      registerBadFactory();

      await expect(toolRegistry.warmAll()).resolves.toBeUndefined();
    });

    it('still loads successful tools before throwing in strict mode', async () => {
      const goodTool = new MockTool({ name: 'good-tool' });
      toolRegistry.registerFactory('good-tool', async () => goodTool);
      registerBadFactory();

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

    /**
     * `flaky-server` has a DISCONNECTED status entry and the exclusion list
     * is empty; the McpClientManager transport teardown is stubbed (to
     * reject with `disconnectError` when given) to isolate the registry.
     */
    function flakyServer(disconnectError?: Error): void {
      updateMCPServerStatus('flaky-server', MCPServerStatus.DISCONNECTED);
      vi.spyOn(config, 'getExcludedMcpServers').mockReturnValue([]);
      const disconnect = vi.spyOn(
        McpClientManager.prototype,
        'disconnectServer',
      );
      if (disconnectError) disconnect.mockRejectedValue(disconnectError);
      else disconnect.mockResolvedValue(undefined);
    }

    const hasFlakyStatus = () => getAllMCPServerStatuses().has('flaky-server');
    const disable = () => toolRegistry.disableMcpServer('flaky-server');

    it('still removes the registry entry and updates the exclusion list when disconnect throws', async () => {
      flakyServer(new Error('boom'));
      const setExcludedSpy = vi
        .spyOn(config, 'setExcludedMcpServers')
        .mockImplementation(() => {});

      await expect(disable()).rejects.toThrow('boom');

      // Even though disconnect threw, the global status entry must be cleared
      // so the health pill stops counting the server, and the exclusion list
      // must still be updated so the server doesn't reappear on next discovery.
      expect(hasFlakyStatus()).toBe(false);
      expect(setExcludedSpy).toHaveBeenCalledWith(['flaky-server']);
    });

    it('still removes the registry entry when the exclusion-list update throws', async () => {
      // Defensive: if a future config implementation makes
      // setExcludedMcpServers throw, the status registry must still be
      // cleaned up — otherwise the health pill would keep a stale entry.
      flakyServer();
      vi.spyOn(config, 'setExcludedMcpServers').mockImplementation(() => {
        throw new Error('config write failed');
      });

      await expect(disable()).rejects.toThrow('config write failed');

      expect(hasFlakyStatus()).toBe(false);
    });

    it('removes the server from the global status registry so the health pill stops counting it', async () => {
      // An MCP server that connected and then dropped: the global registry
      // carries a DISCONNECTED entry for it.
      flakyServer();
      expect(hasFlakyStatus()).toBe(true);
      const setExcludedSpy = vi
        .spyOn(config, 'setExcludedMcpServers')
        .mockImplementation(() => {});

      await disable();

      expect(hasFlakyStatus()).toBe(false);
      expect(setExcludedSpy).toHaveBeenCalledWith(['flaky-server']);
    });

    it('updates the exclusion list before dropping the status entry', async () => {
      // Order matters: doctorChecks classifies a server as "disabled" only
      // when it appears in the exclusion list. If the status entry is dropped
      // before the exclusion list is updated, there's a window where the
      // server is reported as a connectivity failure instead of an
      // intentional disable.
      flakyServer();
      const callOrder: string[] = [];
      vi.spyOn(config, 'setExcludedMcpServers').mockImplementation(() => {
        callOrder.push(`setExcludedMcpServers:hasStatus=${hasFlakyStatus()}`);
      });

      await disable();

      // When setExcludedMcpServers ran, the status entry must still be
      // present — i.e. the exclusion list is updated first.
      expect(callOrder).toEqual(['setExcludedMcpServers:hasStatus=true']);
      expect(hasFlakyStatus()).toBe(false);
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
