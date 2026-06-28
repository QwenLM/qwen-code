/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  ClientMcpSenderRegistry,
  createClientMcpServerProvider,
  type ClientMcpBridge,
} from './client-mcp-sender-registry.js';

const msg = (id: number): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'ping',
});

describe('ClientMcpSenderRegistry', () => {
  it('lookup routes to the registered sender; undefined for unknown server', async () => {
    const reg = new ClientMcpSenderRegistry();
    const sender = vi.fn(async () => msg(1));
    reg.set('srv', sender, 'connA');

    expect(reg.serverNames()).toEqual(['srv']);
    expect(reg.lookup('other')).toBeUndefined();

    const bound = reg.lookup('srv');
    expect(bound).toBeTypeOf('function');
    await bound!(msg(7));
    expect(sender).toHaveBeenCalledWith('srv', msg(7));
  });

  it('ownership-scoped delete: a stale owner cannot remove an entry a peer re-registered', () => {
    const reg = new ClientMcpSenderRegistry();
    const senderA = vi.fn(async () => msg(1));
    const senderB = vi.fn(async () => msg(2));

    // A registers, then B re-registers the same name (last-writer-wins + takes
    // ownership — the regression: A's later teardown must not delete B's entry).
    reg.set('srv', senderA, 'connA');
    reg.set('srv', senderB, 'connB');

    reg.delete('srv', 'connA'); // A disconnects — must be a no-op now
    expect(reg.serverNames()).toEqual(['srv']);

    reg.lookup('srv')!(msg(9));
    expect(senderB).toHaveBeenCalledWith('srv', msg(9));
    expect(senderA).not.toHaveBeenCalled();

    reg.delete('srv', 'connB'); // the real owner removes it
    expect(reg.serverNames()).toEqual([]);
    expect(reg.lookup('srv')).toBeUndefined();
  });

  it('delete is idempotent and a no-op for an unknown name', () => {
    const reg = new ClientMcpSenderRegistry();
    reg.set(
      'srv',
      vi.fn(async () => msg(1)),
      'connA',
    );
    reg.delete('nope', 'connA'); // unknown name
    reg.delete('srv', 'connA'); // owned -> removed
    reg.delete('srv', 'connA'); // already gone -> no throw
    expect(reg.serverNames()).toEqual([]);
  });
});

describe('createClientMcpServerProvider', () => {
  function setupBridge(
    addResult: Awaited<ReturnType<ClientMcpBridge['addRuntimeMcpServer']>>,
  ) {
    return {
      addRuntimeMcpServer: vi.fn(async () => addResult),
      removeRuntimeMcpServer: vi.fn(async () => ({})),
    } satisfies ClientMcpBridge;
  }

  it('rolls back the sender when bridge add is skipped', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ skipped: true, reason: 'disabled' });
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    await expect(
      provider.registerClientMcpServer(
        'srv',
        vi.fn(async () => msg(1)),
      ),
    ).rejects.toThrow(/runtime MCP add skipped: disabled/);

    expect(registry.serverNames()).toEqual([]);
    expect(bridge.removeRuntimeMcpServer).not.toHaveBeenCalled();
  });

  it('removes the runtime server and rolls back the sender when settings are shadowed', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1, shadowedSettings: true });
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    await expect(
      provider.registerClientMcpServer(
        'srv',
        vi.fn(async () => msg(1)),
      ),
    ).rejects.toThrow(/conflicts with a configured MCP server/);

    expect(bridge.removeRuntimeMcpServer).toHaveBeenCalledWith('srv', 'connA');
    expect(registry.serverNames()).toEqual([]);
  });

  it('rolls back the sender when bridge add throws', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = {
      addRuntimeMcpServer: vi.fn(async () => {
        throw new Error('boom');
      }),
      removeRuntimeMcpServer: vi.fn(async () => ({})),
    } satisfies ClientMcpBridge;
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    await expect(
      provider.registerClientMcpServer(
        'srv',
        vi.fn(async () => msg(1)),
      ),
    ).rejects.toThrow('boom');

    expect(registry.serverNames()).toEqual([]);
    expect(bridge.removeRuntimeMcpServer).not.toHaveBeenCalled();
  });

  it('does not unregister a server now owned by another connection', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1 });
    registry.set(
      'srv',
      vi.fn(async () => msg(2)),
      'connB',
    );
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    await provider.unregisterClientMcpServer('srv');

    expect(registry.serverNames()).toEqual(['srv']);
    expect(bridge.removeRuntimeMcpServer).not.toHaveBeenCalled();
  });
});
