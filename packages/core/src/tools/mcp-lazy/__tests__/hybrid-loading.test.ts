/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../config/config.js';
import { DiscoveredMCPTool } from '../../../mcp/tools/mcp-tool.js';
import { SessionMcpManager } from '../../../mcp/sessionMcpManager/index.js';
import type { McpManager } from '../../../mcp/mcpManager.js';
import { McpSettingsGate } from '../../../mcp/gate.js';
import { ToolRegistry } from '../../tool-registry.js';
import { CodeModeTool } from '../../code-mode.js';
import { defineDeclarativeTool } from '../../define-tool.js';
import { Kind, type ToolResult } from '../../tools.js';
import type { ToolExposureHints } from '../../../codemode/types.js';
import { makeFakeConfig } from '../../../test-utils/config.js';
import {
  MCP_CALL_TOOL_NAME,
  MCP_GET_TOOL_NAME,
  MCP_LIST_TOOL_NAME,
} from '../index.js';

function createTool(
  rawName: string,
  extension?: { exposedName?: string; alwaysLoad?: boolean },
): DiscoveredMCPTool {
  return new DiscoveredMCPTool(
    {} as never,
    'ide',
    rawName,
    `${rawName} description`,
    { type: 'object', properties: {} },
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    extension,
  );
}

function createManager(config: Config, registry: ToolRegistry) {
  const manager = new SessionMcpManager(
    config,
    {} as McpManager,
    new McpSettingsGate(),
    {
      lazyMode: config.getMcpLazyLoad(),
    },
  );
  Object.assign(config, { _toolRegistry: registry, mcpClientManager: manager });
  const discovered = new Map<string, DiscoveredMCPTool[]>();
  vi.spyOn(manager, 'getAllDiscoveredMcpTools').mockImplementation(() =>
    [...discovered].flatMap(([serverName, tools]) =>
      tools.map((tool) => ({
        qualifiedName: tool.name,
        serverName,
        toolName: tool.serverToolName,
        description: tool.description,
        inputSchema: tool.parameterSchema,
        tool,
        alwaysLoad: tool.alwaysLoad,
        source: 'sdk' as const,
      })),
    ),
  );
  config.mcpToolListChange();
  return { manager, discovered };
}

