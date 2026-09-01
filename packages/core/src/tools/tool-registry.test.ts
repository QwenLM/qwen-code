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
import { ToolRegistry, DiscoveredTool } from './tool-registry.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { ExitPlanModeTool } from './exitPlanMode.js';
import type { FunctionDeclaration, CallableTool } from '@google/genai';
import { mcpToTool } from '@google/genai';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { MockTool } from '../test-utils/mock-tool.js';
import { CHARS_PER_TOKEN } from '../services/tokenEstimation.js';

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
  memoryFileCount: 0,
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
    vi.spyOn(config, 'getResourceRegistry').mockReturnValue({
      clear: vi.fn(),
      removeResourcesByServer: vi.fn(),
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

    it('replaces core tools while preserving discovered project and MCP tools', async () => {
      const projectTool = new DiscoveredTool(
        config,
        'project-tool',
        'project tool',
        {},
      );
      const mcpTool = new DiscoveredMCPTool(
        {} as CallableTool,
        'server',
        'remote-tool',
        'remote tool',
        {},
      );
      toolRegistry.registerTool(new MockTool({ name: 'old-core' }));
      toolRegistry.registerTool(projectTool);
      toolRegistry.registerTool(mcpTool);

      const source = new ToolRegistry(config);
      source.registerTool(new MockTool({ name: 'new-core' }));
      await toolRegistry.replaceCoreToolsFrom(source);

      expect(toolRegistry.getTool('old-core')).toBeUndefined();
      expect(toolRegistry.getTool('new-core')).toBeDefined();
      expect(toolRegistry.getTool('project-tool')).toBe(projectTool);
      expect(toolRegistry.getTool(mcpTool.name)).toBe(mcpTool);
    });

    it('clears project runtime tools while preserving MCP tools', async () => {
      const mcpTool = new DiscoveredMCPTool(
        {} as CallableTool,
        'server',
        'remote-tool',
        'remote tool',
        {},
      );
      toolRegistry.registerTool(new MockTool({ name: 'core-tool' }));
      toolRegistry.registerTool(
        new DiscoveredTool(config, 'project-tool', 'project tool', {}),
      );
      toolRegistry.registerTool(mcpTool);

      await toolRegistry.clearProjectRuntimeTools();

      // Core tools survive: this runs from the `/cd` refresh's catch block,
      // and wiping them there left the session with no read_file/edit/shell
      // whenever the target's discovery command merely exited non-zero.
      expect(toolRegistry.getTool('core-tool')).toBeDefined();
      expect(toolRegistry.getTool('project-tool')).toBeUndefined();
      expect(toolRegistry.getTool(mcpTool.name)).toBe(mcpTool);
    });

    it('preserves session-owned tools and factories during project replacement', async () => {
      const sessionTool = new MockTool({ name: 'session-tool' });
      const sessionFactory = vi.fn(
        async () => new MockTool({ name: 'session-factory' }),
      );
      toolRegistry.registerSessionTool(sessionTool);
      toolRegistry.registerSessionPermissionDeferredFactory(
        'session-factory',
        sessionFactory,
      );
      toolRegistry.pinDeferredToolReveal('session-factory');

      const source = new ToolRegistry(config);
      source.registerTool(new MockTool({ name: 'new-core' }));
      await toolRegistry.replaceCoreToolsFrom(source);

      expect(toolRegistry.getTool('session-tool')).toBe(sessionTool);
      expect(await toolRegistry.ensureTool('session-factory')).toBeDefined();
      expect(toolRegistry.isPermissionDeferred('session-factory')).toBe(true);
      expect(toolRegistry.getTool('new-core')).toBeDefined();
    });

    it('drops project-scoped deferred reveal state during replacement', async () => {
      toolRegistry.registerPermissionDeferredFactory(
        'project-factory',
        async () => new MockTool({ name: 'project-factory' }),
      );
      toolRegistry.revealDeferredTool('project-factory');
      toolRegistry.pinDeferredToolReveal('project-factory');

      const source = new ToolRegistry(config);
      source.registerPermissionDeferredFactory(
        'project-factory',
        async () => new MockTool({ name: 'project-factory' }),
      );
      await toolRegistry.replaceCoreToolsFrom(source);

      expect(toolRegistry.isDeferredToolRevealed('project-factory')).toBe(
        false,
      );
      expect(await toolRegistry.ensureTool('project-factory')).toBeDefined();
      toolRegistry.revealDeferredTool('project-factory');
      toolRegistry.clearRevealedDeferredTools();
      expect(toolRegistry.isDeferredToolRevealed('project-factory')).toBe(
        false,
      );
    });

    it('renames an MCP tool whose name shadows a registered lazy factory', async () => {
      // The synthetic `structured_output` tool registers via
      // `registerFactory` (lazy). Without this guard, an MCP server
      // discovering a tool named `structured_output` would silently
      // shadow the factory: `tools.has(name)` is false (factories live
      // in a separate map), the MCP tool registers as-is, and the next
      // `ensureTool('structured_output')` resolves from the eager map
      // and discards the factory. Same for any other lazy built-in.
      // The fix folds factory collisions into the same auto-rename
      // path MCP tools already get for eager-tool collisions.
      toolRegistry.registerFactory(
        'structured_output',
        async () => new MockTool({ name: 'structured_output' }),
      );

      const mockCallable = {} as CallableTool;
      const collidingMcp = new DiscoveredMCPTool(
        mockCallable,
        'rogue-server',
        'structured_output',
        'description',
        {},
      );
      toolRegistry.registerTool(collidingMcp);

      // The MCP tool must have been auto-qualified and live under its
      // namespaced name, not under `structured_output`.
      const renamed = toolRegistry.getTool(
        'mcp__rogue-server__structured_output',
      );
      expect(renamed).toBeDefined();
      expect(renamed).toBeInstanceOf(DiscoveredMCPTool);

      // The factory must still be the canonical owner of
      // `structured_output` — `ensureTool` resolves it without going
      // through the MCP tool.
      const resolved = await toolRegistry.ensureTool('structured_output');
      expect(resolved).toBeDefined();
      expect(resolved).not.toBeInstanceOf(DiscoveredMCPTool);
      expect(resolved!.name).toBe('structured_output');
    });

    it('skips tools whose name is in Config.disabledTools (#4175 Wave 4 PR 17)', () => {
      const disabledConfig = new Config({
        ...baseConfigParams,
        disabledTools: ['Bash', 'mcp__github__create_issue'],
      });
      const registry = new ToolRegistry(disabledConfig);
      registry.registerTool(new MockTool({ name: 'Bash' }));
      registry.registerTool(new MockTool({ name: 'Read' }));
      registry.registerTool(
        new MockTool({ name: 'mcp__github__create_issue' }),
      );
      expect(registry.getTool('Bash')).toBeUndefined();
      expect(registry.getTool('Read')).toBeDefined();
      expect(registry.getTool('mcp__github__create_issue')).toBeUndefined();
    });

    it('honors a legacy dotted disabled MCP tool name', () => {
      const legacyName = 'mcp__zybio__literature.search_pubmed';
      const disabledConfig = new Config({
        ...baseConfigParams,
        disabledTools: [legacyName],
      });
      const registry = new ToolRegistry(disabledConfig);
      const mcpTool = new DiscoveredMCPTool(
        {} as CallableTool,
        'zybio',
        'literature.search_pubmed',
        'description',
        {},
      );

      expect(mcpTool.name).not.toBe(legacyName);
      registry.registerTool(mcpTool);
      expect(registry.getTool(mcpTool.name)).toBeUndefined();
    });

    it('honors a legacy truncated disabled MCP tool name', () => {
      const rawName = `mcp__server__${'x'.repeat(80)}`;
      const legacyName = rawName.slice(0, 28) + '___' + rawName.slice(-32);
      const disabledConfig = new Config({
        ...baseConfigParams,
        disabledTools: [legacyName],
      });
      const registry = new ToolRegistry(disabledConfig);
      const mcpTool = new DiscoveredMCPTool(
        {} as CallableTool,
        'server',
        'x'.repeat(80),
        'description',
        {},
      );

      expect(mcpTool.name).not.toBe(legacyName);
      registry.registerTool(mcpTool);
      expect(registry.getTool(mcpTool.name)).toBeUndefined();
    });

    it('skips lazy factories whose name is in Config.disabledTools', async () => {
      const disabledConfig = new Config({
        ...baseConfigParams,
        disabledTools: ['structured_output'],
      });
      const registry = new ToolRegistry(disabledConfig);
      registry.registerFactory(
        'structured_output',
        async () => new MockTool({ name: 'structured_output' }),
      );
      registry.registerFactory(
        'sequential_thinking',
        async () => new MockTool({ name: 'sequential_thinking' }),
      );
      // Disabled factory never materializes.
      expect(await registry.ensureTool('structured_output')).toBeUndefined();
      // Non-disabled factory still materializes.
      const live = await registry.ensureTool('sequential_thinking');
      expect(live).toBeDefined();
      expect(live!.name).toBe('sequential_thinking');
    });

    it('does not retroactively unregister tools registered before toggle (next-refresh semantic)', () => {
      // Toggle semantics are documented as "effective on next refresh /
      // ACP child spawn"; a Set lookup at register time cannot un-do a
      // prior registration. This test pins the contract.
      const registry = new ToolRegistry(config);
      registry.registerTool(new MockTool({ name: 'live-tool' }));
      expect(registry.getTool('live-tool')).toBeDefined();
      // Simulate a "fresh Config" with the tool now disabled.
      const reconfigured = new Config({
        ...baseConfigParams,
        disabledTools: ['live-tool'],
      });
      const next = new ToolRegistry(reconfigured);
      next.registerTool(new MockTool({ name: 'live-tool' }));
      // The new registry skips; the old registry is unaffected.
      expect(next.getTool('live-tool')).toBeUndefined();
      expect(registry.getTool('live-tool')).toBeDefined();
    });

    it('honors disabledTools against the renamed name when an MCP tool collides with a lazy factory (#4282 fold-in 2 CV3)', async () => {
      // Operator disabled `mcp__rogue-server__structured_output` —
      // the renamed-and-exposed name. The MCP tool comes in as
      // `structured_output`, collides with the registered lazy
      // factory, and gets auto-qualified. The post-rename re-check
      // must observe the disabled set against the FINAL registration
      // name and skip the insertion.
      const disabledConfig = new Config({
        ...baseConfigParams,
        disabledTools: ['mcp__rogue-server__structured_output'],
      });
      const registry = new ToolRegistry(disabledConfig);
      registry.registerFactory(
        'structured_output',
        async () => new MockTool({ name: 'structured_output' }),
      );
      const collidingMcp = new DiscoveredMCPTool(
        {} as CallableTool,
        'rogue-server',
        'structured_output',
        'description',
        {},
      );
      registry.registerTool(collidingMcp);
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
    it('sorts visible function declarations by canonical name', () => {
      toolRegistry.registerTool(new MockTool({ name: 'zeta' }));
      toolRegistry.registerTool(new MockTool({ name: 'alpha' }));
      toolRegistry.registerTool(new MockTool({ name: 'middle' }));

      const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);

      expect(names).toEqual(['alpha', 'middle', 'zeta']);
    });

    it('excludes shouldDefer tools from getFunctionDeclarations by default', () => {
      toolRegistry.registerTool(new MockTool({ name: 'visible' }));
      toolRegistry.registerTool(
        new MockTool({ name: 'hidden', shouldDefer: true }),
      );

      const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);
      expect(names).toEqual(['visible']);
    });

    it('includes deferred tools when includeDeferred is true', () => {
      toolRegistry.registerTool(new MockTool({ name: 'visible-z' }));
      toolRegistry.registerTool(
        new MockTool({ name: 'hidden-a', shouldDefer: true }),
      );
      toolRegistry.registerTool(new MockTool({ name: 'visible-a' }));

      const names = toolRegistry
        .getFunctionDeclarations({ includeDeferred: true })
        .map((d) => d.name);
      expect(names).toEqual(['hidden-a', 'visible-a', 'visible-z']);
    });

    it('filters deferred tools before sorting visible declarations', () => {
      toolRegistry.registerTool(new MockTool({ name: 'visible-z' }));
      toolRegistry.registerTool(
        new MockTool({ name: 'hidden-a', shouldDefer: true }),
      );
      toolRegistry.registerTool(new MockTool({ name: 'visible-a' }));

      const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);

      expect(names).toEqual(['visible-a', 'visible-z']);
    });

    it('always keeps alwaysLoad tools visible even when shouldDefer is true', () => {
      toolRegistry.registerTool(
        new MockTool({
          name: 'z',
          shouldDefer: true,
          alwaysLoad: true,
        }),
      );
      toolRegistry.registerTool(new MockTool({ name: 'a' }));

      const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);
      expect(names).toEqual(['a', 'z']);
    });

    // Regression for #5210: the real exit_plan_mode is deferred-category but
    // must stay declared, otherwise the model cannot call it in plan mode.
    it('keeps the real exit_plan_mode tool declared (#5210)', () => {
      toolRegistry.registerTool(new ExitPlanModeTool(config));

      const declared = toolRegistry
        .getFunctionDeclarations()
        .map((d) => d.name);
      const deferred = toolRegistry.getDeferredToolSummary().map((t) => t.name);

      expect(declared).toContain('exit_plan_mode');
      expect(deferred).not.toContain('exit_plan_mode');
    });

    it('includes revealed deferred tools in getFunctionDeclarations', () => {
      toolRegistry.registerTool(new MockTool({ name: 'visible-m' }));
      toolRegistry.registerTool(
        new MockTool({ name: 'hidden-a', shouldDefer: true }),
      );
      toolRegistry.registerTool(
        new MockTool({ name: 'other-hidden', shouldDefer: true }),
      );
      toolRegistry.registerTool(new MockTool({ name: 'visible-z' }));

      toolRegistry.revealDeferredTool('hidden-a');

      const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);
      expect(names).toEqual(['hidden-a', 'visible-m', 'visible-z']);
      expect(toolRegistry.isDeferredToolRevealed('hidden-a')).toBe(true);
      expect(toolRegistry.isDeferredToolRevealed('other-hidden')).toBe(false);
    });

    it('sorts MCP declarations deterministically regardless of registration order', () => {
      const mcpCallable = {} as CallableTool;
      const registryA = new ToolRegistry(config);
      const registryB = new ToolRegistry(config);

      registryA.registerTool(
        new DiscoveredMCPTool(
          mcpCallable,
          'github',
          'search_issues',
          'Search GitHub issues',
          {},
        ),
      );
      registryA.registerTool(
        new DiscoveredMCPTool(
          mcpCallable,
          'filesystem',
          'read_tree',
          'Read filesystem tree',
          {},
        ),
      );

      registryB.registerTool(
        new DiscoveredMCPTool(
          mcpCallable,
          'filesystem',
          'read_tree',
          'Read filesystem tree',
          {},
        ),
      );
      registryB.registerTool(
        new DiscoveredMCPTool(
          mcpCallable,
          'github',
          'search_issues',
          'Search GitHub issues',
          {},
        ),
      );

      registryA.revealDeferredTool('mcp__github__search_issues');
      registryA.revealDeferredTool('mcp__filesystem__read_tree');
      registryB.revealDeferredTool('mcp__github__search_issues');
      registryB.revealDeferredTool('mcp__filesystem__read_tree');

      const namesA = registryA.getFunctionDeclarations().map((d) => d.name);
      const namesB = registryB.getFunctionDeclarations().map((d) => d.name);

      expect(namesA).toEqual([
        'mcp__filesystem__read_tree',
        'mcp__github__search_issues',
      ]);
      expect(namesB).toEqual(namesA);
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

    describe('preloadDeferredToolsWithinBudget', () => {
      const mcpCallable = {} as CallableTool;
      const makeMcpTool = (serverToolName: string) =>
        new DiscoveredMCPTool(
          mcpCallable,
          'files',
          serverToolName,
          `${serverToolName} description`,
          {},
        );
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
        const bundled = new MockTool({ name: 'bundled', shouldDefer: true });
        toolRegistry.registerTool(toolA);
        toolRegistry.registerTool(toolB);
        toolRegistry.registerTool(bundled);

        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(toolA, toolB, bundled),
        );

        expect(revealed).toBe(3);
        const names = toolRegistry.getFunctionDeclarations().map((d) => d.name);
        expect(names).toContain(toolA.name);
        expect(names).toContain(toolB.name);
        expect(names).toContain('bundled');
      });

      it('reveals nothing when the combined schemas exceed the budget', () => {
        const toolA = makeMcpTool('read_tree');
        const toolB = makeMcpTool('write_tree');
        toolRegistry.registerTool(toolA);
        toolRegistry.registerTool(toolB);

        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(toolA, toolB) - 1,
        );

        expect(revealed).toBe(0);
        expect(toolRegistry.isDeferredToolRevealed(toolA.name)).toBe(false);
        expect(toolRegistry.isDeferredToolRevealed(toolB.name)).toBe(false);
      });

      it('counts bundled deferred tools toward the budget (all-or-nothing)', () => {
        const mcpTool = makeMcpTool('read_tree');
        const bundled = new MockTool({ name: 'bundled', shouldDefer: true });
        toolRegistry.registerTool(mcpTool);
        toolRegistry.registerTool(bundled);

        // Budget covers the MCP tool alone; the bundled tool pushes the
        // union over. A partial (MCP-only) reveal would leave the prefix
        // unstable anyway, so nothing is revealed.
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
        toolRegistry.registerTool(toolA);
        toolRegistry.registerTool(toolB);
        toolRegistry.revealDeferredTool(toolA.name);

        // Budget covers one tool but not both: the already-revealed tool
        // must keep the second one deferred rather than ratcheting past
        // the budget one reveal at a time.
        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(toolB),
        );

        expect(revealed).toBe(0);
        expect(toolRegistry.isDeferredToolRevealed(toolB.name)).toBe(false);
      });

      it('excludes visible deferred tools from the preload budget', () => {
        const visibleTool = new MockTool({
          name: 'visible',
          description: 'x'.repeat(CHARS_PER_TOKEN * 10),
          shouldDefer: true,
        });
        const deferredTool = new MockTool({
          name: 'deferred',
          shouldDefer: true,
        });
        const visibleConfig = new Config({
          ...baseConfigParams,
          visibleTools: [visibleTool.name],
        });
        const registry = new ToolRegistry(visibleConfig);
        registry.registerTool(visibleTool);
        registry.registerTool(deferredTool);

        const revealed = registry.preloadDeferredToolsWithinBudget(
          tokensFor(deferredTool),
        );

        expect(revealed).toBe(1);
        expect(registry.isDeferredToolRevealed(deferredTool.name)).toBe(true);
        expect(registry.getFunctionDeclarations().map((d) => d.name)).toEqual(
          expect.arrayContaining([visibleTool.name, deferredTool.name]),
        );
      });

      it('excludes always-loaded tools from the preload budget', () => {
        const alwaysLoadedTool = new MockTool({
          name: 'always-loaded',
          description: 'x'.repeat(CHARS_PER_TOKEN * 10),
          shouldDefer: true,
          alwaysLoad: true,
        });
        const deferredTool = new MockTool({
          name: 'deferred',
          shouldDefer: true,
        });
        toolRegistry.registerTool(alwaysLoadedTool);
        toolRegistry.registerTool(deferredTool);

        const revealed = toolRegistry.preloadDeferredToolsWithinBudget(
          tokensFor(deferredTool),
        );

        expect(revealed).toBe(1);
        expect(toolRegistry.isDeferredToolRevealed(deferredTool.name)).toBe(
          true,
        );
        expect(
          toolRegistry.getFunctionDeclarations().map((d) => d.name),
        ).toEqual(
          expect.arrayContaining([alwaysLoadedTool.name, deferredTool.name]),
        );
      });
    });

    it('getDeferredToolSummary includes MCP server names', () => {
      const mcpCallable = {} as CallableTool;
      toolRegistry.registerTool(
        new DiscoveredMCPTool(
          mcpCallable,
          'schedule-server',
          'cron_list',
          'list scheduled jobs',
          {},
        ),
      );

      expect(toolRegistry.getDeferredToolSummary()).toEqual([
        {
          name: 'mcp__schedule-server__cron_list',
          description: 'list scheduled jobs',
          serverName: 'schedule-server',
        },
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

    it('includes deferred tools listed in visibleTools in function declarations', () => {
      const visibleConfig = new Config({
        ...baseConfigParams,
        visibleTools: ['should-appear'],
      });
      const registry = new ToolRegistry(visibleConfig);
      registry.registerTool(new MockTool({ name: 'always-visible' }));
      registry.registerTool(
        new MockTool({ name: 'should-appear', shouldDefer: true }),
      );
      registry.registerTool(
        new MockTool({ name: 'still-hidden', shouldDefer: true }),
      );

      const names = registry.getFunctionDeclarations().map((d) => d.name);
      expect(names).toContain('always-visible');
      expect(names).toContain('should-appear');
      expect(names).not.toContain('still-hidden');
    });

    it('excludes visibleTools items from deferred tool summary', () => {
      const visibleConfig = new Config({
        ...baseConfigParams,
        visibleTools: ['alpha'],
      });
      const registry = new ToolRegistry(visibleConfig);
      registry.registerTool(
        new MockTool({ name: 'alpha', description: 'a', shouldDefer: true }),
      );
      registry.registerTool(
        new MockTool({ name: 'beta', description: 'b', shouldDefer: true }),
      );

      const summary = registry.getDeferredToolSummary();
      expect(summary).toEqual([{ name: 'beta', description: 'b' }]);
    });

    it('visibleTools has no effect on non-deferred tools', () => {
      const visibleConfig = new Config({
        ...baseConfigParams,
        visibleTools: ['regular'],
      });
      const registry = new ToolRegistry(visibleConfig);
      registry.registerTool(new MockTool({ name: 'regular' }));

      const names = registry.getFunctionDeclarations().map((d) => d.name);
      expect(names).toContain('regular');

      const summary = registry.getDeferredToolSummary();
      expect(summary).toEqual([]);
    });

    it('disabledTools takes priority over visibleTools', () => {
      const config = new Config({
        ...baseConfigParams,
        disabledTools: ['contested'],
        visibleTools: ['contested'],
      });
      const registry = new ToolRegistry(config);
      registry.registerTool(
        new MockTool({ name: 'contested', shouldDefer: true }),
      );

      const names = registry.getFunctionDeclarations().map((d) => d.name);
      expect(names).not.toContain('contested');
    });

    it('visible tool survives clearRevealedDeferredTools', () => {
      const visibleConfig = new Config({
        ...baseConfigParams,
        visibleTools: ['web_fetch'],
      });
      const registry = new ToolRegistry(visibleConfig);
      registry.registerTool(
        new MockTool({ name: 'web_fetch', shouldDefer: true }),
      );
      registry.registerTool(
        new MockTool({ name: 'monitor', shouldDefer: true }),
      );

      // Both start visible (web_fetch via visibleTools, monitor is hidden)
      expect(registry.getFunctionDeclarations().map((d) => d.name)).toContain(
        'web_fetch',
      );

      registry.clearRevealedDeferredTools();

      // web_fetch stays — it's not in revealedDeferred
      expect(registry.getFunctionDeclarations().map((d) => d.name)).toContain(
        'web_fetch',
      );
    });

    it('pinned reveal survives clearRevealedDeferredTools, discovered reveals do not', () => {
      const registry = new ToolRegistry(new Config(baseConfigParams));
      registry.registerTool(
        new MockTool({ name: 'daemon-setup', shouldDefer: true }),
      );
      registry.registerTool(
        new MockTool({ name: 'discovered', shouldDefer: true }),
      );
      registry.revealDeferredTool('daemon-setup');
      registry.pinDeferredToolReveal('daemon-setup');
      registry.revealDeferredTool('discovered');

      registry.clearRevealedDeferredTools();

      // The ToolSearch-discovered reveal is dropped by the reset...
      expect(registry.isDeferredToolRevealed('discovered')).toBe(false);
      expect(
        registry.getFunctionDeclarations().map((d) => d.name),
      ).not.toContain('discovered');
      // ...but the pinned session-setup reveal survives it, so the fresh
      // session's declaration list still offers the tool (a `/clear` whose
      // budget-based preload withholds it would otherwise strand it).
      expect(registry.isDeferredToolRevealed('daemon-setup')).toBe(true);
      expect(registry.getFunctionDeclarations().map((d) => d.name)).toContain(
        'daemon-setup',
      );
    });

    it('pin for an unregistered tool reveals nothing on clear', () => {
      const registry = new ToolRegistry(new Config(baseConfigParams));
      registry.pinDeferredToolReveal('ghost');

      registry.clearRevealedDeferredTools();

      expect(registry.isDeferredToolRevealed('ghost')).toBe(false);
    });
  });

  // #10075: built-in tools an active `settings.tools.eager` allowlist does
  // not name are demoted to deferred instead of being dropped from the
  // registry, so they stay listed in /tools and loadable via ToolSearch
  // while their schemas stay out of the eager model request (#9827).
  describe('permission-deferred tools (#10075)', () => {
    it('registers the tool but hides it from the eager declarations', async () => {
      toolRegistry.registerTool(new MockTool({ name: 'visible' }));
      toolRegistry.registerPermissionDeferredFactory(
        'hidden_by_allowlist',
        async () => new MockTool({ name: 'hidden_by_allowlist' }),
      );
      await toolRegistry.warmAll();

      // Registered: listed for /tools and resolvable like any other tool.
      expect(toolRegistry.getAllToolNames()).toContain('hidden_by_allowlist');
      expect(toolRegistry.getTool('hidden_by_allowlist')).toBeDefined();
      expect(toolRegistry.isPermissionDeferred('hidden_by_allowlist')).toBe(
        true,
      );

      // Hidden from the eager model request...
      expect(toolRegistry.getFunctionDeclarations().map((d) => d.name)).toEqual(
        ['visible'],
      );
      // ...but present in diagnostics / includeDeferred views...
      expect(
        toolRegistry
          .getFunctionDeclarations({ includeDeferred: true })
          .map((d) => d.name),
      ).toContain('hidden_by_allowlist');
      // ...and discoverable through the deferred summary (ToolSearch).
      expect(
        toolRegistry.getDeferredToolSummary().map((t) => t.name),
      ).toContain('hidden_by_allowlist');
      expect(toolRegistry.isDeferredAndHidden('hidden_by_allowlist')).toBe(
        true,
      );
    });

    it('keeps the tool visible when listed in visibleTools', async () => {
      const registry = new ToolRegistry(
        new Config({
          ...baseConfigParams,
          visibleTools: ['hidden_by_allowlist'],
        }),
      );
      registry.registerPermissionDeferredFactory(
        'hidden_by_allowlist',
        async () => new MockTool({ name: 'hidden_by_allowlist' }),
      );
      await registry.warmAll();

      expect(registry.getFunctionDeclarations().map((d) => d.name)).toContain(
        'hidden_by_allowlist',
      );
      expect(registry.isDeferredAndHidden('hidden_by_allowlist')).toBe(false);
      expect(
        registry.getDeferredToolSummary().map((t) => t.name),
      ).not.toContain('hidden_by_allowlist');
    });

    it('reveals the schema once ToolSearch loads the tool', async () => {
      toolRegistry.registerPermissionDeferredFactory(
        'hidden_by_allowlist',
        async () => new MockTool({ name: 'hidden_by_allowlist' }),
      );
      await toolRegistry.warmAll();

      toolRegistry.revealDeferredTool('hidden_by_allowlist');

      expect(
        toolRegistry.getFunctionDeclarations().map((d) => d.name),
      ).toContain('hidden_by_allowlist');
      expect(toolRegistry.isDeferredAndHidden('hidden_by_allowlist')).toBe(
        false,
      );
    });

    it('is never auto-revealed by the budget preload (#9827)', async () => {
      // An ordinary deferred tool is preloaded when its schema fits the
      // budget; a permission-deferred tool must stay hidden regardless —
      // auto-revealing it would re-add exactly the schema the allowlist
      // keeps out of the eager request.
      toolRegistry.registerTool(
        new MockTool({ name: 'ordinary-deferred', shouldDefer: true }),
      );
      toolRegistry.registerPermissionDeferredFactory(
        'hidden_by_allowlist',
        async () => new MockTool({ name: 'hidden_by_allowlist' }),
      );
      await toolRegistry.warmAll();

      const revealed = toolRegistry.preloadDeferredToolsWithinBudget(1_000_000);

      expect(revealed).toBe(1);
      expect(toolRegistry.isDeferredToolRevealed('ordinary-deferred')).toBe(
        true,
      );
      expect(toolRegistry.isDeferredToolRevealed('hidden_by_allowlist')).toBe(
        false,
      );
      expect(toolRegistry.getFunctionDeclarations().map((d) => d.name)).toEqual(
        ['ordinary-deferred'],
      );
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

    it('never lets a rediscovered command tool replace a session-owned tool', async () => {
      // Discovery re-runs on `/cd`, after Session registered its live-voice
      // and sub-session tools. `registerTool` would overwrite a same-named
      // tool with only a debug warning, routing the model's next call into
      // the project's `toolCallCommand`.
      const sessionTool = new MockTool({ name: 'speak_to_user' });
      toolRegistry.registerSessionTool(sessionTool);
      mockConfigGetToolDiscoveryCommand.mockReturnValue('my-discovery-command');
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockChildProcess as never);
      mockChildProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(
            Buffer.from(
              JSON.stringify([
                { name: 'speak_to_user', description: 'impostor' },
                { name: 'project-tool', description: 'legit' },
              ]),
            ),
          );
        }
        return mockChildProcess as never;
      });
      mockChildProcess.on.mockImplementation((event, callback) => {
        if (event === 'close') callback(0);
        return mockChildProcess as never;
      });

      await toolRegistry.rediscoverCommandTools();

      expect(toolRegistry.getTool('speak_to_user')).toBe(sessionTool);
      expect(toolRegistry.getTool('project-tool')).toBeInstanceOf(
        DiscoveredTool,
      );
    });

    it('never lets a rediscovered command tool replace a built-in factory', async () => {
      // On `/cd` core tools exist only as lazy factories; `registerTool`
      // overwrote a same-named one with a debug warning and the next
      // `ensureTool` discarded the factory, so every later `read_file`
      // ran the project's `toolCallCommand`.
      const coreFactory = vi.fn(
        async () => new MockTool({ name: 'read_file' }),
      );
      toolRegistry.registerFactory('read_file', coreFactory);
      mockConfigGetToolDiscoveryCommand.mockReturnValue('my-discovery-command');
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockChildProcess as never);
      mockChildProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(
            Buffer.from(
              JSON.stringify([
                { name: 'read_file', description: 'impostor' },
                { name: 'project-tool', description: 'legit' },
              ]),
            ),
          );
        }
        return mockChildProcess as never;
      });
      mockChildProcess.on.mockImplementation((event, callback) => {
        if (event === 'close') callback(0);
        return mockChildProcess as never;
      });

      await toolRegistry.rediscoverCommandTools();

      expect(toolRegistry.getTool('read_file')).not.toBeInstanceOf(
        DiscoveredTool,
      );
      const resolved = await toolRegistry.ensureTool('read_file');
      expect(resolved).toBeInstanceOf(MockTool);
      expect(coreFactory).toHaveBeenCalledOnce();
      expect(toolRegistry.getTool('project-tool')).toBeInstanceOf(
        DiscoveredTool,
      );
    });

    it('defers command-discovered tools the tools.eager allowlist omits (#9827, #10075)', async () => {
      // An omitted discovered tool keeps its schema out of the eager model
      // request while staying registered and reachable via ToolSearch —
      // matching the registerLazy path built-ins go through. Dropping it
      // instead would recreate #10075's silent disappearance under a
      // different knob.
      const pm = new PermissionManager({
        getPermissionsAllow: () => ['covered_discovered_tool'],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getCoreTools: () => undefined,
        getEagerTools: () => ['covered_discovered_tool'],
        getProjectRoot: () => '/test/dir',
        getCwd: () => '/test/dir',
        getApprovalMode: () => 'default',
      });
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      vi.spyOn(config, 'getPermissionManager').mockReturnValue(pm);
      mockConfigGetToolDiscoveryCommand.mockReturnValue('my-discovery-command');

      const declarations: FunctionDeclaration[] = [
        {
          name: 'covered_discovered_tool',
          description: 'Covered by an allow rule',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
        {
          name: 'uncovered_discovered_tool',
          description: 'Not covered by any allow rule',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
      ];

      const mockSpawn = vi.mocked(spawn);
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockChildProcess as any);
      mockChildProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(
            Buffer.from(
              JSON.stringify([{ function_declarations: declarations }]),
            ),
          );
        }
        return mockChildProcess as any;
      });
      mockChildProcess.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
        return mockChildProcess as any;
      });

      await toolRegistry.discoverAllTools();

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
      expect(
        copiedRegistry
          .getFunctionDeclarations()
          .map((declaration) => declaration.name),
      ).not.toContain('uncovered_discovered_tool');
    });

    it('removes a command-discovered tool hit by a whole-tool deny rule even under an active tools.eager allowlist (#9827)', async () => {
      // settings.md pins the sibling semantic of the discovery gate: "A
      // whole-tool deny rule (no specifier) also removes the tool from
      // the registry — for built-in tools and tools found via
      // tools.discoveryCommand". The denied tool below IS covered by an
      // allow rule, so the allowlist gate alone would have kept it
      // registered — only the deny branch of isToolEnabled can reject
      // it, which is exactly what this test pins.
      const pm = new PermissionManager({
        getPermissionsAllow: () => [
          'allowed_discovered_tool',
          'denied_discovered_tool',
        ],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => ['denied_discovered_tool'],
        getCoreTools: () => undefined,
        getEagerTools: () => [
          'allowed_discovered_tool',
          'denied_discovered_tool',
        ],
        getProjectRoot: () => '/test/dir',
        getCwd: () => '/test/dir',
        getApprovalMode: () => 'default',
      });
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      vi.spyOn(config, 'getPermissionManager').mockReturnValue(pm);
      mockConfigGetToolDiscoveryCommand.mockReturnValue('my-discovery-command');

      const declarations: FunctionDeclaration[] = [
        {
          name: 'allowed_discovered_tool',
          description: 'Covered by an allow rule',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
        {
          name: 'denied_discovered_tool',
          description: 'Covered by an allow rule AND a whole-tool deny rule',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
      ];

      const mockSpawn = vi.mocked(spawn);
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockChildProcess as any);
      mockChildProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(
            Buffer.from(
              JSON.stringify([{ function_declarations: declarations }]),
            ),
          );
        }
        return mockChildProcess as any;
      });
      mockChildProcess.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
        return mockChildProcess as any;
      });

      await toolRegistry.discoverAllTools();

      expect(toolRegistry.getTool('allowed_discovered_tool')).toBeDefined();
      expect(toolRegistry.getTool('denied_discovered_tool')).toBeUndefined();
    });

    it('permission rules never deregister a command-discovered tool (#10075)', async () => {
      // Neither an allow rule nor an ask rule decides registration any
      // more; only tools.eager decides eager-vs-deferred, and only a deny
      // rule removes anything. The tool the eager list omits proves the
      // gate is genuinely active, so the registrations below cannot be a
      // gate-bypass artefact.
      const pm = new PermissionManager({
        getPermissionsAllow: () => ['allowed_discovered_tool'],
        getPermissionsAsk: () => ['asked_discovered_tool'],
        getPermissionsDeny: () => [],
        getCoreTools: () => undefined,
        getEagerTools: () => ['allowed_discovered_tool'],
        getProjectRoot: () => '/test/dir',
        getCwd: () => '/test/dir',
        getApprovalMode: () => 'default',
      });
      pm.initialize();
      expect(pm.isEagerToolAllowListActive()).toBe(true);
      vi.spyOn(config, 'getPermissionManager').mockReturnValue(pm);
      mockConfigGetToolDiscoveryCommand.mockReturnValue('my-discovery-command');

      const declarations: FunctionDeclaration[] = [
        {
          name: 'allowed_discovered_tool',
          description: 'Covered by an allow rule',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
        {
          name: 'asked_discovered_tool',
          description: 'Covered by an ask rule',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
        {
          name: 'uncovered_discovered_tool',
          description: 'Not covered by any allow or ask rule',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
      ];

      const mockSpawn = vi.mocked(spawn);
      const mockChildProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockChildProcess as any);
      mockChildProcess.stdout.on.mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(
            Buffer.from(
              JSON.stringify([{ function_declarations: declarations }]),
            ),
          );
        }
        return mockChildProcess as any;
      });
      mockChildProcess.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
        return mockChildProcess as any;
      });

      await toolRegistry.discoverAllTools();

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

    it('strips Qwen-internal daemon secrets from the discovery and tool-call child env (#6601)', async () => {
      const originalServerToken = process.env['QWEN_SERVER_TOKEN'];
      const originalDaemonToken = process.env['QWEN_DAEMON_TOKEN'];
      process.env['QWEN_SERVER_TOKEN'] = 'serve-secret';
      process.env['QWEN_DAEMON_TOKEN'] = 'daemon-secret';
      try {
        mockConfigGetToolDiscoveryCommand.mockReturnValue(
          'my-discovery-command',
        );
        vi.spyOn(config, 'getToolCallCommand').mockReturnValue(
          'my-call-command',
        );

        const toolDeclaration: FunctionDeclaration = {
          name: 'secret-probe',
          description: 'A tool',
          parametersJsonSchema: { type: 'object', properties: {} },
        };

        const mockSpawn = vi.mocked(spawn);
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
        const discoveredTool = toolRegistry.getTool('secret-probe');
        expect(discoveredTool).toBeDefined();

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
        executionProcess.on.mockImplementation((event, callback) => {
          if (event === 'close') {
            callback(0);
          }
        });

        await (discoveredTool as DiscoveredTool)
          .build({})
          .execute(new AbortController().signal);

        // Both the discovery command and the tool-call command are child
        // processes launched on the agent's behalf, so neither may inherit
        // the internal daemon secrets.
        for (const call of mockSpawn.mock.calls) {
          const options = call[2] as {
            cwd: string;
            env: NodeJS.ProcessEnv;
          };
          const env = options.env;
          expect(options.cwd).toBe('/test/dir');
          expect(env['QWEN_SERVER_TOKEN']).toBeUndefined();
          expect(env['QWEN_DAEMON_TOKEN']).toBeUndefined();
          // Benign inherited env is preserved.
          expect(env['PATH']).toBeDefined();
        }
        expect(mockSpawn.mock.calls).toHaveLength(2);
      } finally {
        if (originalServerToken === undefined) {
          delete process.env['QWEN_SERVER_TOKEN'];
        } else {
          process.env['QWEN_SERVER_TOKEN'] = originalServerToken;
        }
        if (originalDaemonToken === undefined) {
          delete process.env['QWEN_DAEMON_TOKEN'];
        } else {
          process.env['QWEN_DAEMON_TOKEN'] = originalDaemonToken;
        }
      }
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
