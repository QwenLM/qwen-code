/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpConfigVersion } from './userSettings.js';
import type { SettingsService } from '@qwen-code/resource';
import { DaemonMcpAuthorization } from './authorization.js';
import { DaemonMcpService } from './daemonMcpService.js';
import type { McpPoolDiff } from './poolSync.js';

// The service's own job is orchestration; the parts it composes are faked.
const order = vi.hoisted(() => [] as string[]);
const fakes = vi.hoisted(() => ({
  diff: undefined as unknown as McpPoolDiff,
  credentials: new Set<string>(),
}));

vi.mock('./writes.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createUserMcpServers: async () => {
    order.push('write');
    return { configVersion: 'v2', items: [] };
  },
  deleteUserMcpServer: async () => {
    order.push('write');
    return { configVersion: 'v2', deleted: 'a' };
  },
}));
vi.mock('./poolSync.js', () => ({
  UserPoolSync: class {
    async sync() {}
    async prepareReload() {
      return { diff: fakes.diff, applying: Promise.resolve() };
    }
    async waitForConnections(work: Promise<void>) { await work; }
  },
}));
vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MCPOAuthTokenStorage: class {
    async getCredentials(name: string) {
      return fakes.credentials.has(name) ? {} : null;
    }
    async getAllCredentials() {
      return new Map([...fakes.credentials].map((name) => [name, {}]));
    }
    async deleteCredentials(name: string) {
      order.push(`credentials:${name}`);
      fakes.credentials.delete(name);
    }
    async deleteInvalidToken(name: string) {
      order.push(`credentials:${name}`);
      fakes.credentials.delete(name);
      return true;
    }
    static forServer(_name: string, _config: unknown) {
      return new this();
    }
    static async deleteCredentialsByServerName(name: string) {
      order.push(`credentials:${name}`);
      fakes.credentials.delete(name);
    }
  },
}));

function setup(
  refreshSessions: () => Promise<unknown[]> = async () => {
    order.push('sessions');
    return [];
  },
  waitMs?: number,
) {
  const refresh = vi.fn(refreshSessions);
  const service = new DaemonMcpService(
    {
      getMcpManager: () => undefined,
      getSettingsService: () => ({ peekUserSettingsSource: () => undefined, resolve: () => ({ isUserSettingsLoadRejected: () => false, user: { originalSettings: { mcpServers: {} } } }) }) as unknown as SettingsService,
      startupUserServers: () => [],
      refreshSessions: refresh as never,
    },
    waitMs === undefined ? {} : { waitMs },
  );
  return { service, refresh };
}

const diff = (changed: string[]): McpPoolDiff => ({
  added: [],
  removed: [],
  changed,
  unchanged: [],
});

afterEach(() => {
  order.length = 0;
  fakes.credentials.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DaemonMcpService', () => {
  it('rejects project-level listing for now', async () => {
    const { service } = setup();

    await expect(service.list({ cwds: ['/repo'] })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('starts a session refresh after a write and returns the persisted batch', async () => {
    const { service, refresh } = setup();

    const result = await service.edit({
      mode: 'apply',
      expectedVersion: mcpConfigVersion({}),
      items: [{ op: 'create', configKey: 'a', config: { command: 'node' } }],
    });

    expect(refresh).toHaveBeenCalledWith({ plugins: false, serverNames: ['a'], enterprise: { targets: [], assertCurrent: expect.any(Function) } });
    expect(order).toEqual(['write', 'sessions']);
    expect(result).not.toHaveProperty('sessions');
    expect(result).not.toHaveProperty('sessionsSettled');
  });

  it('a failed session refresh does not fail the write', async () => {
    const { service } = setup(() => Promise.reject(new Error('boom')));

    await expect(
      service.edit({
        mode: 'apply',
        expectedVersion: mcpConfigVersion({}),
        items: [{ op: 'create', configKey: 'a', config: { command: 'node' } }],
      }),
    ).resolves.toMatchObject({ configVersion: 'v2' });
  });

  it('returns without waiting for the session refresh', async () => {
    const { service } = setup(() => new Promise(() => {}));

    await expect(
      service.edit({
        mode: 'apply',
        expectedVersion: mcpConfigVersion({}),
        items: [{ op: 'create', configKey: 'a', config: { command: 'node' } }],
      }),
    ).resolves.toMatchObject({ configVersion: 'v2' });
  });

  it('deletes config, then ends authorization, then credentials', async () => {
    fakes.credentials.add('a');
    vi.spyOn(
      DaemonMcpAuthorization.prototype,
      'settleUserServer',
    ).mockImplementation(async (configKey) => {
      order.push(`settle:${configKey}`);
    });
    const { service } = setup();

    const result = await service.edit({
      mode: 'apply',
      expectedVersion: mcpConfigVersion({}),
      items: [{ op: 'delete', serverId: 'user:a' }],
    });

    expect(order).toEqual(['write', 'settle:a', 'credentials:a', 'sessions']);
    expect(result).toMatchObject({
      mode: 'apply',
      configVersion: 'v2',
      results: [{ op: 'delete', deleted: 'a', credentialsDeleted: true }],
    });
    expect(result).not.toHaveProperty('sessions');
  });

  it('reloads session plugins only when a plugin server changed', async () => {
    const { service, refresh } = setup();

    fakes.diff = diff(['user:a']);
    await service.reload();
    fakes.diff = diff(['plugin:demo%40market:srv']);
    await service.reload();

    expect(refresh.mock.calls).toEqual([
      [{ plugins: false }],
      [{ plugins: true }],
    ]);
  });

  it('reports the sessions when they settle in time', async () => {
    const outcome = { sessionId: 's1', ok: true };
    const { service } = setup(async () => [outcome]);
    fakes.diff = diff([]);

    await expect(service.reload()).resolves.toMatchObject({
      sessions: [outcome],
      sessionsSettled: true,
    });
  });

  it('stops waiting for sessions after the bound', async () => {
    vi.useFakeTimers();
    const { service } = setup(() => new Promise(() => {}), 1_000);
    fakes.diff = diff([]);

    const reload = service.reload();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(reload).resolves.toMatchObject({
      sessions: [],
      sessionsSettled: false,
    });
  });
});
