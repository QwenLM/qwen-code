/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import type { ResourceService } from '@qwen-code/resource';
import type { MCPServerConfig } from './mcpServerConfig.js';
import type { McpConnector, McpConnectorMap } from './connector/types.js';
import { UnauthorizedError } from '../utils/errors.js';
import { mcpServerKey, mcpServerKeyId, type McpSourceId } from './server-key.js';
import { McpManager } from './mcpManager.js';
import type { McpServerRegistration } from './mcpManager.js';
import { runLogger } from '../utils/runLogger.js';

const mocks = vi.hoisted(() => ({
  connectToMcpServer: vi.fn(),
  discoverTools: vi.fn(),
  discoverPrompts: vi.fn(),
  discoverResources: vi.fn(),
  invokeMcpPrompt: vi.fn(),
}));

vi.mock('./connector/connectMcpServer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    connectToMcpServer: mocks.connectToMcpServer,
  };
});

vi.mock('./tools/mcp-tool.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverTools: mocks.discoverTools };
});

vi.mock('./tools/mcp-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    discoverPrompts: mocks.discoverPrompts,
    invokeMcpPrompt: mocks.invokeMcpPrompt,
  };
});

vi.mock('./tools/mcp-resource.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverResources: mocks.discoverResources };
});

// Imported after the mock so MCPServerStatus is the real enum (spread above) and
// the mocked connectToMcpServer binding is installed before McpClient loads it.
const { MCPServerStatus } = await import('./client/mcpClient.js');

function createFakeClient() {
  const handlers = new Map<unknown, (n: unknown) => Promise<void>>();
  return {
    getServerCapabilities: () => ({ tools: {}, prompts: {}, resources: {} }),
    setNotificationHandler: (s: unknown, h: (n: unknown) => Promise<void>) => {
      handlers.set(s, h);
    },
    getInstructions: () => undefined,
    callTool: vi.fn(async () => ({ content: [] })),
    request: vi.fn(async () => ({ contents: [] })),
    notification: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onclose: undefined,
    onerror: undefined,
  };
}

const stdioConfig = { command: 'node', args: ['s.js'] } as MCPServerConfig;
const connector: McpConnector = {
  connect: vi.fn(async () => ({ transport: {} as never })),
};
const connectorMap: McpConnectorMap = new Map([['stdio', connector]]);


function reg(
  name: string,
  source: McpSourceId = 'sdk',
): McpServerRegistration {
  return {
    key: mcpServerKey(source, name),
    config: stdioConfig,
    rootsDir: os.tmpdir(),
  };
}

function createManager() {
  const resourceService = {} as ResourceService;
  const manager = new McpManager(resourceService, connectorMap, '1.0.0', false, {
    enableEnvironmentVariableRedaction: false,
    allowedEnvironmentVariables: [],
    blockedEnvironmentVariables: [],
  });
  return { manager, resourceService };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectToMcpServer.mockImplementation(async () => createFakeClient());
  mocks.discoverTools.mockResolvedValue([{ name: 't' }]);
  mocks.discoverPrompts.mockResolvedValue([]);
  mocks.discoverResources.mockResolvedValue([]);
});

