/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PairingStore } from '@qwen-code/channel-base';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelSettingsSnapshot } from './channel-settings-store.js';
import {
  createChannelManagementService,
  type ChannelManagementWorkerManager,
} from './channel-management-service.js';

const WORKSPACE = '/ws/primary';

function settingsSnapshot(
  overrides: Partial<ChannelSettingsSnapshot> = {},
): ChannelSettingsSnapshot {
  return {
    revision: 'rev-1',
    channels: {
      bot: {
        type: 'dingtalk',
        clientId: 'client-id',
        clientSecret: '$BOT_SECRET',
        senderPolicy: 'open',
      },
    },
    startupNames: [],
    ...overrides,
  };
}

function setup(options: {
  snapshot?: ChannelSettingsSnapshot;
  committedNames?: string[];
  workspaceCwd?: string;
}) {
  let persisted = options.snapshot ?? settingsSnapshot();
  const store = {
    snapshot: vi.fn(() => persisted),
    upsert: vi.fn(async (name, request) => {
      const previous = persisted.channels[name] ?? {};
      const clientSecret =
        request.secrets?.clientSecret?.operation === 'clear'
          ? undefined
          : previous['clientSecret'];
      persisted = settingsSnapshot({
        revision: 'rev-2',
        channels: {
          ...persisted.channels,
          [name]: {
            ...request.config,
            ...(clientSecret === undefined ? {} : { clientSecret }),
          },
        },
        startupNames: persisted.startupNames,
      });
      return persisted;
    }),
    remove: vi.fn(async (name) => {
      const channels = { ...persisted.channels };
      delete channels[name];
      persisted = settingsSnapshot({
        revision: 'rev-2',
        channels,
        startupNames: persisted.startupNames.filter((item) => item !== name),
      });
      return persisted;
    }),
    setStartupNames: vi.fn(async (startupNames) => {
      persisted = settingsSnapshot({
        revision: 'rev-2',
        channels: persisted.channels,
        startupNames: [...startupNames],
      });
      return persisted;
    }),
  };
  let names = options.committedNames ?? [];
  const manager: ChannelManagementWorkerManager & {
    reload: ReturnType<typeof vi.fn>;
    reloadWorkspace: ReturnType<typeof vi.fn>;
    setChannelEnabled: ReturnType<typeof vi.fn>;
  } = {
    committedChannelNames: vi.fn(() => [...names]),
    state: vi.fn(() => ({
      enabled: names.length > 0,
      selection:
        names.length > 0 ? { mode: 'names' as const, names: [...names] } : null,
      transition: 'idle' as const,
      workers:
        names.length > 0
          ? [
              {
                enabled: true,
                state: 'running' as const,
                channels: [...names],
                requestedChannels: [...names],
                adapters: names.map((name) => ({
                  name,
                  state: 'connected' as const,
                })),
                workspaceId: 'primary',
                workspaceCwd: options.workspaceCwd ?? WORKSPACE,
                primary: true,
              },
            ]
          : [],
    })),
    setChannelEnabled: vi.fn(async ({ name }, enabled) => {
      names = enabled
        ? names.includes(name)
          ? names
          : [...names, name]
        : names.filter((item) => item !== name);
    }),
    reload: vi.fn(async () => ({
      enabled: true,
      state: 'running' as const,
      channels: [...names],
    })),
    reloadWorkspace: vi.fn(async () => ({
      enabled: true,
      state: 'running' as const,
      channels: [...names],
    })),
  };
  const service = createChannelManagementService({
    workspaceCwd: WORKSPACE,
    store,
    manager,
  });
  return { service, store, manager, persisted: () => persisted };
}

