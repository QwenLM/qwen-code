/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { runLogger } from '../utils/runLogger.js';
import {
  disposeBuiltinPlugins,
  initializeBuiltinPlugins,
  registerBuiltinPlugins,
  getBuiltinPluginRegistry,
} from '../test-utils/builtinPluginLifecycle.js';
import { syncBuiltinPluginTools } from './tool.js';

let registry: ToolRegistry;
let owned: Set<string>;
let tools: AnyDeclarativeTool[];

function tool(name: string, description = 'Plugin tool'): MockTool {
  return new MockTool({ name, description });
}

beforeEach(async () => {
  registry = new ToolRegistry({
    getExcludeTools: () => new Set<string>(),
  } as unknown as Config);
  owned = new Set();
  tools = [tool('ExampleTool')];
  registerBuiltinPlugins([
    {
      apiVersion: 1,
      id: 'override-test',
      initialize: async () => {},
      dispose: async () => {},
      getTools: () => tools,
    },
  ]);
  await initializeBuiltinPlugins({
    mode: 'interactive',
    isSettingSourceAllowed: () => true,
    whenReady: async () => {},
    notifyChanged: async () => {},
  });
});

afterEach(async () => {
  await disposeBuiltinPlugins();
  registerBuiltinPlugins([]);
});

it('registers a tool the host does not already have', async () => {
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  const registered = registry.getTool('ExampleTool');
  expect(registered).toBe(tools[0]);
  expect(registry.getFunctionDeclarations()).toEqual([
    expect.objectContaining({ name: 'ExampleTool', description: 'Plugin tool' }),
  ]);
  await expect(
    registered!.build({}).execute(new AbortController().signal),
  ).resolves.toEqual({
    llmContent: 'Tool ExampleTool executed successfully.',
    returnDisplay: 'Tool ExampleTool executed successfully.',
  });
});

it('replaces a host tool of the same name', () => {
  const host = tool('ExampleTool', 'Host tool');
  registry.registerTool(host);
  expect(registry.getFunctionDeclarations()[0].description).toBe('Host tool');

  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  expect(registry.getAllToolNames()).toEqual(['ExampleTool']);
  expect(registry.getTool('ExampleTool')).toBe(tools[0]);
  expect(registry.getFunctionDeclarations()[0].description).toBe(
    'Plugin tool',
  );
});

it('removes the tool when the contribution is withdrawn, without restoring the host', () => {
  registry.registerTool(tool('ExampleTool', 'Host tool'));
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  expect(registry.getTool('ExampleTool')).toBe(tools[0]);

  tools = [];
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  // The product build replaces the open implementation outright, so there is
  // no host implementation left to fall back to.
  expect(registry.getTool('ExampleTool')).toBeUndefined();
  expect(registry.getAllToolNames()).toEqual([]);
  expect(owned.size).toBe(0);
});

it('tolerates repeated withdrawal', () => {
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  tools = [];
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  expect(registry.getAllToolNames()).toEqual([]);
});

it('leaves an unchanged contribution alone instead of re-registering it', () => {
  const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  const registered = registry.getTool('ExampleTool');
  expect(warn).not.toHaveBeenCalled();

  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());

  expect(warn).not.toHaveBeenCalled();
  expect(registry.getTool('ExampleTool')).toBe(registered);
  expect([...owned]).toEqual(['ExampleTool']);
});

it('refreshes an existing contribution in place', () => {
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  const updated = tool('ExampleTool', 'Updated plugin tool');
  tools = [updated];
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  expect(registry.getTool('ExampleTool')).toBe(updated);
  expect(owned.size).toBe(1);
});

it('accepts hyphenated names so host and MCP tools can be replaced', () => {
  const name = 'mcp__qw-builtin__present_files';
  registry.registerTool(tool(name, 'Host tool'));
  tools = [tool(name)];
  syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry());
  expect(registry.getTool(name)).toBe(tools[0]);
  expect(registry.getAllToolNames()).toEqual([name]);
});

it('skips an invalid name, warns, and still registers the usable ones', () => {
  const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  const usable = tool('ExampleTool');
  tools = [usable, tool('invalid name')];
  expect(() => syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry())).not.toThrow();
  expect(warn).toHaveBeenCalledWith(
    '[builtin-plugins] Skipping tool with an invalid name',
    { name: 'invalid name' },
  );
  expect(registry.getTool('ExampleTool')).toBe(usable);
  expect([...owned]).toEqual(['ExampleTool']);
});

it('keeps the first of two duplicate names and warns', () => {
  const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  const first = tool('ExampleTool', 'First');
  const second = tool('ExampleTool', 'Second');
  tools = [first, second];
  expect(() => syncBuiltinPluginTools(registry, owned, getBuiltinPluginRegistry())).not.toThrow();
  expect(warn).toHaveBeenCalledWith(
    '[builtin-plugins] Skipping duplicate plugin tool',
    { name: 'ExampleTool' },
  );
  expect(registry.getTool('ExampleTool')).toBe(first);
  expect([...owned]).toEqual(['ExampleTool']);
});
