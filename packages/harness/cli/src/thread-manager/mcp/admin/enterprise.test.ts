/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import {
  Config,
  McpManager,
  McpSettingsGate,
  StdioMcpConnector,
  HttpMcpConnector,
  MCPServerStatus,
  type ManagedMcpResource,
  type ManagedResourcesProvider,
} from '@qwen-code/core';
import { SettingsService } from '@qwen-code/resource';
import { DaemonMcpService } from './daemonMcpService.js';
import { mcpConfigVersion } from './userSettings.js';
import { enterpriseServerId, enterpriseMcpError } from './enterprise.js';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const resource: ManagedMcpResource = {
  id: 'connector',
  sourceId: 'identity-connector',
  name: 'enterprise_docs',
  originalName: 'docs',
  displayName: 'Company docs',
  config: {
    command: 'node',
    args: ['server.js'],
    env: { SECRET: 'not-for-management' },
  },
  userVisible: true,
  userCanDisable: true,
  disabled: false,
};
const id = enterpriseServerId(resource);
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function setup(
  initial: readonly ManagedMcpResource[] = [resource],
  waitMs = 10,
  manager?: McpManager,
  ordinary = Boolean(manager),
) {
  const root = await mkdtemp(join(tmpdir(), 'enterprise-admin-'));
  roots.push(root);
  const path = join(root, '.qwen', 'settings.json');
  await mkdir(join(root, '.qwen'), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: ordinary ? { ordinary: { command: 'node' } } : {},
    }),
  );
  const pool =
    manager ??
    new McpManager({} as never, new Map(), 'test', false, {
      enableEnvironmentVariableRedaction: false,
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: [],
    });
  if (manager) {
    Object.assign(manager, {
      createManagementGate: () => new McpSettingsGate(),
    });
  }
  // Real settings loader and writes; only the product identity/cache boundary is supplied.
  const service = new SettingsService(undefined, { homeDir: root });
  let generation = 'identity:1';
  let current = initial;
  let read = async () => current;
  const provider: ManagedResourcesProvider = {
    getIdentityGeneration: () => generation,
    readSkills: async () => [],
    readMcpServers: () => read(),
    setSkillEnabled: async () => {},
    setMcpServerEnabled: async (target, enabled) => {
      current = current.map((entry) =>
        entry.name === target.name ? { ...entry, disabled: !enabled } : entry,
      );
    },
  };
  service.initialize({ userConfigDir: join(root, '.qwen') });
  const settings = service.resolve({ projectPath: root, sources: ['user'] });
  const refresh = vi.fn(async (_options: unknown) => []);
  const admin = new DaemonMcpService(
    {
      getMcpManager: () => pool,
      getSettingsService: () =>
        ({
          peekUserSettingsSource: () => undefined,
          resolve: () => settings,
        }) as never,
      getManagedResourcesProvider: async () => provider,
      refreshSessions: refresh,
    },
    { waitMs },
  );
  cleanups.push(async () => {
    admin.dispose();
    await pool.dispose?.();
  });
  return {
    pool,
    admin,
    root,
    settings,
    refresh,
    path,
    provider,
    set: (next: readonly ManagedMcpResource[]) => {
      current = next;
    },
    read: (next: () => Promise<readonly ManagedMcpResource[]>) => {
      read = next;
    },
    generation: (next: string) => {
      generation = next;
    },
  };
}