describe('McpManager process lifecycle', () => {
  it.each([2, 3])(
    'deduplicates %i identical file-source stdio servers during prewarm and registration',
    async (count) => {
      const { manager } = createManager();
      const servers = Array.from({ length: count }, (_, index) => ({
        ...reg(`dup-${index}`, 'file:/user/settings.json'),
        config: { ...stdioConfig, env: { A: '1', B: '2' } },
      }));
      const debug = vi.spyOn(runLogger, 'debug');
      try {
        await manager.reloadUserMcpServers(servers);
        await manager.registerMcpServers('s1', servers);
        expect(mocks.connectToMcpServer).toHaveBeenCalledOnce();
        expect(manager.getClient(servers[0].key)).toBeDefined();
        for (const server of servers.slice(1)) {
          expect(manager.getClient(server.key)).toBeUndefined();
          expect(debug).toHaveBeenCalledWith(
            `[MCP] Skipping "${server.key.name}" — duplicate of "dup-0" (same transport signature)`,
          );
        }
      } finally {
        debug.mockRestore();
        await manager.dispose();
      }
    },
  );

  it('deduplicates reversed env keys and omitted versus empty env', async () => {
    const { manager } = createManager();
    try {
      await manager.registerMcpServers('s1', [
        {
          ...reg('a', 'file:/env'),
          config: { command: 'node', env: { A: '1', B: '2' } },
        },
        {
          ...reg('b', 'file:/env'),
          config: { command: 'node', env: { B: '2', A: '1' } },
        },
        { ...reg('c', 'file:/empty'), config: { command: 'node' } },
        {
          ...reg('d', 'file:/empty'),
          config: { command: 'node', args: [], env: {} },
        },
      ]);
      expect(mocks.connectToMcpServer).toHaveBeenCalledTimes(2);
    } finally {
      await manager.dispose();
    }
  });

  it('recomputes prewarm winners when configs change or the first name is removed', async () => {
    const { manager } = createManager();
    const a = reg('a', 'file:/settings');
    const b = reg('b', 'file:/settings');
    try {
      await manager.reloadUserMcpServers([
        a,
        { ...b, config: { ...b.config, env: { REGION: 'other' } } },
      ]);
      expect(manager.getClients()).toHaveLength(2);
      await manager.reloadUserMcpServers([a, b]);
      expect(manager.getClients()).toHaveLength(1);
      expect(manager.getClient(b.key)).toBeUndefined();
      await manager.reloadUserMcpServers([b]);
      expect(manager.getClients()).toHaveLength(1);
      expect(manager.getClient(a.key)).toBeUndefined();
      expect(manager.getClient(b.key)).toBeDefined();
    } finally {
      await manager.dispose();
    }
  });

  it.each([
    { label: 'source', override: { key: mcpServerKey('file:/other', 'b') } },
    { label: 'roots', override: { rootsDir: '/other' } },
    {
      label: 'command',
      override: { config: { ...stdioConfig, command: 'python' } },
    },
    {
      label: 'args',
      override: { config: { ...stdioConfig, args: ['other.js'] } },
    },
    {
      label: 'env',
      override: { config: { ...stdioConfig, env: { REGION: 'other' } } },
    },
    { label: 'cwd', override: { config: { ...stdioConfig, cwd: '/other' } } },
  ])(
    'keeps stdio servers with different $label independent',
    async ({ override }) => {
      const { manager } = createManager();
      try {
        await manager.reloadUserMcpServers([
          reg('a', 'file:/settings'),
          { ...reg('b', 'file:/settings'), ...override },
        ]);
        expect(mocks.connectToMcpServer).toHaveBeenCalledTimes(2);
      } finally {
        await manager.dispose();
      }
    },
  );

  it('starts independent servers in parallel', async () => {
    const releases: Array<() => void> = [];
    mocks.connectToMcpServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(createFakeClient()));
        }),
    );
    const { manager } = createManager();

    const registration = manager.registerMcpServers('s1', [
      reg('first'),
      reg('second'),
    ]);
    await vi.waitFor(() =>
      expect(mocks.connectToMcpServer).toHaveBeenCalledTimes(2),
    );
    for (const release of releases) release();
    await registration;

    await manager.dispose();
  });

  it('separates reused prewarmed connections from session-created ones', async () => {
    const { manager } = createManager();
    const warmed = reg('warmed');
    const cold = reg('cold');
    await manager.reloadUserMcpServers([warmed]);

    const stats = await manager.registerMcpServers('s1', [warmed, cold]);

    expect(stats).toEqual({
      serverCount: 2,
      newConnectionCount: 1,
      reusedConnectionCount: 1,
    });
    await manager.dispose();
  });

  it('reuses a prewarmed connection when the session adds its runtime scope tag', async () => {
    const { manager } = createManager();
    const warmed = reg('scoped');
    await manager.reloadUserMcpServers([warmed]);
    const connectsAfterPrewarm = mocks.connectToMcpServer.mock.calls.length;

    const stats = await manager.registerMcpServers('s1', [
      {
        ...warmed,
        config: { ...warmed.config, scope: 'user' },
      },
    ]);

    expect(stats).toEqual({
      serverCount: 1,
      newConnectionCount: 0,
      reusedConnectionCount: 1,
    });
    expect(mocks.connectToMcpServer).toHaveBeenCalledTimes(connectsAfterPrewarm);
    await manager.dispose();
  });

  it('prewarms without authentication and lets a session finish it', async () => {
    mocks.connectToMcpServer
      .mockRejectedValueOnce(new UnauthorizedError('needs auth'))
      .mockResolvedValue(createFakeClient());
    const { manager } = createManager();
    const registration = reg('auth-server');

    await manager.reloadUserMcpServers([registration]);
    const key = mcpServerKey('sdk', 'auth-server');
    expect(manager.getStatus(key)).toBe(MCPServerStatus.AUTH_REQUIRED);
    expect(mocks.connectToMcpServer.mock.calls[0][0].allowAuthentication).toBe(
      false,
    );

    await manager.registerMcpServers('s1', [registration]);
    expect(mocks.connectToMcpServer).toHaveBeenCalledTimes(2);
    expect(mocks.connectToMcpServer.mock.calls[1][0].allowAuthentication).toBe(
      true,
    );
    expect(manager.getStatus(key)).toBe(MCPServerStatus.CONNECTED);

    await manager.dispose();
  });

  it('shares one in-flight initialization across sessions', async () => {
    const fake = createFakeClient();
    let release!: () => void;
    mocks.connectToMcpServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(fake);
        }),
    );
    const { manager } = createManager();
    const key = mcpServerKey('sdk', 'shared');

    const first = manager.registerMcpServers('s1', [reg('shared')]);
    const second = manager.registerMcpServers('s2', [reg('shared')]);
    await vi.waitFor(() =>
      expect(mocks.connectToMcpServer).toHaveBeenCalledOnce(),
    );
    release();
    await Promise.all([first, second]);

    expect(mocks.connectToMcpServer).toHaveBeenCalledOnce();
    const client = manager.getClient(key);
    expect(client).toBeDefined();
    await manager.unregisterSession('s1');
    expect(manager.getClient(key)).toBe(client);
    await manager.unregisterSession('s2');
    expect(manager.getClient(key)).toBeUndefined();

    await manager.dispose();
  });

  it('prewarms user-level servers and keeps them pooled', async () => {
    const { manager } = createManager();
    await manager.reloadUserMcpServers([reg('user-server')]);

    const client = manager.getClient(mcpServerKey('sdk', 'user-server'));
    expect(client).toBeDefined();
    expect(client!.getStatus()).toBe(MCPServerStatus.CONNECTED);
    expect(client!.getDiscoveredTools()).toEqual([{ name: 't' }]);

    // A session registering the same key reuses the pooled connection.
    await manager.registerMcpServers('s1', [reg('user-server')]);
    expect(mocks.connectToMcpServer).toHaveBeenCalledOnce();
    expect(manager.getClient(mcpServerKey('sdk', 'user-server'))).toBe(client);

    // The session leaving does NOT tear down a user-level connection.
    await manager.unregisterSession('s1');
    expect(manager.getClient(mcpServerKey('sdk', 'user-server'))).toBe(client);
    await manager.dispose();
  });

  it('does not wait for the user prewarm during init', async () => {
    let release!: () => void;
    mocks.connectToMcpServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(createFakeClient());
        }),
    );
    const { manager } = createManager();

    await manager.init({ userServers: [reg('slow-user')] });
    await vi.waitFor(() =>
      expect(mocks.connectToMcpServer).toHaveBeenCalledOnce(),
    );
    let prewarmed = false;
    const prewarm = manager.whenPrewarmed().then(() => {
      prewarmed = true;
    });
    await Promise.resolve();
    expect(prewarmed).toBe(false);

    release();
    await prewarm;
    expect(
      manager.getStatus(mcpServerKey('sdk', 'slow-user')),
    ).toBe(MCPServerStatus.CONNECTED);
    await manager.dispose();
  });

  it('does not reconnect a queued session registration after the prewarm abort', async () => {
    const controller = new AbortController();
    let attempts = 0;
    mocks.connectToMcpServer.mockImplementation(
      (request: { signal?: AbortSignal }) => {
        attempts += 1;
        if (attempts === 1) {
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('aborted'), { name: 'AbortError' }),
                ),
              { once: true },
            );
          });
        }
        return Promise.resolve(createFakeClient());
      },
    );
    const { manager } = createManager();

    await manager.init({
      userServers: [reg('stopping')],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(attempts).toBe(1));

    const registration = manager.registerMcpServers('s1', [reg('stopping')]);
    controller.abort();
    const stats = await registration;

    expect(attempts).toBe(1);
    expect(stats.newConnectionCount).toBe(0);
    expect(manager.getStatus(mcpServerKey('sdk', 'stopping'))).toBe(
      MCPServerStatus.DISCONNECTED,
    );
    await manager.dispose();
  });

  it('waits only for the servers a session registers', async () => {
    const fake = createFakeClient();
    let releaseSlow!: () => void;
    mocks.connectToMcpServer
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSlow = () => resolve(createFakeClient());
          }),
      )
      .mockImplementation(async () => fake);
    const { manager } = createManager();

    await manager.init({ userServers: [reg('slow-user')] });
    await vi.waitFor(() =>
      expect(mocks.connectToMcpServer).toHaveBeenCalledOnce(),
    );
    await manager.registerMcpServers('s1', [reg('session-server')]);
    expect(
      manager.getStatus(mcpServerKey('sdk', 'session-server')),
    ).toBe(MCPServerStatus.CONNECTED);

    releaseSlow();
    await manager.whenPrewarmed();
    await manager.dispose();
  });

  it('replaces and removes changed user-level registrations', async () => {
    const { manager } = createManager();
    const key = mcpServerKey('sdk', 'user-server');
    const first = { key, config: stdioConfig, rootsDir: os.tmpdir() };
    const second = {
      key,
      config: { command: 'node', args: ['changed-user.js'] } as MCPServerConfig,
      rootsDir: os.tmpdir(),
    };

    await manager.reloadUserMcpServers([first]);
    const firstClient = manager.getClient(key);
    await manager.reloadUserMcpServers([second]);

    expect(manager.getClient(key)).not.toBe(firstClient);
    expect(manager.getClient(key)?.getServerConfig()).toEqual(second.config);
    await manager.reloadUserMcpServers([]);
    expect(manager.getClient(key)).toBeUndefined();
    await manager.dispose();
  });

  it('refcounts session servers and disconnects when the last session leaves', async () => {
    const { manager } = createManager();
    const key = mcpServerKey('session:s1', 'proj');
    await manager.registerMcpServers('s1', [
      { key, config: stdioConfig, rootsDir: os.tmpdir() },
    ]);
    const client = manager.getClient(key)!;
    expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);

    // A second session sharing the key bumps the refcount.
    await manager.registerMcpServers('s2', [
      { key, config: stdioConfig, rootsDir: os.tmpdir() },
    ]);
    expect(mocks.connectToMcpServer).toHaveBeenCalledOnce();

    await manager.unregisterSession('s1');
    expect(manager.getClient(key)).toBe(client); // s2 still holds it
    await manager.unregisterSession('s2');
    expect(manager.getClient(key)).toBeUndefined(); // last session gone
    await manager.dispose();
  });

  it('replaces a changed registration without duplicating a session reference', async () => {
    const { manager } = createManager();
    const key = mcpServerKey('session:s1', 'proj');
    const first = { key, config: stdioConfig, rootsDir: os.tmpdir() };
    const second = {
      key,
      config: { command: 'node', args: ['changed.js'] } as MCPServerConfig,
      rootsDir: os.tmpdir(),
    };

    await manager.registerMcpServers('s1', [first]);
    const firstClient = manager.getClient(key);
    await manager.registerMcpServers('s1', [second]);
    const secondClient = manager.getClient(key);

    expect(secondClient).not.toBe(firstClient);
    expect(secondClient?.getServerConfig()).toEqual(second.config);
    expect(mocks.connectToMcpServer).toHaveBeenCalledTimes(2);

    await manager.unregisterSession('s1');
    expect(manager.getClient(key)).toBeUndefined();
    await manager.dispose();
  });

  it('passes only the elicitation handler a registration supplies', async () => {
    const { manager } = createManager();
    const handler = { request: vi.fn(async () => ({ action: 'cancel' as const })) };
    await manager.registerMcpServers('s1', [
      { ...reg('dynamic', 'session:s1'), elicitationHandler: handler },
      {
        key: mcpServerKey('plugin:demo', 'plugin'),
        config: stdioConfig,
        rootsDir: os.tmpdir(),
      },
    ]);

    const byServer = new Map(
      mocks.connectToMcpServer.mock.calls.map((call) => [
        call[0].serverName,
        call[0].elicitationHandler,
      ]),
    );
    expect(byServer.get('dynamic')).toBe(handler);
    expect(byServer.get('plugin')).toBeUndefined();
    await manager.dispose();
  });

  it('keeps two same-named servers from different sources apart', async () => {
    const { manager } = createManager();
    const a = mcpServerKey('file:/home/u/.qwen/settings.json', 'docs');
    const b = mcpServerKey('file:/proj/.mcp.json', 'docs');
    await manager.registerMcpServers('s1', [
      { key: a, config: stdioConfig, rootsDir: os.tmpdir() },
      { key: b, config: stdioConfig, rootsDir: os.tmpdir() },
    ]);
    expect(mcpServerKeyId(a)).not.toBe(mcpServerKeyId(b));
    expect(manager.getClient(a)).not.toBe(manager.getClient(b));
    expect(mocks.connectToMcpServer).toHaveBeenCalledTimes(2);
    await manager.dispose();
  });
});

