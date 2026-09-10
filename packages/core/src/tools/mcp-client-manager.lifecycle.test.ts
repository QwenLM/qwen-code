/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MCPServerConfig, type Config } from '../config/config.js';
import { McpClientManager } from './mcp-client-manager.js';
import { MCPServerStatus } from './mcp-client.js';
import { connectionIdOf } from './mcp-pool-key.js';
import { WorkspaceMcpBudget } from './mcp-workspace-budget.js';
import type { McpTransportPool } from './mcp-transport-pool.js';
import type { ToolRegistry } from './tool-registry.js';

vi.mock('./mcp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mcp-client.js')>()),
  populateMcpServerCommand: vi.fn((servers) => servers),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture() {
  const settings: Record<string, MCPServerConfig> = {
    srv: new MCPServerConfig('initial'),
  };
  const runtime: Record<string, MCPServerConfig> = {};
  const config = {
    isTrustedFolder: () => true,
    getMcpServers: () => ({ ...settings, ...runtime }),
    getSettingsMcpServers: () => settings,
    getRuntimeMcpServers: () => runtime,
    addRuntimeMcpServer: (name: string, recipe: MCPServerConfig) => {
      runtime[name] = recipe;
    },
    removeRuntimeMcpServer: (name: string) => {
      const present = name in runtime;
      delete runtime[name];
      return present;
    },
    getMcpServerCommand: () => undefined,
    getTargetDir: () => '/workspace',
    getSessionId: () => 'session',
    getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
    getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
    getWorkspaceContext: () => ({}),
    getDebugMode: () => false,
    isMcpServerDisabled: () => false,
    isMcpServerPendingApproval: () => false,
  } as unknown as Config;
  const connection = (
    name = 'srv',
    recipe: MCPServerConfig = config.getMcpServers()![name],
  ) =>
    Object.assign(new EventEmitter(), {
      id: connectionIdOf(name, recipe),
      transportId: connectionIdOf(name, recipe),
      state: 'active' as const,
      client: {
        getStatus: vi.fn((): MCPServerStatus => MCPServerStatus.CONNECTED),
        callTool: vi.fn(),
        readResource: vi.fn().mockResolvedValue({ contents: [] }),
      },
      toolsSnapshot: [{ name: 'echo' }],
      release: vi.fn(),
      updateConfig: vi.fn(),
    });
  const initial = connection();
  const replacement = connection();
  const pool = {
    acquire: vi.fn(async (_name: string, _recipe: MCPServerConfig) => initial),
    acquireForRecovery: vi.fn(async () => replacement),
    recordRecoveryFailure: vi.fn(),
    getBudget: () => undefined,
  };
  const toolRegistry = {
    removeMcpToolsByServer: vi.fn(),
    getToolsByServer: vi.fn(() => [{ name: 'echo' }]),
  } as unknown as ToolRegistry;
  const manager = new McpClientManager(config, toolRegistry, {
    pool: pool as unknown as McpTransportPool,
  });
  const fail = () =>
    initial.emit('event', {
      kind: 'failed',
      serverName: 'srv',
      generation: 0,
      lastError: 'transport lost',
    });
  const recover = () =>
    manager.recoverFailedConnections(new AbortController().signal);
  return {
    settings,
    runtime,
    config,
    manager,
    initial,
    replacement,
    connection,
    pool,
    fail,
    recover,
  };
}

