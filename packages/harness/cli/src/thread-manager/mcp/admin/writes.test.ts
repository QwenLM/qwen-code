/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { LoadedSettings } from '../../../config/settings.js';
import type { DaemonMcpContext } from './context.js';
import { mcpConfigVersion } from './userSettings.js';
import {
  createUserMcpServers,
  deleteUserMcpServer,
  setUserMcpServerEnabled,
  updateUserMcpServer,
  validateUserMcpServers,
} from './writes.js';

/**
 * In-memory stand-in for the settings file: `mutateScope` runs the mutation on
 * a copy of "disk" and commits only when the editor changed something, like
 * the real locked transaction.
 */
function setup(initial: Record<string, unknown>) {
  let disk: Record<string, unknown> = { mcpServers: structuredClone(initial) };
  let writes = 0;
  const navigate = (root: Record<string, unknown>, path: string[]) => {
    let node: Record<string, unknown> = root;
    for (const segment of path.slice(0, -1)) {
      node[segment] ??= {};
      node = node[segment] as Record<string, unknown>;
    }
    return node;
  };
  const settings = {
    isUserSettingsLoadRejected: () => false,
    get user() {
      return {
        originalSettings: structuredClone(disk),
        settings: structuredClone(disk),
      };
    },
    mutateScope: (
      _scope: string,
      mutation: (editor: unknown) => void,
    ): boolean => {
      const latest = structuredClone(disk);
      let changed = false;
      mutation({
        get: (path: string[]) =>
          path.reduce<unknown>(
            (node, segment) =>
              (node as Record<string, unknown> | undefined)?.[segment],
            latest,
          ),
        set: (path: string[], value: unknown) => {
          navigate(latest, path)[path.at(-1)!] = structuredClone(value);
          changed = true;
          return true;
        },
        delete: (path: string[]) => {
          delete navigate(latest, path)[path.at(-1)!];
          changed = true;
          return true;
        },
      });
      if (changed) {
        disk = latest;
        writes += 1;
      }
      return true;
    },
  } as unknown as LoadedSettings;
  const syncPool = vi.fn(async () => {});
  const context: DaemonMcpContext = {
    getMcpManager: () => undefined,
    readUserSettings: () => settings,
    hasCredentials: async () => false,
    deleteCredentials: async () => false,
    deleteCredentialsIfToken: async () => {},
    userRegistrations: () => [],
    syncPool,
  };
  return {
    context,
    syncPool,
    servers: () => disk['mcpServers'] as Record<string, unknown>,
    version: () => mcpConfigVersion(disk['mcpServers']),
    writes: () => writes,
  };
}

const stdio = (command: string) => ({ command });

describe('validateUserMcpServers', () => {
  it('previews create, replace and update without writing', () => {
    const t = setup({ github: { url: 'https://example.com/github' } });

    const result = validateUserMcpServers(t.context, [
      { configKey: 'local', config: stdio('node'), intent: 'create' },
      {
        configKey: 'github',
        config: { url: 'https://example.com/v2' },
        intent: 'create',
      },
    ]);

    expect(result).toMatchObject({
      valid: true,
      configVersion: t.version(),
      items: [
        { configKey: 'local', ok: true, issues: [], preview: 'create' },
        { configKey: 'github', ok: true, issues: [], preview: 'replace' },
      ],
      confirmToken: expect.any(String),
    });
    expect(t.writes()).toBe(0);
  });

  it('issues no confirm token when nothing would be replaced', () => {
    const t = setup({});

    const result = validateUserMcpServers(t.context, [
      { configKey: 'local', config: stdio('node'), intent: 'create' },
    ]);

    expect(result.valid).toBe(true);
    expect(result.confirmToken).toBeUndefined();
  });

  it('reports per-item problems', () => {
    const t = setup({});

    const result = validateUserMcpServers(t.context, [
      { configKey: 'no-transport', config: {}, intent: 'create' },
      { configKey: 'bad-type', config: { command: 42 }, intent: 'create' },
      { configKey: ' padded', config: stdio('node'), intent: 'create' },
      { configKey: 'dup', config: stdio('node'), intent: 'create' },
      { configKey: 'dup', config: stdio('node'), intent: 'create' },
      { configKey: 'missing', config: stdio('node'), intent: 'update' },
      { configKey: 'sdk', config: { type: 'sdk' }, intent: 'create' },
    ]);

    expect(result.valid).toBe(false);
    expect(result.confirmToken).toBeUndefined();
    expect(
      result.items.map((item) => [
        item.configKey,
        item.ok,
        item.issues.length > 0,
      ]),
    ).toEqual([
      ['no-transport', false, true],
      ['bad-type', false, true],
      [' padded', false, true],
      ['dup', true, false],
      ['dup', false, true],
      ['missing', false, true],
      ['sdk', false, true],
    ]);
  });
});