describe('enterprise daemon management', () => {
  it('lists silent resources read-only without a session and keeps their config private', async () => {
    const s = await setup([
      resource,
      { ...resource, name: 'hidden', userVisible: false },
      { ...resource, name: 'forced', userCanDisable: false },
    ]);
    const list = await s.admin.list();
    expect(list.servers.find((server) => server.serverId === id)).toMatchObject({
      serverId: id,
      source: 'enterprise',
      config: {},
      writable: false,
      displayName: 'Company docs',
      originalName: 'docs',
      canDisable: true,
      status: 'disconnected',
    });
    const silentId = 'enterprise:identity-connector:hidden';
    const silent = {
      serverId: silentId,
      config: {},
      enabled: true,
      canDisable: false,
      writable: false,
    };
    expect(list.servers).toContainEqual(expect.objectContaining(silent));
    expect(list.servers).toContainEqual(
      expect.objectContaining({ configKey: 'forced', canDisable: false }),
    );
    expect(await s.admin.getServer(id)).toMatchObject({
      info: null,
      tools: [],
      server: { serverId: id },
    });
    expect((await s.admin.getServer(silentId)).server).toMatchObject(silent);
    await expect(
      s.admin.edit({
        mode: 'apply',
        items: [{ op: 'set_enabled', serverId: silentId, enabled: false }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.refresh).not.toHaveBeenCalled();
    await expect(s.admin.callTool(id, 'search', {})).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(
      s.admin.auth({ action: 'cancel', serverId: id }),
    ).resolves.toMatchObject({ cancelled: false });
  });

  it('does not advance the reload baseline on list/get, and observes withdrawal', async () => {
    const s = await setup();
    await s.admin.list();
    await s.admin.getServer(id);
    expect((await s.admin.reload({ serverIds: [id] })).added).toEqual([id]);
    s.set([{ ...resource, config: { command: 'updated' } }]);
    await s.admin.list();
    expect((await s.admin.reload({ serverIds: [id] })).changed).toEqual([id]);
    s.set([]);
    const withdrawn = await s.admin.reload({ serverIds: [id] });
    expect(withdrawn.removed).toEqual([id]);
    expect(s.refresh.mock.lastCall?.[0]).toMatchObject({
      enterprise: { targets: [{ name: resource.name, originalName: 'docs' }] },
    });
    await expect(s.admin.reload({ serverIds: [id] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('allows versionless toggles, keeps user version and returns disabled summary', async () => {
    const s = await setup();
    const before = await s.admin.list();
    const result = await s.admin.edit({
      mode: 'apply',
      items: [{ op: 'set_enabled', serverId: id, enabled: false }],
    });
    expect(result).toMatchObject({
      configVersion: before.configVersion,
      results: [{ server: { enabled: false, status: 'disabled' } }],
      sessionsSettled: true,
    });
    expect((await s.admin.reload({ serverIds: [id] })).unchanged).toEqual([id]);
  });

  it.each([false, true])(
    'rejects both enable values for locked/admin-disabled resources: %s',
    async (enabled) => {
      for (const entry of [
        { ...resource, userCanDisable: false },
        { ...resource, config: { ...resource.config, disabled: true } },
      ]) {
        const s = await setup([entry]);
        await expect(
          s.admin.edit({
            mode: 'apply',
            items: [{ op: 'set_enabled', serverId: id, enabled }],
          }),
        ).rejects.toMatchObject({ code: 'NOT_WRITABLE' });
      }
    },
  );

  it.each([id, 'user:ordinary'])(
    'rejects versionless mixed-operation batches before any write: %s',
    async (serverId) => {
      const s = await setup();
      const setter = vi.spyOn(s.provider, 'setMcpServerEnabled');
      const before = await readFile(s.path, 'utf8');
      await expect(
        s.admin.edit({
          mode: 'apply',
          items: [
            { op: 'set_enabled', serverId, enabled: false },
            { op: 'create', configKey: 'new', config: { command: 'node' } },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(setter).not.toHaveBeenCalled();
      expect(await readFile(s.path, 'utf8')).toBe(before);
    },
  );

  it('rejects stale explicit versions before an enterprise preference is changed', async () => {
    const s = await setup();
    const setter = vi.spyOn(s.provider, 'setMcpServerEnabled');
    await expect(
      s.admin.edit({
        mode: 'apply',
        expectedVersion: 'stale',
        items: [{ op: 'set_enabled', serverId: id, enabled: false }],
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(setter).not.toHaveBeenCalled();
  });

  it('refreshes successful earlier toggles even when a later item fails', async () => {
    const s = await setup();
    await expect(
      s.admin.edit({
        mode: 'apply',
        items: [
          { op: 'set_enabled', serverId: id, enabled: false },
          {
            op: 'set_enabled',
            serverId: 'enterprise:missing:name',
            enabled: false,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.refresh).toHaveBeenCalledOnce();
    expect((await s.admin.getServer(id)).server?.enabled).toBe(false);
  });

  it('rejects in-flight old identity reads, including same-account new login generations', async () => {
    const s = await setup();
    const entered = barrier();
    const blocked = barrier();
    s.read(async () => {
      entered.release();
      await blocked.promise;
      return [resource];
    });
    const read = s.admin.list();
    await entered.promise;
    s.generation('identity:2');
    blocked.release();
    await expect(read).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });

  it('serializes same-identity reload reads and commits before bounded session waits', async () => {
    const s = await setup();
    const entered = barrier();
    const blocked = barrier();
    const sessions = barrier();
    let count = 0;
    s.read(async () => {
      count++;
      if (count === 1) {
        entered.release();
        await blocked.promise;
        return [resource];
      }
      return [{ ...resource, config: { command: 'v2' } }];
    });
    s.refresh.mockImplementation(async () => {
      await sessions.promise;
      return [];
    });
    const first = s.admin.reload({ serverIds: [id] });
    await entered.promise;
    const second = s.admin.reload({ serverIds: [id] });
    await Promise.resolve();
    expect(count).toBe(1);
    blocked.release();
    expect(await first).toMatchObject({ added: [id], sessionsSettled: false });
    expect(await second).toMatchObject({
      changed: [id],
      sessionsSettled: false,
    });
    sessions.release();
    expect((await s.admin.reload({ serverIds: [id] })).unchanged).toEqual([id]);
  });

  it('maps lock contention only to BUSY', async () => {
    const s = await setup();
    vi.spyOn(s.provider, 'setMcpServerEnabled')
      .mockRejectedValueOnce(
        new Error('locked', { cause: { code: 'ELOCKED' } }),
      )
      .mockRejectedValueOnce(new Error('disk failure'));
    const input = {
      mode: 'apply' as const,
      items: [{ op: 'set_enabled' as const, serverId: id, enabled: false }],
    };
    await expect(s.admin.edit(input)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(s.admin.edit(input)).rejects.toThrow('disk failure');
  });
});

it('rejects enterprise configuration edits and keeps silent targets out of write operations', async () => {
  const s = await setup();
  await expect(
    s.admin.edit({ mode: 'apply', items: [{ op: 'delete', serverId: id }] }),
  ).rejects.toMatchObject({ code: 'NOT_WRITABLE' });
  await expect(
    s.admin.edit({
      mode: 'validate',
      items: [{ op: 'update', serverId: id, mode: 'replace', config: {} }],
    }),
  ).rejects.toMatchObject({ code: 'NOT_WRITABLE' });
  s.set([{ ...resource, userVisible: false }]);
  await expect(
    s.admin.edit({ mode: 'apply', items: [{ op: 'delete', serverId: id }] }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it.each(['list', 'get', 'reload'] as const)(
  'maps migration lock failures from %s to BUSY, preserving non-lock errors',
  async (operation) => {
    const s = await setup();
    const run = () =>
      operation === 'list'
        ? s.admin.list()
        : operation === 'get'
          ? s.admin.getServer(id)
          : s.admin.reload({ serverIds: [id] });
    s.read(async () => {
      throw new Error('migration lock', { cause: { code: 'ELOCKED' } });
    });
    await expect(run()).rejects.toMatchObject({ code: 'BUSY' });
    s.read(async () => {
      throw new Error('invalid JSON');
    });
    await expect(run()).rejects.toThrow('invalid JSON');
  },
);

it('mixed ordinary and enterprise edits refresh A without advancing independent B', async () => {
  const manager = {
    getClient: () => undefined,
    reloadUserMcpServers: vi.fn(async () => {}),
  } as unknown as McpManager;
  const b = {
    ...resource,
    id: 'b',
    name: 'enterprise_b',
    sourceId: 'identity-b',
    originalName: 'search',
  };
  const s = await setup([resource, b], 10, manager);
  const config = new Config({
    cwd: s.root,
    targetDir: s.root,
    sessionId: 'mixed',
    debugMode: false,
    model: '',
    embeddingModel: '',
    loadedSettings: s.settings,
    managedResourcesProvider: s.provider,
  });
  try {
    await config.reloadManagedMcpServers();
    s.set([resource, { ...b, config: { command: 'v2' } }]);
    s.refresh.mockImplementation(async (options) => {
      const input = options as {
        serverNames: string[];
        enterprise: { targets: Array<typeof resource>; assertCurrent: () => void };
      };
      expect(input.serverNames).toEqual(['ordinary']);
      expect(input.enterprise.targets).toBeDefined();
      await config.reloadManagedMcpServers({
        serverNames: input.serverNames,
        managedTargets: input.enterprise.targets,
        assertCurrent: input.enterprise.assertCurrent,
      });
      return [];
    });
    await s.admin.edit({
      mode: 'apply',
      items: [
        { op: 'set_enabled', serverId: 'user:ordinary', enabled: false },
        { op: 'set_enabled', serverId: id, enabled: false },
      ],
    });
    expect(config.getManagedMcpServer(resource.name)?.disabled).toBe(true);
    expect(config.getManagedMcpServer(b.name)).toBe(b);
    expect(
      JSON.parse(await readFile(s.path, 'utf8')).mcpServers.ordinary.disabled,
    ).toBe(true);
  } finally {
    await config.dispose();
  }
});

it.each(['reload', 'edit'] as const)(
  'does not hold enterprise coordination behind ordinary %s connections',
  async (operation) => {
    const connected = barrier();
    const entered = barrier();
    const manager = {
      getClient: () => undefined,
      reloadUserMcpServers: vi.fn(
        async (_servers, _signal, _wait, connectOnly) => {
          if (connectOnly?.size === 0) return;
          entered.release();
          await connected.promise;
        },
      ),
    } as unknown as McpManager;
    const s = await setup([resource], 10_000, manager);
    let ordinarySettled = false;
    const ordinary = (
      operation === 'reload'
        ? s.admin.reload({ serverIds: ['user:ordinary'] })
        : s.admin.edit({
            mode: 'apply',
            items: [
              { op: 'set_enabled', serverId: 'user:ordinary', enabled: true },
            ],
          })
    ).finally(() => {
      ordinarySettled = true;
    });
    try {
      await entered.promise;
      const enterprise = s.admin.edit({
        mode: 'apply',
        items: [{ op: 'set_enabled', serverId: id, enabled: false }],
      });
      await vi.waitFor(() => expect(s.refresh).toHaveBeenCalledTimes(2));
      await enterprise;
      expect(ordinarySettled).toBe(false);
      expect((await s.admin.getServer(id)).server?.enabled).toBe(false);
    } finally {
      connected.release();
      await ordinary;
    }
  },
);

it('refreshes a newly created ordinary name through the verified internal path without widening enterprise targets', async () => {
  const manager = { getClient: () => undefined, reloadUserMcpServers: vi.fn(async () => {}) } as unknown as McpManager;
  const s = await setup([resource], 10, manager);
  await s.admin.edit({ mode: 'apply', expectedVersion: mcpConfigVersion({ ordinary: { command: 'node' } }), items: [
    { op: 'create', configKey: 'new-server', config: { command: 'node' } },
  ] });
  expect(s.refresh).toHaveBeenCalledWith({ plugins: false, serverNames: ['new-server'], enterprise: { targets: [], assertCurrent: expect.any(Function) } });
  expect(JSON.parse(await readFile(s.path, 'utf8')).mcpServers['new-server']).toEqual({ command: 'node' });
});


it('runs an enterprise management connection, reports tools/events and keeps sessions separate', async () => {
  const pool = new McpManager(
    {} as never,
    new Map([['stdio', new StdioMcpConnector()]]),
    'test',
    false,
    {
      enableEnvironmentVariableRedaction: false,
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: [],
    },
  );
  const s = await setup([], 1000, pool, false);
  const fixture = join(s.root, 'mcp.cjs');
  await writeFile(
    fixture,
    String.raw`const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line);
 if (request.id === undefined) return;
 if (request.method === 'tools/list' && process.env.FAIL_TOOLS) {
   process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Authorization: Bearer secret' } }) + '\n'); return;
 }
 const result = request.method === 'initialize'
  ? { protocolVersion: '2025-03-26', serverInfo: { name: 'enterprise-fixture', version: '1' }, capabilities: { tools: {} } }
  : request.method === 'tools/list'
    ? { tools: [{ name: 'hello', description: process.cwd(), inputSchema: { type: 'object' } }] }
    : {};
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});`,
  );
  const a = {
    ...resource,
    rootsDir: s.root,
    config: { command: process.execPath, args: [fixture] },
  };
  s.set([{ ...a, userVisible: false }]);
  const events: string[] = [];
  const stop = s.admin.onEvent((event) => {
    events.push(`${event.serverId}:${event.kind}`);
  });
  await vi.waitFor(
    async () =>
      expect((await s.admin.getServer(id)).server?.status).toBe(
        MCPServerStatus.CONNECTED,
      ),
    { timeout: 5000 },
  );
  const detail = await s.admin.getServer(id);
  expect(detail.info).not.toBeNull();
  expect(detail.tools).toHaveLength(1);
  expect(detail.tools[0]?.description).toBe(await realpath(s.root));
  expect(events).toContain(`${id}:status`);
  expect(events).toContain(`${id}:tools`);
  const registration = pool.getUserRegistrations()[0]!;
  expect(registration.key.source).toMatch(/^managed-admin:/);
  const sessionKey = { source: 'managed:session:v1' as const, name: a.name };
  await pool.registerMcpServers(
    'chat',
    [{ ...registration, key: sessionKey }],
    false,
  );
  expect(pool.getClient(sessionKey)).not.toBe(pool.getClient(registration.key));
  s.set([a]);
  await s.admin.edit({
    mode: 'apply',
    items: [{ op: 'set_enabled', serverId: id, enabled: false }],
  });
  expect((await s.admin.getServer(id)).server?.status).toBe('disabled');
  expect(pool.getClient(registration.key)).toBeUndefined();
  expect(pool.getClient(sessionKey)?.getStatus()).toBe('connected');
  await s.admin.edit({
    mode: 'apply',
    items: [{ op: 'set_enabled', serverId: id, enabled: true }],
  });
  await vi.waitFor(async () =>
    expect((await s.admin.getServer(id)).server?.status).toBe('connected'),
  );
  await s.admin.reconnect(id);
  expect((await s.admin.getServer(id)).server?.status).toBe('connected');
  s.set([{ ...a, config: { ...a.config, env: { FAIL_TOOLS: '1' } } }]);
  await s.admin.reload({ serverIds: [id] });
  await expect(s.admin.getServer(id)).rejects.toMatchObject({
    code: 'DISCOVERY_FAILED',
  });
  await expect(s.admin.getServer(id)).rejects.not.toThrow('secret');
  s.set([
    { ...a, config: { command: join(s.root, 'missing-secret-command') } },
  ]);
  await s.admin.reload({ serverIds: [id] });
  const failed = (await s.admin.getServer(id)).server!;
  expect(failed.status).toBe('disconnected');
  expect(failed.error).toBeTruthy();
  expect(failed.error).not.toContain('secret');
  s.set([]);
  await s.admin.reload({ serverIds: [id] });
  expect(pool.getClient(registration.key)).toBeUndefined();
  await expect(s.admin.getServer(id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  stop();
});

it('shows forced items as blocked and prevents reconnect or execution from bypassing policy', async () => {
  const s = await setup([{ ...resource, userCanDisable: false }]);
  s.settings.user.settings.mcp = { excluded: ['docs'] };
  const list = await s.admin.list();
  expect(list.servers[0]).toMatchObject({
    enabled: true,
    canDisable: false,
    status: 'blocked',
  });
  expect(s.pool.getUserRegistrations()).toEqual([]);
  await expect(s.admin.reconnect(id)).rejects.toMatchObject({
    code: 'NOT_WRITABLE',
  });
  await expect(s.admin.listResources(id)).rejects.toMatchObject({
    code: 'UNSUPPORTED',
  });
  await expect(
    s.admin.readResource(id, 'secret://resource'),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
});

it('keeps non-target B on its committed version and invalidates old identity before a targeted reload', async () => {
  const b = {
    ...resource,
    name: 'enterprise_b',
    originalName: 'search',
    sourceId: 'identity-b',
  };
  const s = await setup([resource, b]);
  await s.admin.list();
  const before = s.pool
    .getUserRegistrations()
    .find((r) => r.key.name === b.name);
  s.set([
    { ...resource, config: { command: 'new-a' } },
    { ...b, config: { command: 'new-b' } },
  ]);
  await s.admin.reload({ serverIds: [id] });
  expect(
    s.pool.getUserRegistrations().find((r) => r.key.name === b.name),
  ).toEqual(before);
  s.generation('new-user');
  s.set([{ ...resource, sourceId: 'new-identity-a' }]);
  await s.admin.reload({
    serverIds: [
      enterpriseServerId({ ...resource, sourceId: 'new-identity-a' }),
    ],
  });
  expect(s.pool.getUserRegistrations().some((r) => r.key.name === b.name)).toBe(
    false,
  );
});

it.each([
  new Error(
    'https://user:pass@host/mcp?token=secret#code Authorization: Bearer secret Cookie: secret CLIENT_SECRET=secret',
  ),
  Object.assign(new Error('stderr token=secret'), {
    code: 'ECONNREFUSED',
    cause: { access_token: 'secret' },
  }),
  { code: 'SECRET_CUSTOM_CODE', body: 'client_secret=secret', stack: 'secret' },
])('exposes only controlled enterprise connection errors', (error) => {
  expect(enterpriseMcpError(error)).not.toMatch(
    /secret|pass@|Authorization:|Cookie:|SECRET_CUSTOM_CODE/,
  );
});

it('immediately releases connections when governance changes and stops its single gate on dispose', async () => {
  const s = await setup();
  let allowed = true;
  let changed!: () => void;
  const stop = vi.fn();
  const create = vi.spyOn(s.pool, 'createManagementGate').mockReturnValue({
    evaluate: () =>
      allowed ? { allowed: true } : { allowed: false, reason: 'enterprise' },
    initialize: async () => {},
    start: (callback) => {
      changed = callback;
    },
    stop,
  });
  await s.admin.list();
  await s.admin.list();
  expect(create).toHaveBeenCalledOnce();
  expect(s.pool.getUserRegistrations()).toHaveLength(1);
  allowed = false;
  changed();
  expect(s.pool.getUserRegistrations()).toHaveLength(0);
  await vi.waitFor(async () =>
    expect((await s.admin.list()).servers[0]?.status).toBe('blocked'),
  );
  s.admin.dispose();
  expect(stop).toHaveBeenCalledOnce();
});

it('parks a real HTTP OAuth challenge as auth_required without a chat session', async () => {
  const http = createServer((_request, response) => {
    response.writeHead(401, {
      'WWW-Authenticate': 'Bearer realm="local-fixture"',
    });
    response.end('authorization required');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as { port: number };
  const pool = new McpManager(
    {} as never,
    new Map([['http', new HttpMcpConnector()]]),
    'test',
    false,
    {
      enableEnvironmentVariableRedaction: false,
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: [],
    },
  );
  const remote = {
    ...resource,
    config: {
      type: 'http' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
    },
  };
  const s = await setup([remote], 1000, pool, false);
  try {
    await s.admin.list();
    await vi.waitFor(
      async () =>
        expect((await s.admin.getServer(id)).server?.status).toBe(
          'auth_required',
        ),
      { timeout: 5000 },
    );
    expect((await s.admin.getServer(id)).tools).toEqual([]);
  } finally {
    s.admin.dispose();
    await pool.dispose();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

it('reclaims a withdrawn target initialized only by list, before the first reload baseline', async () => {
  const s = await setup();
  await s.admin.list();
  expect(s.pool.getUserRegistrations()).toHaveLength(1);
  s.set([]);
  await s.admin.reload({ serverIds: [id] });
  expect(s.pool.getUserRegistrations()).toHaveLength(0);
  expect((await s.admin.list()).servers).toEqual([]);
});

it('automatic Connector updates connect only changed A and leave failed B untouched', async () => {
  const a = { ...resource, name: 'enterprise_a' };
  const b = { ...resource, name: 'enterprise_b' };
  const s = await setup([a, b]);
  let changed!: () => void;
  s.provider.subscribeMcpChanges = (listener) => {
    changed = listener;
    return () => {};
  };
  await s.admin.list();
  const previous = s.pool
    .getUserRegistrations()
    .find((r) => r.key.name === b.name)!;
  const reload = vi.spyOn(s.pool, 'reloadUserMcpServers');
  s.set([{ ...a, config: { command: 'new-command' } }, b]);
  changed();
  await vi.waitFor(() =>
    expect(
      s.pool.getUserRegistrations().find((r) => r.key.name === a.name)?.config
        .command,
    ).toBe('new-command'),
  );
  expect(
    s.pool.getUserRegistrations().find((r) => r.key.name === b.name),
  ).toEqual(previous);
  // Check through the production key encoder, not the display name.
  const { mcpServerKeyId } = await import('@qwen-code/core');
  expect(
    reload.mock.calls.some((call) =>
      call[3]?.has(mcpServerKeyId(previous.key)),
    ),
  ).toBe(false);
  expect(
    reload.mock.calls.some((call) => [...(call[3] ?? [])].length === 1),
  ).toBe(true);
});
