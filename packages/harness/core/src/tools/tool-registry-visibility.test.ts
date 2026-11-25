/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoveredMCPTool } from '../mcp/tools/mcp-tool.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { runLogger } from '../utils/runLogger.js';
import { ToolRegistry } from './tool-registry.js';
import { AskUserTool } from './ask-user.js';
import { AskUserAsyncTool } from './ask-user-async.js';
import { SleepTool } from './sleep.js';

function mcpTool(server: string, name: string, exposedName?: string) {
  return new DiscoveredMCPTool(
    {} as never,
    server,
    name,
    `${name} description`,
    { type: 'object', properties: {} },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { exposedName, alwaysLoad: exposedName !== undefined },
  );
}

describe('async user interaction tool availability', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps declarations stable across Plan transitions without changing other sessions', async () => {
    const config = makeFakeConfig();
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new AskUserTool(config));
    registry.registerTool(new AskUserAsyncTool(config));
    registry.registerTool(new SleepTool(config));
    const names = () => registry.getFunctionDeclarations().map((tool) => tool.name);
    expect(names()).toContain('AskUserQuestion');
    expect(registry.getTool('AskUserQuestionAsync')).toBeUndefined();
    expect(registry.getTool('Sleep')).toBeUndefined();
    await config.setAsyncUserInteractionEnabled(true);
    expect(names()).toEqual(expect.arrayContaining(['AskUserQuestionAsync', 'Sleep']));
    expect(names()).toContain('AskUserQuestion');
    expect(registry.getTool('AskUserQuestion')).toBeDefined();
    expect(makeFakeConfig().isAsyncUserInteractionEnabled()).toBe(false);
    const before = registry.getFunctionDeclarations();
    config.planStateManager.enter();
    expect(names()).toEqual(expect.arrayContaining(['AskUserQuestion', 'AskUserQuestionAsync', 'Sleep']));
    expect(registry.getTool('AskUserQuestion')).toBeDefined();
    expect(registry.getFunctionDeclarations()).toBe(before);
    registry.invalidateSchemaCache();
    expect(registry.getFunctionDeclarations()).toEqual(before);
    config.planStateManager.exit();
    registry.invalidateSchemaCache();
    expect(registry.getFunctionDeclarations()).toEqual(before);
    expect(registry.getTool('AskUserQuestion')).toBeDefined();
    await config.setAsyncUserInteractionEnabled(false);
    expect(names()).toContain('AskUserQuestion');
    expect(names()).not.toContain('Sleep');
  });

  it('does not restore a synchronous question excluded by the host', async () => {
    const config = makeFakeConfig();
    await config.setAsyncUserInteractionEnabled(true);
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new AskUserTool(config));
    vi.spyOn(config, 'getExcludeTools').mockReturnValue(new Set(['AskUserQuestion']));
    config.planStateManager.enter();
    expect(registry.getTool('AskUserQuestion')).toBeUndefined();
    expect(registry.getFunctionDeclarations()).toEqual([]);
  });

  it('does not expose new tools in a child registry or bypass interactive restrictions', async () => {
    const config = makeFakeConfig();
    await config.setAsyncUserInteractionEnabled(true);
    const child = new ToolRegistry(config, false);
    child.registerTool(new AskUserAsyncTool(config));
    child.registerTool(new SleepTool(config));
    expect(child.getTool('AskUserQuestionAsync')).toBeUndefined();
    expect(child.getTool('Sleep')).toBeUndefined();
    const main = new ToolRegistry(config, true);
    main.registerTool(new AskUserAsyncTool(config));
    main.registerTool(new SleepTool(config));
    vi.spyOn(config, 'shouldHideInteractiveTools').mockReturnValue(true);
    expect(main.getFunctionDeclarations().map((tool) => tool.name)).not.toContain('AskUserQuestionAsync');
    vi.spyOn(config, 'getExcludeTools').mockReturnValue(new Set(['Sleep']));
    expect(main.getTool('Sleep')).toBeUndefined();
  });
});

describe('ToolRegistry.getVisibleMcpTools', () => {
  afterEach(() => vi.restoreAllMocks());

  it('includes unregistered tools without changing registrations or cached schemas', () => {
    const config = makeFakeConfig();
    const registry = new ToolRegistry(config, true);
    const builtin = new MockTool({ name: 'Read' });
    registry.registerTool(builtin);
    const schemas = registry.getFunctionDeclarations();
    const tools = [
      mcpTool('browser', 'snapshot'),
      mcpTool('browser', 'navigate'),
    ];

    expect(registry.getVisibleMcpTools(tools)).toEqual([tools[1], tools[0]]);
    expect(registry.getAllKnownTools()).toEqual([builtin]);
    expect(registry.getFunctionDeclarations()).toBe(schemas);
    expect(registry.getKnownTool(tools[0].name)).toBeUndefined();
  });

  it.each(['mcp__browser__navigate', 'mcp__browser__*', 'mcp__*'])(
    'applies live deny rules to unregistered tools: %s',
    (rule) => {
      const config = makeFakeConfig();
      const registry = new ToolRegistry(config, true);
      const navigate = mcpTool('browser', 'navigate');
      const snapshot = mcpTool('browser', 'snapshot');
      config.permission!.setRules({
        allow: {},
        ask: {},
        deny: { userSettings: [rule] },
      });

      expect(registry.getVisibleMcpTools([navigate, snapshot])).toEqual(
        rule === navigate.name ? [snapshot] : [],
      );
      config.permission!.setRules({ allow: {}, ask: {}, deny: {} });
      expect(registry.getVisibleMcpTools([navigate, snapshot])).toEqual([
        navigate,
        snapshot,
      ]);
    },
  );

  it('filters aliases conflicting with builtins and rechecks live exclusions', () => {
    const config = makeFakeConfig();
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new MockTool({ name: 'Read' }));
    const tool = mcpTool('browser', 'read', 'Read');
    const warn = vi.spyOn(runLogger, 'warn');

    expect(registry.getVisibleMcpTools([tool])).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    vi.spyOn(config, 'getExcludeTools').mockReturnValue(new Set(['Read']));
    expect(registry.getVisibleMcpTools([tool])).toEqual([tool]);
  });

  it('resolves conflicts across the full catalog without publishing diagnostics', () => {
    const config = makeFakeConfig();
    const emitDiagnostic = vi.fn();
    vi.spyOn(config, 'getSessionMcpManager').mockReturnValue({
      emitDiagnostic,
    } as never);
    const registry = new ToolRegistry(config, true);
    const first = mcpTool('first', 'search', 'SearchDocs');
    const second = mcpTool('second', 'search', 'SearchDocs');
    const visible = mcpTool('first', 'read');
    const warn = vi.spyOn(runLogger, 'warn');

    expect(registry.getVisibleMcpTools([first, second, visible])).toEqual([
      visible,
    ]);
    expect(registry.getVisibleMcpTools([first, visible])).toEqual([
      visible,
      first,
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(emitDiagnostic).not.toHaveBeenCalled();
  });

  it('uses fresh definitions and deduplicates already registered tools', () => {
    const config = makeFakeConfig();
    const registry = new ToolRegistry(config, true);
    const old = mcpTool('browser', 'navigate');
    const fresh = mcpTool('browser', 'navigate');
    registry.registerTool(old);

    expect(registry.getVisibleMcpTools([fresh, fresh])).toEqual([fresh]);
    expect(registry.getKnownTool(old.name)).toBe(old);
  });
});
