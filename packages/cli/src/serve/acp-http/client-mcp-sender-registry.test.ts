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

function setupBridge(
  addResult: Awaited<ReturnType<ClientMcpBridge['addRuntimeMcpServer']>>,
) {
  return {
    addRuntimeMcpServer: vi.fn(async () => addResult),
    removeRuntimeMcpServer: vi.fn(async () => ({})),
    addSessionRuntimeMcpServer: vi.fn(async () => addResult),
    removeSessionRuntimeMcpServer: vi.fn(async () => ({})),
  } satisfies ClientMcpBridge;
}

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

  it('routes session-scoped senders by exact session id', async () => {
    const reg = new ClientMcpSenderRegistry();
    const senderA = vi.fn(async () => msg(1));
    const senderB = vi.fn(async () => msg(2));
    reg.setSession('channel_loop', 'session-a', senderA, 'worker-a');
    reg.setSession('channel_loop', 'session-b', senderB, 'worker-a');

    await reg.lookup('channel_loop')!(msg(7), { sessionId: 'session-b' });

    expect(senderA).not.toHaveBeenCalled();
    expect(senderB).toHaveBeenCalledWith(msg(7));
  });

  it('keeps session deletion scoped to the current worker owner', async () => {
    const reg = new ClientMcpSenderRegistry();
    const senderA = vi.fn(async () => msg(1));
    const senderB = vi.fn(async () => msg(2));
    reg.setSession('channel_loop', 'session-a', senderA, 'worker-a');
    reg.setSession('channel_loop', 'session-a', senderB, 'worker-b');

    expect(reg.deleteSession('channel_loop', 'session-a', 'worker-a')).toBe(
      false,
    );
    await reg.lookup('channel_loop')!(msg(7), { sessionId: 'session-a' });
    expect(senderB).toHaveBeenCalled();
    expect(reg.deleteSession('channel_loop', 'session-a', 'worker-b')).toBe(
      true,
    );
  });

  it('never falls back to a global sender for a reserved session server', async () => {
    const reg = new ClientMcpSenderRegistry();
    const globalSender = vi.fn(async () => msg(1));
    reg.set('channel_loop', globalSender, 'browser');
    reg.setSession(
      'channel_loop',
      'session-a',
      vi.fn(async () => msg(2)),
      'worker',
    );

    await expect(
      reg.lookup('channel_loop')!(msg(7), { sessionId: 'session-b' }),
    ).rejects.toThrow(/No session-scoped MCP sender/);
    await expect(reg.lookup('channel_loop')!(msg(8))).rejects.toThrow(
      /requires a session context/,
    );
    expect(globalSender).not.toHaveBeenCalled();
  });
});