describe('createChannelManagementService', () => {
  it('lists sanitized config, secret presence, startup selection, and runtime', async () => {
    const { service } = setup({ committedNames: ['bot'] });

    const result = await service.list();

    expect(result.instances['bot']).toEqual({
      name: 'bot',
      config: {
        type: 'dingtalk',
        clientId: 'client-id',
        senderPolicy: 'open',
      },
      secrets: {
        clientSecret: { present: true, source: 'environment' },
      },
      startsWithServe: false,
      runtime: { state: 'connected' },
    });
  });

  it('projects the all startup sentinel onto configured instances', async () => {
    const { service } = setup({
      snapshot: settingsSnapshot({ startupNames: [' all '] }),
    });

    const result = await service.list();

    expect(result.instances['bot']?.startsWithServe).toBe(true);
  });

  it('does not expose config fields from an unmanaged channel type', async () => {
    const { service } = setup({
      snapshot: settingsSnapshot({
        channels: {
          legacy: {
            type: 'telegram',
            token: '$LEGACY_TOKEN',
            senderPolicy: 'open',
          },
        },
      }),
    });

    const result = await service.list();

    expect(result.instances['legacy']).toMatchObject({
      config: { type: 'telegram' },
      secrets: {},
    });
    expect(JSON.stringify(result.instances['legacy'])).not.toContain(
      'LEGACY_TOKEN',
    );
  });

  it('redacts credentials from adapter runtime errors', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    const state = manager.state();
    vi.mocked(manager.state).mockReturnValue({
      ...state,
      workers: state.workers.map((worker) => ({
        ...worker,
        adapters: [
          {
            name: 'bot',
            state: 'error' as const,
            error: 'connect failed clientSecret=top-secret',
          },
        ],
      })),
    });

    const result = await service.list();

    expect(result.instances['bot']?.runtime).toEqual({
      state: 'error',
      lastError: 'connect failed clientSecret=<redacted>',
    });
  });

  it('keeps a failed replacement config and reports the instance as error', async () => {
    const { service, store, manager, persisted } = setup({
      committedNames: ['other', 'bot'],
    });
    manager.reloadWorkspace.mockRejectedValueOnce(
      new Error('invalid token clientSecret=start-secret'),
    );

    const result = await service.upsert('bot', {
      expectedRevision: 'rev-1',
      config: {
        type: 'dingtalk',
        clientId: 'client-id',
        senderPolicy: 'pairing',
      },
      secrets: { clientSecret: { operation: 'clear' } },
    });

    expect(store.upsert).toHaveBeenCalledBefore(manager.reloadWorkspace);
    expect(persisted().channels['bot']).not.toHaveProperty('clientSecret');
    expect(manager.setChannelEnabled).toHaveBeenCalledWith(
      { name: 'bot', workspaceCwd: WORKSPACE },
      false,
    );
    expect(result.instance.runtime).toEqual({
      state: 'error',
      lastError: 'invalid token clientSecret=<redacted>',
    });
    expect(manager.reload).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('rejects a config whose effective cwd escapes the selected workspace', async () => {
    const { service, store, manager } = setup({ committedNames: [] });

    await expect(
      service.upsert('bot', {
        expectedRevision: 'rev-1',
        config: {
          type: 'dingtalk',
          cwd: '../secondary',
        },
      }),
    ).rejects.toMatchObject({ code: 'channel_workspace_mismatch' });

    expect(store.upsert).not.toHaveBeenCalled();
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
  });

  it('fails closed for lifecycle and pairing on a legacy cross-workspace config', async () => {
    const { service, store, manager } = setup({
      committedNames: ['bot'],
      snapshot: settingsSnapshot({
        channels: {
          bot: {
            type: 'dingtalk',
            cwd: '../secondary',
            senderPolicy: 'pairing',
          },
        },
      }),
    });

    await expect(service.start('bot')).rejects.toMatchObject({
      code: 'channel_workspace_mismatch',
    });
    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_workspace_mismatch',
    });
    await expect(
      service.setStartup('bot', {
        expectedRevision: 'rev-1',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'channel_workspace_mismatch' });
    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_workspace_mismatch',
    });
    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({ code: 'channel_workspace_mismatch' });
    await expect(service.pairingRequests('bot')).rejects.toMatchObject({
      code: 'channel_workspace_mismatch',
    });

    expect(store.setStartupNames).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('lists and approves pairing requests in the selected workspace scope', async () => {
    const previousQwenHome = process.env['QWEN_HOME'];
    const qwenHome = await fs.mkdtemp(
      path.join(os.tmpdir(), 'channel-management-pairing-'),
    );
    process.env['QWEN_HOME'] = qwenHome;
    try {
      const { service } = setup({
        snapshot: settingsSnapshot({
          channels: {
            bot: {
              type: 'dingtalk',
              senderPolicy: 'pairing',
            },
          },
        }),
      });
      const pairing = new PairingStore('bot', WORKSPACE);
      const code = pairing.createRequest('sender-1', 'Alice');
      expect(code).toBeTypeOf('string');

      await expect(service.pairingRequests('bot')).resolves.toEqual({
        requests: [
          expect.objectContaining({
            senderId: 'sender-1',
            senderName: 'Alice',
            code,
          }),
        ],
      });
      await expect(service.approvePairing('bot', code!)).resolves.toEqual({
        approved: expect.objectContaining({ senderId: 'sender-1', code }),
        requests: [],
      });
      expect(pairing.isApproved('sender-1')).toBe(true);
    } finally {
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      await fs.rm(qwenHome, { recursive: true, force: true });
    }
  });

  it('retains the reload diagnostic when stopping the failed replacement also fails', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    manager.reloadWorkspace.mockRejectedValueOnce(
      new Error('invalid token clientSecret=start-secret'),
    );
    manager.setChannelEnabled.mockRejectedValueOnce(
      new Error('stop failed clientSecret=stop-secret'),
    );

    const result = await service.upsert('bot', {
      expectedRevision: 'rev-1',
      config: {
        type: 'dingtalk',
        clientId: 'client-id',
        senderPolicy: 'pairing',
      },
    });

    expect(result.instance.runtime).toEqual({
      state: 'error',
      lastError: 'invalid token clientSecret=<redacted>',
    });
    expect(manager.setChannelEnabled).toHaveBeenCalledWith(
      { name: 'bot', workspaceCwd: WORKSPACE },
      false,
    );
  });

  it('clears a stale runtime diagnostic after a successful replacement', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    manager.reloadWorkspace.mockRejectedValueOnce(new Error('stale failure'));

    await expect(service.restart('bot')).rejects.toThrow('stale failure');
    expect((await service.list()).instances['bot']?.runtime).toEqual({
      state: 'error',
      lastError: 'stale failure',
    });

    const result = await service.upsert('bot', {
      expectedRevision: 'rev-1',
      config: {
        type: 'dingtalk',
        clientId: 'client-id',
        senderPolicy: 'pairing',
      },
    });

    expect(result.instance.runtime).toEqual({ state: 'connected' });
  });

  it('does not delete config when worker stop is unconfirmed', async () => {
    const { service, store, manager, persisted } = setup({
      committedNames: ['bot'],
    });
    vi.mocked(manager.setChannelEnabled).mockRejectedValueOnce(
      Object.assign(new Error('stop unconfirmed'), {
        code: 'channel_worker_stop_failed',
      }),
    );

    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({ code: 'channel_worker_stop_failed' });

    expect(store.remove).not.toHaveBeenCalled();
    expect(persisted().channels['bot']).toBeDefined();
  });

  it('rejects stale removal before changing runtime state', async () => {
    const { service, store, manager } = setup({ committedNames: ['bot'] });

    await expect(
      service.remove('bot', { expectedRevision: 'stale' }),
    ).rejects.toMatchObject({ code: 'channel_settings_conflict' });

    expect(store.remove).not.toHaveBeenCalled();
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
  });

  it('delegates starts and stops to the manager atomic mutation lane', async () => {
    const { service, store, manager } = setup({
      committedNames: ['first', 'second'],
      snapshot: settingsSnapshot({
        channels: {
          first: { type: 'dingtalk' },
          second: { type: 'dingtalk' },
          bot: { type: 'dingtalk' },
        },
      }),
    });

    await service.start('bot');
    expect(manager.setChannelEnabled).toHaveBeenNthCalledWith(
      1,
      { name: 'bot', workspaceCwd: WORKSPACE },
      true,
    );

    await service.stop('second');
    expect(manager.setChannelEnabled).toHaveBeenNthCalledWith(
      2,
      { name: 'second', workspaceCwd: WORKSPACE },
      false,
    );
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('updates persisted startup selection without mutating runtime state', async () => {
    const { service, store, manager } = setup({ committedNames: ['bot'] });

    const result = await service.setStartup('bot', {
      expectedRevision: 'rev-1',
      enabled: true,
    });

    expect(store.setStartupNames).toHaveBeenCalledWith(['bot'], {
      expectedRevision: 'rev-1',
    });
    expect(result.instance.startsWithServe).toBe(true);
    expect(result.instance.runtime.state).toBe('connected');
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('expands all to the other instances when disabling one startup', async () => {
    const { service, store } = setup({
      snapshot: settingsSnapshot({
        channels: {
          first: { type: 'dingtalk' },
          bot: { type: 'dingtalk' },
          last: { type: 'dingtalk' },
        },
        startupNames: [' all '],
      }),
    });

    const result = await service.setStartup('bot', {
      expectedRevision: 'rev-1',
      enabled: false,
    });

    expect(store.setStartupNames).toHaveBeenCalledWith(['first', 'last'], {
      expectedRevision: 'rev-1',
    });
    expect(result.instance.startsWithServe).toBe(false);
    expect(result.snapshot.instances['first']?.startsWithServe).toBe(true);
    expect(result.snapshot.instances['last']?.startsWithServe).toBe(true);
  });

  it.each(['all', ' all ', '\tall\n'])(
    'rejects reserved channel name %j before lifecycle mutation',
    async (name) => {
      const { service, store, manager } = setup({ committedNames: [] });

      await expect(
        service.remove(name, { expectedRevision: 'rev-1' }),
      ).rejects.toMatchObject({
        code: 'invalid_channel_instance_name',
      });
      await expect(service.start(name)).rejects.toMatchObject({
        code: 'invalid_channel_instance_name',
      });
      await expect(
        service.setStartup(name, {
          expectedRevision: 'rev-1',
          enabled: true,
        }),
      ).rejects.toMatchObject({ code: 'invalid_channel_instance_name' });

      expect(store.remove).not.toHaveBeenCalled();
      expect(store.setStartupNames).not.toHaveBeenCalled();
      expect(manager.committedChannelNames).not.toHaveBeenCalled();
      expect(manager.setChannelEnabled).not.toHaveBeenCalled();
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'rejects inherited instance name %s before start or stop reaches the manager',
    async (name) => {
      const { service, manager } = setup({ committedNames: [] });

      await expect(service.start(name)).rejects.toMatchObject({
        code: 'channel_instance_not_found',
      });
      await expect(service.stop(name)).rejects.toMatchObject({
        code: 'channel_instance_not_found',
      });

      expect(manager.committedChannelNames).not.toHaveBeenCalled();
      expect(manager.setChannelEnabled).not.toHaveBeenCalled();
    },
  );

  it('fails closed when an active instance belongs to another workspace', async () => {
    const { service, manager } = setup({
      committedNames: ['bot'],
      workspaceCwd: '/ws/secondary',
    });

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_runtime_owner_mismatch',
    });
    expect(manager.reload).not.toHaveBeenCalled();
  });

  it('rejects an inactive cross-workspace start before lifecycle mutation', async () => {
    const { service, manager } = setup({ committedNames: [] });
    vi.mocked(manager.setChannelEnabled).mockRejectedValueOnce(
      Object.assign(new Error('owner mismatch'), {
        code: 'channel_runtime_owner_mismatch',
      }),
    );

    await expect(service.start('bot')).rejects.toMatchObject({
      code: 'channel_runtime_owner_mismatch',
    });

    expect(manager.setChannelEnabled).toHaveBeenCalledWith(
      { name: 'bot', workspaceCwd: WORKSPACE },
      true,
    );
    expect(manager.reload).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('serializes lifecycle mutations for one workspace service', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    let finishReload!: () => void;
    manager.reloadWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = () =>
            resolve({
              enabled: true,
              state: 'running' as const,
              channels: ['bot'],
            });
        }),
    );

    const restarting = service.restart('bot');
    await vi.waitFor(() => {
      expect(manager.reloadWorkspace).toHaveBeenCalledOnce();
    });
    const stopping = service.stop('bot');

    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
    finishReload();
    await restarting;
    await stopping;
    expect(manager.setChannelEnabled).toHaveBeenCalledWith(
      { name: 'bot', workspaceCwd: WORKSPACE },
      false,
    );
  });
});