describe('MCP hybrid lazy loading', () => {
  it('replaces lazy loading with deferred registration when CodeMode is available', () => {
    let mode = 'only';
    const config = makeFakeConfig({
      mcpLazyLoad: true,
      mcpLazyLoadSource: 'environment',
      getSetting: (section) =>
        section === 'codeMode' ? { mode } : undefined,
    });
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new CodeModeTool(config));
    const { manager, discovered } = createManager(config, registry);
    const read = createTool('Read');
    const write = createTool('Write');
    const pinned = createTool('Pinned', { alwaysLoad: true });
    discovered.set('ide', [read, write, pinned]);
    config.mcpToolListChange();

    // An agent without CodeMode inherits the main registry's tools.
    const withoutCodeMode = () => {
      const child = new ToolRegistry(config);
      for (const tool of registry.getAllKnownTools())
        if (tool.name !== 'CodeMode') child.registerTool(tool);
      return child;
    };
    const assertOnlyMode = () => {
      expect(manager.peekLazyMode()).toBe(false);
      expect(manager.peekRegistrationMode()).toBe('deferred');
      expect(registry.getTool(read.name)).toBe(read);
      expect(registry.getTool(write.name)).toBe(write);
      for (const name of [
        MCP_CALL_TOOL_NAME,
        MCP_GET_TOOL_NAME,
        MCP_LIST_TOOL_NAME,
      ]) {
        expect(registry.getKnownTool(name)).toBeDefined();
      }
      // CodeMode reaches every MCP tool through script discovery.
      expect(
        registry.getModelFunctionDeclarations().map((tool) => tool.name),
      ).toEqual(['CodeMode']);
      expect(registry.getToolView().codeMode).toBe('only');
      expect(
        registry
          .getProgrammaticToolCatalog()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual([pinned.name, read.name, write.name].sort());
      // Other agents keep the meta tools; only alwaysLoad stays declared.
      const child = withoutCodeMode();
      expect(
        child
          .getModelFunctionDeclarations()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(
        [pinned.name, MCP_CALL_TOOL_NAME, MCP_GET_TOOL_NAME, MCP_LIST_TOOL_NAME].sort(),
      );
      expect(child.getToolView().codeMode).toBeUndefined();
      expect(
        manager.getLazyDiscoveredMcpTools().map((entry) => entry.qualifiedName),
      ).toEqual([read.name, write.name]);
      expect(
        manager.getLazyMcpServerSnapshot()?.map((server) => server.toolNames),
      ).toEqual([[read.name, write.name]]);
    };
    assertOnlyMode();

    config.setMcpLazyLoad(true);
    manager.syncLazyMode();
    assertOnlyMode();

    // In on mode CodeMode scripts also reach every MCP tool.
    mode = 'on';
    manager.syncLazyMode();
    expect(manager.peekRegistrationMode()).toBe('deferred');
    expect(registry.getTool(read.name)).toBe(read);
    expect(
      registry.getModelFunctionDeclarations().map((tool) => tool.name),
    ).toEqual(['CodeMode', pinned.name]);
    // The lazy preference does not matter once CodeMode is available.
    config.setMcpLazyLoad(false);
    manager.syncLazyMode();
    expect(manager.peekRegistrationMode()).toBe('deferred');
    expect(
      registry.getModelFunctionDeclarations().map((tool) => tool.name),
    ).toEqual(['CodeMode', pinned.name]);
    config.setMcpLazyLoad(true);
    manager.syncLazyMode();
    mode = 'only';
    manager.syncLazyMode();
    assertOnlyMode();

    discovered.set('ide', [read, pinned]);
    config.mcpToolListChange();
    expect(registry.getKnownTool(write.name)).toBeUndefined();
    expect(
      registry
        .getProgrammaticToolCatalog()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([pinned.name, read.name].sort());
  });

  describe('built-in deferral', () => {
    const define = (name: string, exposureHints?: ToolExposureHints) =>
      defineDeclarativeTool<Record<string, never>, ToolResult, Config>({
        name,
        displayName: name,
        description: `${name} does a thing. Second sentence is omitted.`,
        kind: Kind.Read,
        parameterSchema: { type: 'object', properties: {} },
        exposureHints,
        execute: async () => ({ llmContent: '', returnDisplay: '' }),
      });
    const Slow = define('Slow', { defaultDeferred: true, longRunning: true });
    const Plain = define('Plain');
    const Direct = define('Direct', { modelOnly: true });
    const setup = (codeMode: Record<string, unknown>, withCodeMode: boolean) => {
      const config = makeFakeConfig({
        getSetting: (section) =>
          section === 'codeMode' ? codeMode : undefined,
      });
      const registry = new ToolRegistry(config);
      for (const Tool of [Slow, Plain, Direct]) registry.registerTool(new Tool(config));
      if (withCodeMode) registry.registerTool(new CodeModeTool(config));
      return registry;
    };
    const visible = (registry: ToolRegistry) =>
      registry
        .getModelFunctionDeclarations()
        .map((tool) => tool.name)
        .sort();
    const codeModeDescription = (registry: ToolRegistry) =>
      registry
        .getFunctionDeclarations()
        .find((tool) => tool.name === 'CodeMode')!.description!;

    it.each(['on', 'only'])(
      'hides default-deferred tools from CodeMode agents in %s mode and lists them by name',
      (mode) => {
        const registry = setup({ mode }, true);
        expect(visible(registry)).toEqual(
          mode === 'on'
            ? ['CodeMode', 'Direct', 'Plain']
            : ['CodeMode', 'Direct'],
        );
        const description = codeModeDescription(registry);
        expect(description).toContain(
          '- Slow: Slow does a thing. May take minutes; expect status=running and continue with CodeModeWait.',
        );
        expect(description).not.toContain('Slow does a thing. Second');
        // Deferred signatures are never inlined, even in only mode.
        expect(description).not.toContain('Slow(args');
        expect(
          registry
            .getProgrammaticToolCatalog()
            .map((tool) => tool.name)
            .sort(),
        ).toEqual(['Plain', 'Slow']);
      },
    );

    it('keeps deferred built-ins declared for agents without CodeMode', () => {
      expect(visible(setup({ mode: 'on' }, false))).toEqual([
        'Direct',
        'Plain',
        'Slow',
      ]);
    });

    it('applies settings patterns: opt-in, !exclusion and ignored model-only tools', () => {
      const registry = setup(
        { mode: 'on', deferredTools: ['Pl*', '!Slow', 'Direct'] },
        true,
      );
      expect(visible(registry)).toEqual(['CodeMode', 'Direct', 'Slow']);
      expect(codeModeDescription(registry)).toContain('- Plain: Plain does a thing.');
      expect(codeModeDescription(registry)).not.toContain('- Slow:');
    });
  });

  it('defers MCP tools named by codeMode.deferredTools and keeps exclusions declared', () => {
    const config = makeFakeConfig({
      getSetting: (section) =>
        section === 'codeMode'
          ? { mode: 'on', deferredTools: ['mcp__ide__*', '!mcp__ide__Keep'] }
          : undefined,
    });
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new CodeModeTool(config));
    const { manager, discovered } = createManager(config, registry);
    const hidden = createTool('Hide');
    const kept = createTool('Keep');
    discovered.set('ide', [hidden, kept]);
    config.mcpToolListChange();

    expect(manager.peekRegistrationMode()).toBe('deferred');
    const names = registry.getModelFunctionDeclarations().map((t) => t.name);
    expect(names).toContain(kept.name);
    expect(names).not.toContain(hidden.name);
    expect(names).not.toContain(MCP_LIST_TOOL_NAME);
    expect(
      manager.getLazyDiscoveredMcpTools().map((entry) => entry.qualifiedName),
    ).toEqual([hidden.name]);
  });

  it('defers MCP servers in on mode unless a pattern keeps them declared', () => {
    const config = makeFakeConfig({
      getSetting: (section) =>
        section === 'codeMode'
          ? { mode: 'on', deferredTools: ['!mcp__ide__*'] }
          : undefined,
    });
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new CodeModeTool(config));
    const { manager, discovered } = createManager(config, registry);
    const direct = createTool('Read');
    const deferred = new DiscoveredMCPTool(
      {} as never,
      'docs',
      'search',
      'search docs',
      { type: 'object', properties: {} },
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { deferred: true },
    );
    discovered.set('ide', [direct]);
    discovered.set('docs', [deferred]);
    config.mcpToolListChange();

    expect(manager.peekRegistrationMode()).toBe('deferred');
    expect(
      registry.getModelFunctionDeclarations().map((tool) => tool.name),
    ).toEqual(expect.arrayContaining(['CodeMode', direct.name]));
    expect(
      registry.getModelFunctionDeclarations().map((tool) => tool.name),
    ).not.toContain(deferred.name);
    expect(
      registry.getModelFunctionDeclarations().map((tool) => tool.name),
    ).not.toContain(MCP_CALL_TOOL_NAME);
    expect(
      registry.getProgrammaticToolCatalog().map((tool) => tool.name),
    ).toContain(deferred.name);
    expect(
      manager.getLazyDiscoveredMcpTools().map((entry) => entry.qualifiedName),
    ).toEqual([deferred.name]);
    const description = registry
      .getFunctionDeclarations()
      .find((tool) => tool.name === 'CodeMode')?.description;
    expect(description).toContain(
      'Omitted tools are callable only inside CodeMode;',
    );
    expect(description).not.toContain('mcp.call');
  });

  it('keeps the meta tools registered but undeclared while nothing is deferred', () => {
    const config = makeFakeConfig({ mcpLazyLoad: false });
    const registry = new ToolRegistry(config, true);
    const { manager, discovered } = createManager(config, registry);
    const read = createTool('Read');
    discovered.set('ide', [read]);
    config.mcpToolListChange();

    expect(manager.peekRegistrationMode()).toBe('eager');
    expect(registry.getKnownTool(MCP_CALL_TOOL_NAME)).toBeDefined();
    expect(
      registry.getModelFunctionDeclarations().map((tool) => tool.name),
    ).toEqual([read.name]);
    expect(manager.getLazyMcpServerSnapshot()).toEqual([]);
  });

});
