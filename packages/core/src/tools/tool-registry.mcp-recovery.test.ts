/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallableTool } from '@google/genai';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, type MCPServerConfig } from '../config/config.js';
import { ToolRegistry } from './tool-registry.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import type { McpTransportPool } from './mcp-transport-pool.js';
import { MCPServerStatus } from './mcp-client.js';
import { connectionIdOf } from './mcp-pool-key.js';

function makeConfig(
  servers: Record<string, MCPServerConfig> = { server: { command: 'node' } },
) {
  return new Config({
    cwd: process.cwd(),
    targetDir: process.cwd(),
    model: 'test-model',
    debugMode: false,
    mcpServers: servers,
  });
}

function makeTool(
  config: Config,
  name = 'read',
  trust = true,
  serverName = 'server',
) {
  const callTool = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'fresh result' }],
  });
  const tool = new DiscoveredMCPTool(
    {} as CallableTool,
    serverName,
    name,
    name,
    { type: 'object', properties: {} },
    trust,
    undefined,
    config,
    { callTool },
    undefined,
    undefined,
    { readOnlyHint: true },
  ).withSessionConfig(trust, false, false);
  return { tool, callTool };
}

afterEach(() => vi.restoreAllMocks());

describe('inherited MCP recovery', () => {
  it.each(['connected', 'failed', 'disconnected'])(
    'keeps independently discovered HTTP resources in the child when %s',
    async (state) => {
      const recipe = { httpUrl: 'https://example.invalid/mcp' };
      const sourceConfig = makeConfig({ server: recipe });
      const childConfig = makeConfig({ server: { ...recipe } });
      const childRead = vi.fn().mockResolvedValue({
        contents: [{ uri: 'test://resource', text: 'child session' }],
      });
      const handle = Object.assign(new EventEmitter(), {
        id: connectionIdOf('server', recipe),
        transportId: connectionIdOf('server', recipe),
        state: 'active' as const,
        client: {
          getStatus: () => MCPServerStatus.CONNECTED,
          readResource: childRead,
        },
        updateConfig: vi.fn(),
        release: vi.fn(),
      });
      const pool = {
        acquire: vi.fn().mockResolvedValue(handle),
        acquireForRecovery: vi
          .fn()
          .mockRejectedValue(new Error('child unavailable')),
        getBudget: () => undefined,
      } as unknown as McpTransportPool;
      sourceConfig.setMcpTransportPool(pool);
      childConfig.setMcpTransportPool(pool);
      const source = new ToolRegistry(sourceConfig);
      const child = new ToolRegistry(childConfig);
      child.copyDiscoveredToolsFrom(source);
      const parentRead = vi
        .spyOn(source.getMcpClientManager(), 'readResource')
        .mockResolvedValue({
          contents: [{ uri: 'test://resource', text: 'parent session' }],
        });
      await child.getMcpClientManager().discoverAllMcpTools(childConfig);
      if (state === 'failed')
        handle.emit('event', {
          kind: 'failed',
          serverName: 'server',
          generation: 0,
        });
      if (state === 'disconnected')
        await child.getMcpClientManager().disconnectServer('server');
      const reading = child.readMcpResource('server', 'test://resource');
      if (state === 'connected')
        await expect(reading).resolves.toEqual({
          contents: [{ uri: 'test://resource', text: 'child session' }],
        });
      else await expect(reading).rejects.toThrow('pool connection unavailable');
      expect(parentRead).not.toHaveBeenCalled();
      expect(childRead).toHaveBeenCalledTimes(state === 'connected' ? 1 : 0);
      await child.stop();
    },
  );

  it('refreshes the calling child tool after inherited resource recovery', async () => {
    const config = makeConfig();
    config.setMcpTransportPool({} as McpTransportPool);
    const source = new ToolRegistry(config);
    const child = new ToolRegistry(config);
    const old = makeTool(config);
    const fresh = makeTool(config);
    source.registerTool(old.tool);
    child.copyDiscoveredToolsFrom(source);
    vi.spyOn(
      source.getMcpClientManager(),
      'recoverFailedConnections',
    ).mockImplementation(async () => {
      source.removeMcpToolsByServer('server');
      source.registerTool(fresh.tool);
      return [];
    });
    vi.spyOn(source.getMcpClientManager(), 'readResource').mockResolvedValue({
      contents: [],
    });
    await child.readMcpResource('server', 'test://resource');
    await child
      .getTool(fresh.tool.name)!
      .build({})
      .execute(new AbortController().signal);
    expect(fresh.callTool).toHaveBeenCalledOnce();
    expect(old.callTool).not.toHaveBeenCalled();
  });

  it.each([
    { trust: false },
    { includeTools: ['inspect'] },
    { excludeTools: ['read'] },
    { alwaysLoadTools: true },
  ])(
    'does not replace an unavailable child override with parent policy %j',
    async (metadata) => {
      const sourceConfig = makeConfig({
        server: { command: 'node', trust: true },
      });
      const childConfig = makeConfig({
        server: { command: 'node', trust: true, ...metadata },
      });
      const source = new ToolRegistry(sourceConfig);
      const child = new ToolRegistry(childConfig);
      const tool = makeTool(sourceConfig).tool;
      source.registerTool(tool);
      child.copyDiscoveredToolsFrom(source);
      child.removeMcpToolsByServer('server');
      await child.refreshMcpTools(new AbortController().signal);
      expect(child.getToolsByServer('server')).toEqual([]);
      expect(source.getTool(tool.name)).toBe(tool);
    },
  );

  it.each([false, true])(
    'compares the effective cwd of an independent override (same directory: %s)',
    async (sameDirectory) => {
      const sourceConfig = makeConfig({ server: { command: 'node' } });
      const childConfig = makeConfig({ server: { command: 'node' } });
      vi.spyOn(sourceConfig, 'getTargetDir').mockReturnValue('/parent');
      vi.spyOn(childConfig, 'getTargetDir').mockReturnValue(
        sameDirectory ? '/parent' : '/child',
      );
      const source = new ToolRegistry(sourceConfig);
      const child = new ToolRegistry(childConfig);
      const tool = makeTool(sourceConfig).tool;
      source.registerTool(tool);
      child.copyDiscoveredToolsFrom(source);
      child.removeMcpToolsByServer('server');
      await child.refreshMcpTools(new AbortController().signal);
      expect(child.getTool(tool.name)).toBe(sameDirectory ? tool : undefined);
    },
  );

  it('keeps source ownership when a working-tree child borrows the same recipe', async () => {
    const servers = { server: { command: 'node' } };
    const sourceConfig = makeConfig(servers);
    const childConfig = makeConfig(servers);
    vi.spyOn(sourceConfig, 'getTargetDir').mockReturnValue('/parent');
    vi.spyOn(childConfig, 'getTargetDir').mockReturnValue('/child');
    const source = new ToolRegistry(sourceConfig);
    const child = new ToolRegistry(childConfig);
    const tool = makeTool(sourceConfig).tool;
    source.registerTool(tool);
    child.copyDiscoveredToolsFrom(source);
    await child.refreshMcpTools(new AbortController().signal);
    expect(child.getTool(tool.name)).toBe(tool);
  });

  it.each([
    {
      sourceCommand: 'node parent.mjs',
      childCommand: 'node parent.mjs',
      inherit: true,
      rawEntry: false,
    },
    {
      sourceCommand: 'node parent.mjs',
      childCommand: 'node parent.mjs',
      inherit: true,
      rawEntry: true,
    },
    {
      sourceCommand: 'node parent.mjs',
      childCommand: 'node child.mjs',
      inherit: false,
      rawEntry: true,
    },
    {
      sourceCommand: 'node parent.mjs',
      childCommand: undefined,
      inherit: false,
      rawEntry: true,
    },
    {
      sourceCommand: undefined,
      childCommand: 'node child.mjs',
      inherit: false,
      rawEntry: true,
    },
  ])(
    'keeps command-derived MCP ownership for a working-tree borrower: %j',
    async ({ sourceCommand, childCommand, inherit, rawEntry }) => {
      // The command-derived service replaces a raw entry named "mcp".
      const servers: Record<string, MCPServerConfig> = rawEntry
        ? { mcp: { command: 'node', args: ['raw.mjs'] } }
        : {};
      const sourceConfig = makeConfig(servers);
      const childConfig = makeConfig(servers);
      vi.spyOn(sourceConfig, 'getMcpServerCommand').mockReturnValue(
        sourceCommand,
      );
      vi.spyOn(childConfig, 'getMcpServerCommand').mockReturnValue(
        childCommand,
      );
      vi.spyOn(sourceConfig, 'getTargetDir').mockReturnValue('/parent');
      vi.spyOn(childConfig, 'getTargetDir').mockReturnValue('/child');
      const source = new ToolRegistry(sourceConfig);
      const child = new ToolRegistry(childConfig);
      const { tool, callTool } = makeTool(sourceConfig, 'read', true, 'mcp');
      source.registerTool(tool);
      child.copyDiscoveredToolsFrom(source);
      await child.refreshMcpTools(new AbortController().signal);
      expect(child.getTool(tool.name)).toBe(inherit ? tool : undefined);
      if (inherit) {
        await child
          .getTool(tool.name)!
          .build({})
          .execute(new AbortController().signal);
        expect(callTool).toHaveBeenCalledOnce();
      }
    },
  );

  it('reads inherited resources through their owning pool manager', async () => {
    const config = makeConfig({ server: { command: 'parent-mcp' } });
    config.setMcpTransportPool({} as McpTransportPool);
    const source = new ToolRegistry(config);
    const child = new ToolRegistry(config);
    child.copyDiscoveredToolsFrom(source);
    const read = vi
      .spyOn(source.getMcpClientManager(), 'readResource')
      .mockResolvedValue({
        contents: [{ uri: 'test://resource', text: 'parent data' }],
      });
    const childRead = vi.spyOn(child.getMcpClientManager(), 'readResource');
    await expect(
      child.readMcpResource('server', 'test://resource'),
    ).resolves.toEqual({
      contents: [{ uri: 'test://resource', text: 'parent data' }],
    });
    expect(read).toHaveBeenCalledOnce();
    expect(childRead).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'pending', 'untrusted', 'stopped'] as const)(
    'checks the child policy after inherited resource recovery: %s',
    async (policy) => {
      const config = makeConfig({ server: { command: 'parent-mcp' } });
      config.setMcpTransportPool({} as McpTransportPool);
      const source = new ToolRegistry(config);
      const child = new ToolRegistry(config);
      child.copyDiscoveredToolsFrom(source);
      const read = vi.spyOn(source.getMcpClientManager(), 'readResource');
      vi.spyOn(source, 'refreshMcpTools').mockImplementation(async () => {
        if (policy === 'disabled')
          vi.spyOn(config, 'isMcpServerDisabled').mockReturnValue(true);
        if (policy === 'pending')
          vi.spyOn(config, 'isMcpServerPendingApproval').mockReturnValue(true);
        if (policy === 'untrusted')
          vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
        if (policy === 'stopped') await child.stop();
      });
      await expect(
        child.readMcpResource('server', 'test://resource'),
      ).rejects.toThrow('no longer available');
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('replaces the copied client for a later call without replaying the failed invocation', async () => {
    const config = makeConfig();
    const source = new ToolRegistry(config);
    const child = new ToolRegistry(config);
    const old = makeTool(config);
    old.callTool.mockRejectedValue(new Error('Connection closed'));
    source.registerTool(old.tool);
    child.copyDiscoveredToolsFrom(source);
    const signal = new AbortController().signal;
    const invocation = child.getTool(old.tool.name)!.build({});
    await expect(invocation.execute(signal)).rejects.toThrow(
      /outcome.*unknown|unknown.*outcome/i,
    );

    const fresh = makeTool(config, 'read', false);
    const added = makeTool(config, 'inspect', false);
    const recover = vi
      .spyOn(source.getMcpClientManager(), 'recoverFailedConnections')
      .mockImplementation(async () => {
        source.removeMcpToolsByServer('server');
        source.registerTool(fresh.tool);
        source.registerTool(added.tool);
        return [];
      });

    await child.refreshMcpTools(signal);

    expect(recover).toHaveBeenCalledWith(signal, { consumeNotices: false });
    expect(child.getTool(old.tool.name)).toBe(fresh.tool);
    expect(child.getTool(added.tool.name)).toBe(added.tool);
    expect(await fresh.tool.build({}).getDefaultPermission()).toBe('ask');
    expect(old.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.callTool).not.toHaveBeenCalled();
    await child.getTool(fresh.tool.name)!.build({}).execute(signal);
    expect(fresh.callTool).toHaveBeenCalledTimes(1);
    expect(old.callTool).toHaveBeenCalledTimes(1);
  });

  it('propagates source removal and recovery through nested copied registries', async () => {
    const config = makeConfig();
    const source = new ToolRegistry(config);
    const child = new ToolRegistry(config);
    const grandchild = new ToolRegistry(config);
    const old = makeTool(config);
    source.registerTool(old.tool);
    child.copyDiscoveredToolsFrom(source);
    grandchild.copyDiscoveredToolsFrom(child);
    source.removeMcpToolsByServer('server');

    await grandchild.refreshMcpTools(new AbortController().signal);
    expect(child.getTool(old.tool.name)).toBeUndefined();
    expect(grandchild.getTool(old.tool.name)).toBeUndefined();

    const fresh = makeTool(config);
    source.registerTool(fresh.tool);
    await grandchild.refreshMcpTools(new AbortController().signal);
    expect(grandchild.getTool(fresh.tool.name)).toBe(fresh.tool);
  });

  it('preserves agent-owned tools and does not inherit tools from an overridden server', async () => {
    const sourceConfig = makeConfig({ server: { command: 'parent-mcp' } });
    const childConfig = makeConfig({ server: { command: 'agent-mcp' } });
    const source = new ToolRegistry(sourceConfig);
    const child = new ToolRegistry(childConfig);
    const old = makeTool(sourceConfig);
    source.registerTool(old.tool);
    child.copyDiscoveredToolsFrom(source);
    child.removeMcpToolsByServer('server');
    const local = makeTool(childConfig);
    child.registerTool(local.tool);
    const parentOnly = makeTool(sourceConfig, 'parent_only');
    source.registerTool(parentOnly.tool);

    await child.refreshMcpTools(new AbortController().signal);
    expect(child.getTool(local.tool.name)).toBe(local.tool);
    expect(child.getTool(parentOnly.tool.name)).toBeUndefined();
    source.removeMcpToolsByServer('server');
    await child.refreshMcpTools(new AbortController().signal);
    expect(child.getTool(local.tool.name)).toBe(local.tool);
  });

  it('does not restore source tools when an agent override has no surviving registrations', async () => {
    const sourceConfig = makeConfig({ server: { command: 'parent-mcp' } });
    const childConfig = makeConfig({ server: { command: 'agent-mcp' } });
    const source = new ToolRegistry(sourceConfig);
    const child = new ToolRegistry(childConfig);
    const tool = makeTool(sourceConfig).tool;
    source.registerTool(tool);
    child.copyDiscoveredToolsFrom(source);
    child.removeMcpToolsByServer('server');

    await child.refreshMcpTools(new AbortController().signal);
    expect(child.getToolsByServer('server')).toEqual([]);
  });

  it.each(['disabled', 'pending', 'untrusted', 'tool-disabled'] as const)(
    'drops inherited tools when child policy becomes %s',
    async (policy) => {
      const config = makeConfig();
      const source = new ToolRegistry(config);
      const child = new ToolRegistry(config);
      const tool = makeTool(config).tool;
      source.registerTool(tool);
      child.copyDiscoveredToolsFrom(source);
      if (policy === 'disabled') {
        vi.spyOn(config, 'isMcpServerDisabled').mockReturnValue(true);
      } else if (policy === 'pending') {
        vi.spyOn(config, 'isMcpServerPendingApproval').mockReturnValue(true);
      } else if (policy === 'untrusted') {
        vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
      } else {
        vi.spyOn(config, 'getDisabledTools').mockReturnValue(
          new Set([tool.name]),
        );
      }

      await child.refreshMcpTools(new AbortController().signal);
      expect(child.getTool(tool.name)).toBeUndefined();
      expect(source.getTool(tool.name)).toBe(tool);
    },
  );

  it('does not refill a stopped child after its source recovery finishes', async () => {
    const config = makeConfig();
    const source = new ToolRegistry(config);
    const child = new ToolRegistry(config);
    const old = makeTool(config);
    source.registerTool(old.tool);
    child.copyDiscoveredToolsFrom(source);
    let finishRecovery!: (notices: []) => void;
    const recovery = new Promise<[]>((resolve) => {
      finishRecovery = resolve;
    });
    vi.spyOn(
      source.getMcpClientManager(),
      'recoverFailedConnections',
    ).mockReturnValue(recovery);

    const refresh = child.refreshMcpTools(new AbortController().signal);
    await child.stop();
    const fresh = makeTool(config);
    source.removeMcpToolsByServer('server');
    source.registerTool(fresh.tool);
    finishRecovery([]);
    await refresh;
    expect(child.getToolsByServer('server')).toEqual([]);
  });

  it('removes copied tools after the source registry stops', async () => {
    const config = makeConfig();
    const source = new ToolRegistry(config);
    const child = new ToolRegistry(config);
    const tool = makeTool(config).tool;
    source.registerTool(tool);
    child.copyDiscoveredToolsFrom(source);

    await source.stop();
    await child.refreshMcpTools(new AbortController().signal);

    expect(child.getTool(tool.name)).toBeUndefined();
  });
});