describe('createUserMcpServers', () => {
  it('writes the whole batch and returns the new version', async () => {
    const t = setup({});
    const before = t.version();

    const result = await createUserMcpServers(t.context, {
      expectedVersion: before,
      items: [
        { configKey: 'a', config: stdio('a') },
        { configKey: 'b', config: { url: 'https://example.com/b' } },
      ],
    });

    expect(t.servers()).toEqual({
      a: stdio('a'),
      b: { url: 'https://example.com/b' },
    });
    expect(result).toEqual({
      configVersion: t.version(),
      items: [
        { configKey: 'a', serverId: 'user:a', action: 'created' },
        { configKey: 'b', serverId: 'user:b', action: 'created' },
      ],
    });
    expect(result.configVersion).not.toBe(before);
  });

  describe('replacing an existing entry', () => {
    const replacement = [
      { configKey: 'a', config: stdio('a2'), onConflict: 'replace' as const },
    ];

    function validated(t: ReturnType<typeof setup>, now = 1_000) {
      return validateUserMcpServers(
        t.context,
        [{ configKey: 'a', config: stdio('a2'), intent: 'create' }],
        () => now,
      );
    }

    it('needs a confirm token', async () => {
      const t = setup({ a: stdio('a') });

      await expect(
        createUserMcpServers(t.context, {
          expectedVersion: t.version(),
          items: replacement,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'CONFIRM_REQUIRED' }));
      expect(t.servers()).toEqual({ a: stdio('a') });
    });

    it('replaces with the token from validate', async () => {
      const t = setup({ a: stdio('a') });
      const { configVersion, confirmToken } = validated(t);

      const result = await createUserMcpServers(
        t.context,
        { expectedVersion: configVersion, items: replacement, confirmToken },
        () => 2_000,
      );

      expect(result.items).toEqual([
        { configKey: 'a', serverId: 'user:a', action: 'replaced' },
      ]);
      expect(t.servers()).toEqual({ a: stdio('a2') });
    });

    it.each([
      [
        'for different content',
        [
          {
            configKey: 'a',
            config: stdio('other'),
            onConflict: 'replace' as const,
          },
        ],
        2_000,
      ],
      ['after five minutes', replacement, 1_000 + 5 * 60 * 1000 + 1],
    ])('rejects a token %s', async (_label, items, now) => {
      const t = setup({ a: stdio('a') });
      const { configVersion, confirmToken } = validated(t);

      await expect(
        createUserMcpServers(
          t.context,
          { expectedVersion: configVersion, items, confirmToken },
          () => now,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'CONFIRM_EXPIRED' }));
      expect(t.servers()).toEqual({ a: stdio('a') });
    });

    it('rejects a token issued for another version', async () => {
      const t = setup({ a: stdio('a') });
      const { confirmToken } = validated(t);

      await expect(
        createUserMcpServers(
          t.context,
          {
            expectedVersion: mcpConfigVersion({ a: stdio('changed') }),
            items: replacement,
            confirmToken,
          },
          () => 2_000,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'CONFIRM_EXPIRED' }));
    });
  });
});