describe('pooled management lifecycle', () => {
  it.each(['failed', 'closed'] as const)(
    'retains only missed failures when an acquired entry becomes %s before tracking',
    async (state) => {
      const f = fixture();
      f.pool.acquire.mockImplementationOnce(async () => {
        Object.assign(f.initial, { state });
        f.initial.client.getStatus.mockReturnValue(
          MCPServerStatus.DISCONNECTED,
        );
        return f.initial;
      });
      await f.manager.discoverAllMcpTools(f.config);
      expect(f.initial.release).toHaveBeenCalledOnce();
      await f.recover();
      if (state === 'failed') {
        expect(f.pool.acquireForRecovery).toHaveBeenCalledOnce();
        await expect(
          f.manager.readResource('srv', 'test://resource'),
        ).resolves.toEqual({ contents: [] });
        expect(f.replacement.client.readResource).toHaveBeenCalledOnce();
      } else {
        expect(f.pool.acquireForRecovery).not.toHaveBeenCalled();
        await expect(
          f.manager.readResource('srv', 'test://resource'),
        ).rejects.toThrow('pool connection unavailable');
      }
    },
  );

  it.each([MCPServerStatus.CONNECTING, MCPServerStatus.DISCONNECTED])(
    'keeps a new subscription when an active entry is %s during restart',
    async (status) => {
      const f = fixture();
      f.initial.client.getStatus.mockReturnValue(status);
      await f.manager.discoverAllMcpTools(f.config);
      expect(f.initial.release).not.toHaveBeenCalled();
      expect(f.initial.listenerCount('event')).toBe(1);
      f.initial.client.getStatus.mockReturnValue(MCPServerStatus.CONNECTED);
      await expect(
        f.manager.readResource('srv', 'test://resource'),
      ).resolves.toEqual({ contents: [] });
      expect(f.initial.client.readResource).toHaveBeenCalledOnce();
      f.fail();
      await f.recover();
      expect(f.pool.acquireForRecovery).toHaveBeenCalledOnce();
    },
  );

  it.each([MCPServerStatus.CONNECTING, MCPServerStatus.DISCONNECTED])(
    'keeps the runtime overlay and handle when the same entry is %s',
    async (status) => {
      const f = fixture();
      const recipe = f.settings['srv'];
      await f.manager.addRuntimeMcpServer('srv', recipe, 'client');
      f.initial.client.getStatus.mockReturnValue(status);
      await expect(
        f.manager.addRuntimeMcpServer('srv', recipe, 'client'),
      ).resolves.toMatchObject({ replaced: false });
      expect(f.runtime['srv']).toBe(recipe);
      expect(f.initial.release).not.toHaveBeenCalled();
      expect(f.initial.listenerCount('event')).toBe(1);
      expect(f.pool.acquire).toHaveBeenCalledOnce();
      f.initial.client.getStatus.mockReturnValue(MCPServerStatus.CONNECTED);
      await expect(
        f.manager.readResource('srv', 'test://resource'),
      ).resolves.toEqual({ contents: [] });
    },
  );

  it('attaches a runtime server to an entry another session is restarting', async () => {
    const f = fixture();
    f.initial.client.getStatus.mockReturnValue(MCPServerStatus.CONNECTING);
    await expect(
      f.manager.addRuntimeMcpServer('srv', f.settings['srv'], 'client'),
    ).resolves.toMatchObject({ name: 'srv' });
    expect(f.initial.release).not.toHaveBeenCalled();
    f.initial.client.getStatus.mockReturnValue(MCPServerStatus.CONNECTED);
    await expect(
      f.manager.readResource('srv', 'test://resource'),
    ).resolves.toEqual({ contents: [] });
  });

  it('restores the original runtime recipe after failed replacement', async () => {
    const f = fixture();
    const original = f.settings['srv'];
    await f.manager.addRuntimeMcpServer('srv', original, 'client');
    f.pool.acquire.mockRejectedValueOnce(new Error('replacement failed'));
    await expect(
      f.manager.addRuntimeMcpServer(
        'srv',
        new MCPServerConfig('bad'),
        'client',
      ),
    ).rejects.toThrow('replacement failed');
    expect(f.runtime['srv']).toBe(original);
    await f.recover();
    expect(f.pool.acquireForRecovery).toHaveBeenCalledOnce();
    await expect(
      f.manager.readResource('srv', 'test://resource'),
    ).resolves.toEqual({ contents: [] });
  });

  it.each(['remove', 'disconnect'] as const)(
    'late failed replacement cannot overwrite a concurrent %s',
    async (action) => {
      const f = fixture();
      await f.manager.addRuntimeMcpServer('srv', f.settings['srv'], 'client');
      const gate = deferred<void>();
      f.pool.acquire.mockImplementationOnce(async () => {
        await gate.promise;
        throw new Error('replacement failed');
      });
      const replacing = f.manager.addRuntimeMcpServer(
        'srv',
        new MCPServerConfig('bad'),
        'client',
      );
      await vi.waitFor(() => expect(f.pool.acquire).toHaveBeenCalledTimes(2));
      if (action === 'remove') {
        await f.manager.removeRuntimeMcpServer('srv', 'client');
      } else {
        await f.manager.disconnectServer('srv');
      }
      const afterManagement = f.runtime['srv'];
      gate.resolve();
      await expect(replacing).rejects.toThrow('replacement failed');
      expect(f.runtime['srv']).toBe(afterManagement);
      await f.recover();
      expect(f.pool.acquireForRecovery).not.toHaveBeenCalled();
      await expect(
        f.manager.readResource('srv', 'test://resource'),
      ).rejects.toThrow('pool connection unavailable');
    },
  );

  it('a new queued add cannot restore rollback authority after disconnect', async () => {
    const f = fixture();
    await f.manager.addRuntimeMcpServer('srv', f.settings['srv'], 'client');
    const gate = deferred<void>();
    f.pool.acquire.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('replacement failed');
    });
    const replacing = f.manager.addRuntimeMcpServer(
      'srv',
      new MCPServerConfig('bad'),
      'client',
    );
    await vi.waitFor(() => expect(f.pool.acquire).toHaveBeenCalledTimes(2));
    await f.manager.disconnectServer('srv');
    const disconnectedConfig = f.runtime['srv'];
    const next = f.manager.addRuntimeMcpServer('srv', {}, 'client');
    gate.resolve();
    await Promise.all([
      expect(replacing).rejects.toThrow('replacement failed'),
      expect(next).rejects.toThrow('config must specify'),
    ]);
    expect(f.runtime['srv']).toBe(disconnectedConfig);
    await f.recover();
    expect(f.pool.acquireForRecovery).not.toHaveBeenCalled();
    await expect(
      f.manager.readResource('srv', 'test://resource'),
    ).rejects.toThrow('pool connection unavailable');
  });

  it('queued replacements roll back to the original recipe when both fail', async () => {
    const f = fixture();
    const original = f.settings['srv'];
    await f.manager.addRuntimeMcpServer('srv', original, 'client');
    const gate = deferred<void>();
    f.pool.acquire.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('first replacement failed');
    });
    const first = f.manager.addRuntimeMcpServer(
      'srv',
      new MCPServerConfig('bad1'),
      'client',
    );
    await vi.waitFor(() => expect(f.pool.acquire).toHaveBeenCalledTimes(2));
    f.pool.acquire.mockRejectedValueOnce(
      new Error('second replacement failed'),
    );
    const second = f.manager.addRuntimeMcpServer(
      'srv',
      new MCPServerConfig('bad2'),
      'client',
    );
    gate.resolve();
    await Promise.all([
      expect(first).rejects.toThrow('first replacement failed'),
      expect(second).rejects.toThrow('second replacement failed'),
    ]);
    expect(f.runtime['srv']).toBe(original);
  });

  it('failed runtime add preserves recovery of the settings server', async () => {
    const f = fixture();
    await f.manager.discoverAllMcpTools(f.config);
    f.fail();
    f.pool.acquire.mockRejectedValueOnce(new Error('new recipe failed'));
    await expect(
      f.manager.addRuntimeMcpServer(
        'srv',
        new MCPServerConfig('replacement'),
        'client',
      ),
    ).rejects.toThrow('new recipe failed');
    expect(f.runtime).toEqual({});
    expect(f.config.getMcpServers()).toHaveProperty('srv', f.settings['srv']);
    await f.recover();
    expect(f.pool.acquireForRecovery).toHaveBeenCalledOnce();
    await expect(
      f.manager.readResource('srv', 'test://resource'),
    ).resolves.toEqual({ contents: [] });
    expect(f.replacement.client.callTool).not.toHaveBeenCalled();
  });

  it('not-present runtime remove preserves settings-server recovery', async () => {
    const f = fixture();
    await f.manager.discoverAllMcpTools(f.config);
    f.fail();
    f.pool.acquireForRecovery.mockRejectedValueOnce(
      new Error('temporarily unavailable'),
    );
    await f.manager.recoverFailedConnections(new AbortController().signal, {
      consumeNotices: false,
    });
    f.pool.acquireForRecovery.mockClear();
    await expect(
      f.manager.removeRuntimeMcpServer('srv', 'client'),
    ).resolves.toMatchObject({ skipped: true, reason: 'not_present' });
    await f.recover();
    expect(f.pool.acquireForRecovery).toHaveBeenCalledOnce();
    await expect(
      f.manager.readResource('srv', 'test://resource'),
    ).resolves.toEqual({ contents: [] });
  });

  it('not-present runtime remove does not cancel a parked add', async () => {
    const f = fixture();
    const discoveryGate = deferred<typeof f.initial>();
    f.pool.acquire.mockReturnValueOnce(discoveryGate.promise);
    const discovery = f.manager.discoverAllMcpTools(f.config);
    const recipe = new MCPServerConfig('new');
    const addedConnection = f.connection('added', recipe);
    f.pool.acquire.mockResolvedValueOnce(addedConnection);
    const adding = f.manager
      .addRuntimeMcpServer('added', recipe, 'client')
      .then(
        (value) => ({ value, error: undefined }),
        (error: Error) => ({ value: undefined, error: error.message }),
      );
    await expect(
      f.manager.removeRuntimeMcpServer('added', 'client'),
    ).resolves.toMatchObject({ skipped: true, reason: 'not_present' });
    discoveryGate.resolve(f.initial);
    await discovery;
    const result = await adding;
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ name: 'added', toolCount: 1 });
    expect(f.manager.getServerStatus('added')).toBe(MCPServerStatus.CONNECTED);
  });

  it('old queued refresh does not release a successful explicit re-add', async () => {
    const f = fixture();
    await f.manager.discoverAllMcpTools(f.config);
    f.fail();
    const recoveryGate = deferred<typeof f.replacement>();
    f.pool.acquireForRecovery.mockReturnValueOnce(recoveryGate.promise);
    const recovering = f.recover();
    const refresh = f.manager.discoverAllMcpTools(f.config);
    await f.manager.disconnectServer('srv');
    const recipe = new MCPServerConfig('corrected');
    const readded = f.connection('srv', recipe);
    f.pool.acquire.mockResolvedValueOnce(readded);
    const adding = f.manager.addRuntimeMcpServer('srv', recipe, 'client');
    recoveryGate.resolve(f.replacement);
    await expect(adding).resolves.toMatchObject({ name: 'srv', toolCount: 1 });
    await Promise.all([recovering, refresh]);
    expect(readded.release).not.toHaveBeenCalled();
    await expect(
      f.manager.readResource('srv', 'test://resource'),
    ).resolves.toEqual({ contents: [] });
  });

  it('explicit full discovery arriving during an excluded pass discovers the requested server', async () => {
    const f = fixture();
    await f.manager.discoverAllMcpTools(f.config);
    f.fail();
    const recoveryGate = deferred<typeof f.replacement>();
    f.pool.acquireForRecovery.mockReturnValueOnce(recoveryGate.promise);
    const recovering = f.recover();
    const firstRefresh = f.manager.discoverAllMcpTools(f.config);
    await f.manager.disconnectServer('srv');
    f.settings['other'] = new MCPServerConfig('other');
    const other = f.connection('other');
    const otherGate = deferred<typeof other>();
    f.pool.acquire.mockReturnValueOnce(otherGate.promise);
    f.pool.acquire.mockResolvedValue(f.replacement);
    recoveryGate.resolve(f.replacement);
    await vi.waitFor(() => expect(f.pool.acquire).toHaveBeenCalledTimes(2));
    const secondRefresh = f.manager.discoverAllMcpTools(f.config);
    otherGate.resolve(other);
    await Promise.all([recovering, firstRefresh, secondRefresh]);
    const statusAfterSecondRefresh = f.manager.getServerStatus('srv');
    // Positive control: same requested server is acquirable outside this overlap.
    await f.manager.discoverAllMcpTools(f.config);
    expect(f.manager.getServerStatus('srv')).toBe(MCPServerStatus.CONNECTED);
    expect(statusAfterSecondRefresh).toBe(MCPServerStatus.CONNECTED);
  });

  it('a resource read during CONNECTING does not drop the session handle', async () => {
    const f = fixture();
    await f.manager.discoverAllMcpTools(f.config);
    f.initial.client.getStatus.mockReturnValue(MCPServerStatus.CONNECTING);
    await f.manager
      .readResource('srv', 'test://resource')
      .catch(() => undefined);
    const releaseCount = f.initial.release.mock.calls.length;
    f.initial.client.getStatus.mockReturnValue(MCPServerStatus.CONNECTED);
    await f.manager
      .readResource('srv', 'test://resource')
      .catch(() => undefined);
    expect(releaseCount).toBe(0);
    expect(f.pool.acquireForRecovery).not.toHaveBeenCalled();
    expect(f.initial.client.readResource).toHaveBeenCalledOnce();
  });

  it('clearing the final refusal updates state without emitting an empty refused batch', () => {
    const onEvent = vi.fn();
    const budget = new WorkspaceMcpBudget({
      clientBudget: 1,
      mode: 'enforce',
      onEvent,
    });
    budget.beginBulkPass();
    budget.recordRefusal('srv', 'stdio');
    budget.endBulkPass();
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'refused_batch',
        refusedServers: [
          { name: 'srv', transport: 'stdio', reason: 'budget_exhausted' },
        ],
      }),
    );
    onEvent.mockClear();
    budget.beginBulkPass({ preserveRefusals: true });
    budget.clearRefusal('srv');
    budget.endBulkPass();
    expect(budget.getRefusedServerNames()).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