describe('createClientMcpServerProvider', () => {
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
      addSessionRuntimeMcpServer: vi.fn(async () => {
        throw new Error('boom');
      }),
      removeSessionRuntimeMcpServer: vi.fn(async () => ({})),
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

describe('createClientMcpServerProvider (session scope)', () => {
  const SESSION = 'session-1';

  it('adds to the one session only, never to the workspace, and eager-loads tools', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 2 });
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    const result = await provider.registerClientMcpServer(
      'local-files',
      vi.fn(async () => msg(1)),
      { sessionId: SESSION },
    );

    expect(result).toEqual({ toolCount: 2 });
    expect(bridge.addRuntimeMcpServer).not.toHaveBeenCalled();
    expect(bridge.addSessionRuntimeMcpServer).toHaveBeenCalledWith(
      SESSION,
      'local-files',
      // alwaysLoadTools: without it the tools sit behind tool_search and the
      // agent has to guess their names before it can use the bridge at all.
      expect.objectContaining({ type: 'sdk', alwaysLoadTools: true }),
      'connA',
    );
    // The workspace-wide name list stays empty — nothing leaked to siblings.
    expect(registry.serverNames()).toEqual([]);
  });

  it('routes the bound session and hard-rejects every other caller', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1 });
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');
    const sender = vi.fn(async () => msg(1));
    await provider.registerClientMcpServer('local-files', sender, {
      sessionId: SESSION,
    });

    const bound = registry.lookup('local-files');
    expect(bound).toBeTypeOf('function');

    await bound!(msg(7), { sessionId: SESSION });
    expect(sender).toHaveBeenCalledWith('local-files', msg(7));

    // A sibling session — including one created after the registration — must
    // not reach the client's machine through this server.
    await expect(bound!(msg(8), { sessionId: 'session-2' })).rejects.toThrow(
      /No session-scoped MCP sender/,
    );
    // Nor may a caller with no session context at all.
    await expect(bound!(msg(9))).rejects.toThrow(/requires a session context/);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('keeps a live re-registration when a stale earlier registration fails late', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1 });
    let releaseFirstAdd: ((ok: boolean) => void) | undefined;
    let addCalls = 0;
    bridge.addSessionRuntimeMcpServer.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          addCalls += 1;
          if (addCalls === 1) {
            releaseFirstAdd = (ok) =>
              ok ? resolve({ toolCount: 1 }) : reject(new Error('deadline'));
          } else {
            resolve({ toolCount: 1 });
          }
        }),
    );
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    // Register #1 parks inside the (slow) child-side add; the user reconnects
    // and register #2 re-installs the route on the same connection.
    const first = provider.registerClientMcpServer(
      'local-files',
      vi.fn(async () => msg(1)),
      { sessionId: SESSION },
    );
    const secondSender = vi.fn(async () => msg(2));
    await provider.registerClientMcpServer('local-files', secondSender, {
      sessionId: SESSION,
    });

    // The stale add finally rejects; its rollback must not tear down the
    // live second registration.
    releaseFirstAdd!(false);
    await expect(first).rejects.toThrow(/deadline/);

    expect(registry.lookup('local-files')).toBeTypeOf('function');
    expect(bridge.removeSessionRuntimeMcpServer).not.toHaveBeenCalled();
  });

  it('removes the session server on scoped unregister', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1 });
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');
    await provider.registerClientMcpServer(
      'local-files',
      vi.fn(async () => msg(1)),
      {
        sessionId: SESSION,
      },
    );

    await provider.unregisterClientMcpServer('local-files', {
      sessionId: SESSION,
    });

    expect(bridge.removeSessionRuntimeMcpServer).toHaveBeenCalledWith(
      SESSION,
      'local-files',
      'connA',
    );
    expect(bridge.removeRuntimeMcpServer).not.toHaveBeenCalled();
    expect(registry.lookup('local-files')).toBeUndefined();
  });

  it('leaves a session route a peer re-registered untouched', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1 });
    registry.setSession(
      'local-files',
      SESSION,
      vi.fn(async () => msg(2)),
      'connB',
    );
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    await provider.unregisterClientMcpServer('local-files', {
      sessionId: SESSION,
    });

    // connA never owned it: tearing the child server down by name would kill
    // connB's live tools.
    expect(bridge.removeSessionRuntimeMcpServer).not.toHaveBeenCalled();
    expect(registry.lookup('local-files')).toBeTypeOf('function');
  });

  it('rolls the session sender back when the add is skipped', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ skipped: true, reason: 'disabled' });
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    await expect(
      provider.registerClientMcpServer(
        'local-files',
        vi.fn(async () => msg(1)),
        {
          sessionId: SESSION,
        },
      ),
    ).rejects.toThrow(/runtime MCP add skipped: disabled/);

    expect(registry.lookup('local-files')).toBeUndefined();
    expect(bridge.removeSessionRuntimeMcpServer).toHaveBeenCalledWith(
      SESSION,
      'local-files',
      'connA',
    );
  });

  it('rolls the session sender back when settings already define the name', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1, shadowedSettings: true });
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    await expect(
      provider.registerClientMcpServer(
        'local-files',
        vi.fn(async () => msg(1)),
        {
          sessionId: SESSION,
        },
      ),
    ).rejects.toThrow(/conflicts with a configured MCP server/);

    expect(registry.lookup('local-files')).toBeUndefined();
    expect(bridge.removeSessionRuntimeMcpServer).toHaveBeenCalledWith(
      SESSION,
      'local-files',
      'connA',
    );
  });

  it('releases the name reservation when the last session entry goes', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1 });
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    await provider.registerClientMcpServer(
      'local-files',
      vi.fn(async () => msg(1)),
      { sessionId: SESSION },
    );
    await provider.unregisterClientMcpServer('local-files', {
      sessionId: SESSION,
    });

    // The reservation must not outlive the last session entry, or every
    // later workspace-wide registration of the name is acked and then
    // rejected at lookup for the daemon's lifetime.
    await expect(
      provider.registerClientMcpServer(
        'local-files',
        vi.fn(async () => msg(2)),
      ),
    ).resolves.toEqual({ toolCount: 1 });
    expect(bridge.addRuntimeMcpServer).toHaveBeenCalled();
    const bound = registry.lookup('local-files');
    expect(bound).toBeTypeOf('function');
    await expect(bound!(msg(3))).resolves.toBeDefined();
  });

  it('removes the child-side server when the route disappears mid-add', async () => {
    const registry = new ClientMcpSenderRegistry();
    const bridge = setupBridge({ toolCount: 1 });
    let resolveAdd: ((value: { toolCount: number }) => void) | undefined;
    bridge.addSessionRuntimeMcpServer = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveAdd = resolve;
        }),
    ) as unknown as typeof bridge.addSessionRuntimeMcpServer;
    const provider = createClientMcpServerProvider(registry, bridge, 'connA');

    const pending = provider.registerClientMcpServer(
      'local-files',
      vi.fn(async () => msg(1)),
      { sessionId: SESSION },
    );
    await Promise.resolve();
    // dispose() equivalent: the connection teardown deletes the entry while
    // the child-side add is still in flight.
    registry.deleteSession('local-files', SESSION, 'connA');
    resolveAdd!({ toolCount: 1 });

    await expect(pending).rejects.toThrow(/superseded/);
    expect(bridge.removeSessionRuntimeMcpServer).toHaveBeenCalledWith(
      SESSION,
      'local-files',
      'connA',
    );
  });
});