describe('McpManager auth parking', () => {
  it('parks a server that needs auth instead of failing, and skips discovery', async () => {
    mocks.connectToMcpServer.mockRejectedValue(
      new UnauthorizedError('needs auth'),
    );
    const { manager } = createManager();
    await manager.reloadUserMcpServers([reg('remote')]);

    const client = manager.getClient(mcpServerKey('sdk', 'remote'));
    expect(client).toBeDefined();
    expect(client!.getStatus()).toBe(MCPServerStatus.AUTH_REQUIRED);
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    await manager.dispose();
  });
});

describe('McpManager listeners and catalog access', () => {
  it('fans connection events out to listeners with the server key', async () => {
    const { manager } = createManager();
    const seen: Array<{ key: string; type: string }> = [];
    manager.addListener((key, event) => {
      seen.push({ key: key.name, type: event.type });
    });

    await manager.registerMcpServers('s1', [reg('srv', 'session:s1')]);

    expect(seen.some((e) => e.key === 'srv' && e.type === 'status')).toBe(true);
    expect(seen.some((e) => e.key === 'srv' && e.type === 'tools')).toBe(true);
    await manager.dispose();
  });

  it('aggregates a session catalog and routes prompt/resource reads', async () => {
    const { manager } = createManager();
    const key = mcpServerKey('session:s1', 'srv');
    await manager.registerMcpServers('s1', [
      { key, config: stdioConfig, rootsDir: os.tmpdir() },
    ]);

    expect(await manager.discoverTools('s1')).toEqual([{ name: 't' }]);
    expect(await manager.discoverPrompts('s1')).toEqual([]);
    expect(await manager.discoverResources('s1')).toEqual([]);

    await manager.getPrompt(key, 'p', { a: '1' });
    expect(mocks.invokeMcpPrompt).toHaveBeenCalledOnce();
    await manager.readResource(key, 'r://x');
    await manager.dispose();
  });

  it('reports DISCONNECTED for an unknown key and throws on direct read', async () => {
    const { manager } = createManager();
    expect(manager.getStatus(mcpServerKey('sdk', 'nope'))).toBe(
      MCPServerStatus.DISCONNECTED,
    );
    await expect(
      manager.readResource(mcpServerKey('sdk', 'nope'), 'r://x'),
    ).rejects.toThrow(/not in the pool/);
    await manager.dispose();
  });
});
