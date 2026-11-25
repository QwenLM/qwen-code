/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pluginMcpRegistrations,
  type McpManager,
  type McpServerRegistration,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import { userMcpServerKey } from '../../../mcp/framework.js';
import { UserPoolSync } from './poolSync.js';

const collected = vi.hoisted(() => ({ next: [] as unknown[] | undefined }));
const caches = vi.hoisted(() => ({ cleared: 0 }));

vi.mock('../../../mcp/framework.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  collectDaemonUserMcpRegistrations: async () => collected.next,
}));
vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearAllPluginCaches: () => {
    caches.cleared += 1;
  },
}));

function setup(
  reloadUserMcpServers: () => Promise<unknown> = async () => [],
  options: {
    startup?: readonly McpServerRegistration[];
    waitMs?: number;
    rejected?: boolean;
  } = {},
) {
  const manager = { reloadUserMcpServers: vi.fn(reloadUserMcpServers) };
  const settings = {
    isUserSettingsLoadRejected: () => options.rejected === true,
  } as unknown as LoadedSettings;
  const pool = new UserPoolSync({
    getMcpManager: () => manager as unknown as McpManager,
    readUserSettings: () => settings,
    startupServers: () => options.startup ?? [],
    waitMs: options.waitMs ?? 10_000,
  });
  return { pool, manager };
}

const user = (name: string, command: string): McpServerRegistration => ({
  key: userMcpServerKey(name),
  config: { command },
  rootsDir: '/home/u/.qoder',
});
const plugin = (name: string, command = name): McpServerRegistration =>
  pluginMcpRegistrations(
    {
      id: 'demo@market',
      name: 'demo',
      path: '/p',
      mcpServers: { [name]: { command } },
    },
    '/p',
  )[0];

afterEach(() => {
  collected.next = [];
  vi.useRealTimers();
});

describe('UserPoolSync.sync', () => {
  it('resolves once the pool has followed the settings', async () => {
    let finish!: () => void;
    const { pool, manager } = setup(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    let settled = false;

    const sync = pool.sync().then(() => (settled = true));
    await vi.waitFor(() =>
      expect(manager.reloadUserMcpServers).toHaveBeenCalledTimes(1),
    );
    expect(settled).toBe(false);

    finish();
    await sync;
    expect(settled).toBe(true);
  });

  it('stops waiting after the bound while the sync carries on', async () => {
    vi.useFakeTimers();
    const { pool, manager } = setup(() => new Promise(() => {}), {
      waitMs: 1_000,
    });
    let settled = false;

    const sync = pool.sync().then(() => (settled = true));
    // vi.waitFor would advance the fake clock itself; step it by hand.
    await vi.advanceTimersByTimeAsync(999);
    expect(manager.reloadUserMcpServers).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await sync;
    expect(settled).toBe(true);
  });

  it('never rejects, and leaves the pool alone when settings are unreadable', async () => {
    const failing = setup(() => Promise.reject(new Error('boom')));
    await expect(failing.pool.sync()).resolves.toBeUndefined();

    const unreadable = setup(undefined, { rejected: true });
    await expect(unreadable.pool.sync()).resolves.toBeUndefined();
    expect(unreadable.manager.reloadUserMcpServers).not.toHaveBeenCalled();
  });
});

describe('UserPoolSync.reload', () => {
  it('reports the diff against what the pool was given at startup', async () => {
    const { pool, manager } = setup(undefined, {
      startup: [user('keep', 'a'), user('edit', 'old'), user('gone', 'b')],
    });
    collected.next = [
      user('keep', 'a'),
      user('edit', 'new'),
      user('fresh', 'c'),
      plugin('srv'),
    ];
    const cleared = caches.cleared;

    const diff = await pool.reload();

    expect(diff).toEqual({
      added: ['user:fresh', 'plugin:demo%40market:srv'],
      removed: ['user:gone'],
      changed: ['user:edit'],
      unchanged: ['user:keep'],
    });
    expect(manager.reloadUserMcpServers).toHaveBeenCalledWith(
      collected.next,
      undefined,
      expect.any(Set),
      expect.any(Set),
    );
    expect(caches.cleared).toBe(cleared + 1);
  });

  it('reports a plugin server whose config changed as changed, though its pool key is new', async () => {
    const { pool } = setup(undefined, { startup: [plugin('srv', 'v1')] });
    collected.next = [plugin('srv', 'v2')];

    await expect(pool.reload()).resolves.toEqual({
      added: [],
      removed: [],
      changed: ['plugin:demo%40market:srv'],
      unchanged: [],
    });
  });

  it('remembers what it gave the pool', async () => {
    const { pool } = setup(undefined, { startup: [user('a', 'a')] });
    expect(pool.registrations()).toEqual([user('a', 'a')]);

    collected.next = [user('b', 'b')];
    await pool.reload();

    expect(pool.registrations()).toEqual([user('b', 'b')]);
  });

  it('diffs the next reload against the previous sync, not startup', async () => {
    const { pool } = setup(undefined, { startup: [user('a', 'a')] });
    collected.next = [user('a', 'a'), user('b', 'b')];
    await pool.reload();

    collected.next = [user('b', 'b')];

    await expect(pool.reload()).resolves.toEqual({
      added: [],
      removed: ['user:a'],
      changed: [],
      unchanged: ['user:b'],
    });
  });

  it('fails without touching the pool when plugins cannot be loaded', async () => {
    const { pool, manager } = setup();
    collected.next = undefined;

    await expect(pool.reload()).rejects.toMatchObject({
      code: 'RELOAD_FAILED',
    });
    expect(manager.reloadUserMcpServers).not.toHaveBeenCalled();
  });

  it('fails clearly when the settings cannot be read', async () => {
    const { pool } = setup(undefined, { rejected: true });

    await expect(pool.reload()).rejects.toMatchObject({
      code: 'SETTINGS_UNREADABLE',
    });
  });
});

it('publishes later ownership without waiting for an earlier connection', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { pool, manager } = setup(() => blocked);
  collected.next = [user('a', 'v1')];
  const first = await pool.prepareReload();
  await vi.waitFor(() =>
    expect(manager.reloadUserMcpServers).toHaveBeenCalledTimes(1),
  );
  collected.next = [user('a', 'v2')];
  const second = await pool.prepareReload();
  expect(second.diff.changed).toEqual(['user:a']);
  expect(manager.reloadUserMcpServers).toHaveBeenCalledTimes(2);
  finish();
  await Promise.all([first.applying, second.applying]);
  expect(manager.reloadUserMcpServers).toHaveBeenCalledTimes(2);
  expect(manager.reloadUserMcpServers).toHaveBeenNthCalledWith(
    2,
    [user('a', 'v2')],
    undefined,
    expect.any(Set),
    expect.any(Set),
  );
});