describe('updateUserMcpServer', () => {
  it('fixes an entry that does not load, addressed by config key', async () => {
    const t = setup({
      bad: { command: 'node', env: { K: 'v' }, timeout: 'oops' },
    });

    const result = await updateUserMcpServer(t.context, {
      configKey: 'bad',
      expectedVersion: t.version(),
      mode: 'merge',
      config: { timeout: 5000 },
    });

    expect(t.servers()).toEqual({
      bad: { command: 'node', env: { K: 'v' }, timeout: 5000 },
    });
    expect(result.serverId).toBe('user:bad');
  });

  it('replaces an entry written as a non-object; merge is refused', async () => {
    const t = setup({ text: 'not an object' });

    await expect(
      updateUserMcpServer(t.context, {
        configKey: 'text',
        expectedVersion: t.version(),
        mode: 'merge',
        config: { command: 'node' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

    await updateUserMcpServer(t.context, {
      configKey: 'text',
      expectedVersion: t.version(),
      mode: 'replace',
      config: { command: 'node' },
    });
    expect(t.servers()).toEqual({ text: { command: 'node' } });
  });

  it('replace swaps editable fields and keeps disabled', async () => {
    const t = setup({
      a: { command: 'old', args: ['--x'], env: { K: 'v' }, disabled: true },
    });

    await updateUserMcpServer(t.context, {
      serverId: 'user:a',
      expectedVersion: t.version(),
      mode: 'replace',
      config: { command: 'new' },
    });

    expect(t.servers()).toEqual({ a: { command: 'new', disabled: true } });
  });

  it('merge keeps other fields and replaces env as a whole', async () => {
    const t = setup({
      a: { command: 'node', args: ['--x'], env: { OLD: '1', KEEP: '2' } },
    });

    await updateUserMcpServer(t.context, {
      serverId: 'user:a',
      expectedVersion: t.version(),
      mode: 'merge',
      config: { env: { NEW: '3' } },
    });

    expect(t.servers()).toEqual({
      a: { command: 'node', args: ['--x'], env: { NEW: '3' } },
    });
  });

  it('rejects an update that would make the entry invalid', async () => {
    const t = setup({ a: stdio('node') });

    await expect(
      updateUserMcpServer(t.context, {
        serverId: 'user:a',
        expectedVersion: t.version(),
        mode: 'replace',
        config: {},
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(t.servers()).toEqual({ a: stdio('node') });
  });

  it.each([
    ['an unknown server', 'user:missing', 'NOT_FOUND'],
    ['a plugin server', 'plugin:linear%40market:linear', 'NOT_WRITABLE'],
    ['a stale version', 'user:a', 'VERSION_CONFLICT'],
  ])('rejects %s', async (_label, serverId, code) => {
    const t = setup({ a: stdio('node') });

    await expect(
      updateUserMcpServer(t.context, {
        serverId,
        expectedVersion:
          code === 'VERSION_CONFLICT' ? mcpConfigVersion({}) : t.version(),
        mode: 'merge',
        config: { args: ['--y'] },
      }),
    ).rejects.toThrow(expect.objectContaining({ code }));
    expect(t.writes()).toBe(0);
  });
});

describe('deleteUserMcpServer', () => {
  it('removes the entry', async () => {
    const t = setup({ a: stdio('a'), b: stdio('b') });

    const result = await deleteUserMcpServer(t.context, {
      serverId: 'user:a',
      expectedVersion: t.version(),
    });

    expect(t.servers()).toEqual({ b: stdio('b') });
    expect(result).toEqual({ configVersion: t.version(), deleted: 'a' });
  });

  it('can remove an entry that does not load, by config key', async () => {
    const t = setup({ broken: { command: 42 } });

    await deleteUserMcpServer(t.context, {
      configKey: 'broken',
      expectedVersion: t.version(),
    });

    expect(t.servers()).toEqual({});
  });

  it('touches nothing on a stale version or unknown server', async () => {
    const t = setup({ a: stdio('a') });

    await expect(
      deleteUserMcpServer(t.context, {
        serverId: 'user:a',
        expectedVersion: mcpConfigVersion({}),
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      deleteUserMcpServer(t.context, {
        serverId: 'user:missing',
        expectedVersion: t.version(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(t.servers()).toEqual({ a: stdio('a') });
  });
});

describe('setUserMcpServerEnabled', () => {
  it('writes only the disabled flag and reports the new state', async () => {
    const t = setup({ a: { command: 'node', args: ['--x'] } });

    const off = await setUserMcpServerEnabled(t.context, {
      serverId: 'user:a',
      enabled: false,
    });
    expect(t.servers()).toEqual({
      a: { command: 'node', args: ['--x'], disabled: true },
    });
    expect(off.server).toMatchObject({ enabled: false, status: 'disabled' });

    const on = await setUserMcpServerEnabled(t.context, {
      serverId: 'user:a',
      enabled: true,
      expectedVersion: off.configVersion,
    });
    expect(t.servers()).toEqual({ a: { command: 'node', args: ['--x'] } });
    expect(on.server).toMatchObject({ enabled: true });
  });

  it('checks the version only when one is given', async () => {
    const t = setup({ a: stdio('a') });

    await expect(
      setUserMcpServerEnabled(t.context, {
        serverId: 'user:a',
        enabled: false,
        expectedVersion: mcpConfigVersion({}),
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(t.writes()).toBe(0);
  });
});

describe('pool sync after writes', () => {
  it('syncs the pool once after each successful write', async () => {
    const t = setup({ a: stdio('a') });

    await createUserMcpServers(t.context, {
      expectedVersion: t.version(),
      items: [{ configKey: 'b', config: stdio('b') }],
    });
    await updateUserMcpServer(t.context, {
      serverId: 'user:b',
      expectedVersion: t.version(),
      mode: 'merge',
      config: { args: ['--x'] },
    });
    await setUserMcpServerEnabled(t.context, {
      serverId: 'user:a',
      enabled: false,
    });
    await deleteUserMcpServer(t.context, {
      serverId: 'user:b',
      expectedVersion: t.version(),
    });

    expect(t.syncPool).toHaveBeenCalledTimes(4);
  });

  it('replies only after the pool sync settles', async () => {
    const t = setup({});
    let finish!: () => void;
    t.syncPool.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    let replied = false;

    const write = createUserMcpServers(t.context, {
      expectedVersion: t.version(),
      items: [{ configKey: 'a', config: stdio('a') }],
    }).then(() => (replied = true));
    await vi.waitFor(() => expect(t.syncPool).toHaveBeenCalledTimes(1));
    expect(replied).toBe(false);

    finish();
    await write;
    expect(replied).toBe(true);
  });

  it('does not sync when nothing was written', async () => {
    const t = setup({ a: stdio('a') });

    await expect(
      createUserMcpServers(t.context, {
        expectedVersion: mcpConfigVersion({}),
        items: [{ configKey: 'b', config: stdio('b') }],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    await expect(
      createUserMcpServers(t.context, {
        expectedVersion: t.version(),
        items: [{ configKey: 'a', config: stdio('a2') }],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'ALREADY_EXISTS' }));

    expect(t.syncPool).not.toHaveBeenCalled();
  });
});
