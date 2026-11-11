/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { defineDeclarativeTool } from '../../tools/define-tool.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { Kind } from '../../tools/tools.js';

function createConfig(
  excluded: string[] = [],
): Config & { mcpDiagnostics: ReturnType<typeof vi.fn> } {
  const mcpDiagnostics = vi.fn();
  return {
    getExcludeTools: () => new Set(excluded),
    isTopicUpdateNarrationEnabled: () => true,
    shouldHideInteractiveTools: () => false,
    getMainAgentTools: () => undefined,
    getSessionMcpManager: () => ({ emitDiagnostic: mcpDiagnostics }),
    mcpDiagnostics,
  } as unknown as Config & { mcpDiagnostics: ReturnType<typeof vi.fn> };
}

function createMcpTool(
  exposedName?: string,
  alwaysLoad?: boolean,
  serverName = 'ide',
  rawName = 'read_file',
): DiscoveredMCPTool {
  return new DiscoveredMCPTool(
    {} as never,
    serverName,
    rawName,
    'Read a file through the IDE',
    { type: 'object', properties: {} },
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { exposedName, alwaysLoad },
  );
}

const ReadTool = defineDeclarativeTool<Record<string, never>, never, Config>({
  name: 'Read',
  displayName: 'Read',
  description: 'Built-in read',
  kind: Kind.Read,
  parameterSchema: { type: 'object', properties: {} },
  execute: async () => {
    throw new Error('not called');
  },
});

describe('MCP tool model-surface extension', () => {
  it('keeps normal MCP naming unchanged when no override is configured', () => {
    const registry = new ToolRegistry(createConfig(), true);
    const tool = createMcpTool();
    registry.registerTool(tool);

    expect(tool.name).toBe('mcp__ide__read_file');
    expect(tool.getModelName()).toBe('mcp__ide__read_file');
    expect(tool.alwaysLoad).toBe(false);
    expect(registry.getFunctionDeclarations()[0]?.name).toBe(
      'mcp__ide__read_file',
    );
  });

  it('does not apply a built-in deny rule to an MCP tool with the same raw name', () => {
    const registry = new ToolRegistry(createConfig(['Read']), true);
    const mcp = createMcpTool(undefined, undefined, 'ide', 'Read');
    registry.registerTool(mcp);

    expect(registry.getTool('mcp__ide__Read')).toBe(mcp);
    expect(registry.getFunctionDeclarations().map((entry) => entry.name)).toEqual([
      'mcp__ide__Read',
    ]);
  });

  it('still applies a deny rule that uses the canonical MCP name', () => {
    const registry = new ToolRegistry(createConfig(['mcp__ide__Read']), true);
    const mcp = createMcpTool(undefined, undefined, 'ide', 'Read');
    registry.registerTool(mcp);

    expect(registry.getTool('mcp__ide__Read')).toBeUndefined();
    expect(registry.getFunctionDeclarations()).toEqual([]);
  });

  it('exposes an alias while preserving canonical identity and invocation', () => {
    const registry = new ToolRegistry(createConfig(), true);
    const tool = createMcpTool('Read', true);
    registry.registerTool(tool);

    expect(tool.name).toBe('mcp__ide__read_file');
    expect(tool.getFullyQualifiedName()).toBe('mcp__ide__read_file');
    expect(tool.alwaysLoad).toBe(true);
    expect(registry.getTool('Read')).toBe(tool);
    expect(registry.getTool('mcp__ide__read_file')).toBe(tool);
    expect(registry.getFunctionDeclarations()[0]?.name).toBe('Read');
    expect((tool.build({}) as { _toolName?: string })._toolName).toBe('Read');
  });

  it('does not overwrite an active tool with the same exposed name', () => {
    const config = createConfig();
    const registry = new ToolRegistry(config, true);
    const builtin = new ReadTool(config);
    const mcp = createMcpTool('Read', true);
    registry.registerTool(builtin);
    registry.registerTool(mcp);

    expect(registry.getTool('Read')).toBe(builtin);
    expect(registry.getTool('mcp__ide__read_file')).toBeUndefined();
    expect(registry.getFunctionDeclarations().map((entry) => entry.name)).toEqual([
      'Read',
    ]);
    expect(config.mcpDiagnostics).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('conflicts with active tool'),
      undefined,
      'ide',
    );
  });

  it('hides the MCP alias when a conflicting built-in registers later', () => {
    const config = createConfig();
    const registry = new ToolRegistry(config, true);
    const mcp = createMcpTool('Read', true);
    const builtin = new ReadTool(config);
    registry.registerTool(mcp);
    registry.registerTool(builtin);

    expect(registry.getTool('Read')).toBe(builtin);
    expect(registry.getTool(mcp.name)).toBeUndefined();
    expect(registry.getFunctionDeclarations().map((entry) => entry.name)).toEqual([
      'Read',
    ]);
  });

  it('uses the MCP alias when the conflicting built-in tool is disabled', () => {
    const config = createConfig(['Read']);
    const registry = new ToolRegistry(config, true);
    const builtin = new ReadTool(config);
    const mcp = createMcpTool('Read', true, 'ide', 'Read');
    registry.registerTool(builtin);
    registry.registerTool(mcp);

    expect(registry.getTool('Read')).toBe(mcp);
    expect(registry.getFunctionDeclarations().map((entry) => entry.name)).toEqual([
      'Read',
    ]);
  });

  it('hides duplicate MCP aliases and promotes the remaining tool on removal', () => {
    const config = createConfig();
    const registry = new ToolRegistry(config, true);
    const first = createMcpTool('IDERead', true, 'ide-a');
    const second = createMcpTool('IDERead', true, 'ide-b');
    registry.registerTool(first);
    registry.registerTool(second);

    expect(registry.getTool('IDERead')).toBeUndefined();
    expect(registry.getFunctionDeclarations()).toEqual([]);
    expect(config.mcpDiagnostics).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('configured by multiple tools'),
    );

    registry.unregisterTool(first.name);

    expect(registry.getTool('IDERead')).toBe(second);
    expect(registry.getFunctionDeclarations().map((entry) => entry.name)).toEqual([
      'IDERead',
    ]);
  });
});
