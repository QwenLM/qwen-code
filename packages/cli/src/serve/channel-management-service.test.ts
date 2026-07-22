/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairingStore } from '@qwen-code/channel-base';
import { describe, expect, it, vi } from 'vitest';
import {
  isAllChannelSelectionName,
  normalizeServeChannelSelection,
} from './channel-selection.js';
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
        type: 'telegram',
        token: '$BOT_TOKEN',
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
  serviceWorkspaceCwd?: string;
}) {
  let persisted = options.snapshot ?? settingsSnapshot();
  const store = {
    snapshot: vi.fn(() => persisted),
    upsert: vi.fn(async (name, request) => {
      if (request.expectedRevision !== persisted.revision) {
        throw Object.assign(new Error('stale'), {
          code: 'channel_settings_conflict',
        });
      }
      const previous = persisted.channels[name] ?? {};
      const token =
        request.secrets?.token?.operation === 'clear'
          ? undefined
          : previous['token'];
      persisted = settingsSnapshot({
        revision: 'rev-2',
        channels: {
          ...persisted.channels,
          [name]: {
            ...request.config,
            ...(token === undefined ? {} : { token }),
          },
        },
        startupNames: persisted.startupNames,
      });
      return persisted;
    }),
    remove: vi.fn(async (name, request) => {
      if (request.expectedRevision !== persisted.revision) {
        throw Object.assign(new Error('stale'), {
          code: 'channel_settings_conflict',
        });
      }
      const channels = { ...persisted.channels };
      delete channels[name];
      const hasAllSentinel = persisted.startupNames.some(
        isAllChannelSelectionName,
      );
      persisted = settingsSnapshot({
        revision: 'rev-2',
        channels,
        startupNames: hasAllSentinel
          ? Object.keys(channels).some(
              (channelName) => !isAllChannelSelectionName(channelName),
            )
            ? ['all']
            : []
          : persisted.startupNames.filter((item) => item !== name),
      });
      return persisted;
    }),
    setStartupNames: vi.fn(async (startupNames, request) => {
      if (request.expectedRevision !== persisted.revision) {
        throw Object.assign(new Error('stale'), {
          code: 'channel_settings_conflict',
        });
      }
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
    reloadWorkspace: ReturnType<typeof vi.fn>;
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
    setSelection: vi.fn(async (selection) => {
      names = [...selection.names];
    }),
    stopSelection: vi.fn(async () => {
      names = [];
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
    workspaceCwd: options.serviceWorkspaceCwd ?? WORKSPACE,
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
      config: { type: 'telegram', senderPolicy: 'open' },
      secrets: { token: { present: true, source: 'environment' } },
      webhookSecrets: {},
      startsWithServe: false,
      runtime: { state: 'connected' },
    });
  });

  it('deeply redacts webhook literals and QQ app secrets from snapshots', async () => {
    const webhookSecret = 'webhook-literal-sentinel';
    const qqSecret = 'qq-app-secret-sentinel';
    const { service } = setup({
      snapshot: settingsSnapshot({
        channels: {
          bot: {
            type: 'dingtalk',
            webhooks: {
              sources: {
                github: {
                  secret: webhookSecret,
                  targets: { main: { chatId: 'chat-1' } },
                },
                ci: { secretEnv: 'CI_WEBHOOK_SECRET', targets: {} },
              },
            },
          },
          qq: { type: 'qq', appID: 'app-id', appSecret: qqSecret },
        },
      }),
    });

    const snapshot = await service.list();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain(webhookSecret);
    expect(serialized).not.toContain(qqSecret);
    expect(snapshot.instances['bot']).toMatchObject({
      config: {
        webhooks: {
          sources: {
            github: { targets: { main: { chatId: 'chat-1' } } },
            ci: { secretEnv: 'CI_WEBHOOK_SECRET', targets: {} },
          },
        },
      },
      webhookSecrets: {
        github: { present: true, source: 'literal' },
        ci: { present: true, source: 'environment' },
      },
    });
    expect(snapshot.instances['qq']).toMatchObject({
      config: { type: 'qq', appID: 'app-id' },
      secrets: { appSecret: { present: true, source: 'literal' } },
      webhookSecrets: {},
    });
  });

  it('never exposes raw config from an unmanaged channel type', async () => {
    const sentinel = 'unmanaged-secret-sentinel';
    const { service } = setup({
      snapshot: settingsSnapshot({
        channels: {
          legacy: {
            type: 'unmanaged-extension',
            token: sentinel,
            secret: sentinel,
            nested: { credential: sentinel },
          },
        },
        startupNames: ['legacy'],
      }),
      committedNames: ['legacy'],
    });

    const snapshot = await service.list();

    expect(snapshot.instances['legacy']).toMatchObject({
      config: { type: 'unmanaged-extension' },
      startsWithServe: true,
      runtime: { state: 'connected' },
    });
    expect(JSON.stringify(snapshot)).not.toContain(sentinel);
  });

  it('projects a whitespace all startup sentinel onto every configured instance', async () => {
    const { service } = setup({
      snapshot: settingsSnapshot({
        channels: {
          all: { type: 'telegram' },
          first: { type: 'telegram' },
          bot: { type: 'telegram' },
        },
        startupNames: [' all '],
      }),
    });

    const result = await service.list();

    expect(result.instances['all']?.startsWithServe).toBe(true);
    expect(result.instances['first']?.startsWithServe).toBe(true);
    expect(result.instances['bot']?.startsWithServe).toBe(true);
  });

  it('keeps a failed replacement config and reports the instance as error', async () => {
    const { service, store, manager, persisted } = setup({
      committedNames: ['other', 'bot'],
    });
    manager.reloadWorkspace.mockRejectedValueOnce(
      new Error('invalid token token=start-secret'),
    );

    const result = await service.upsert('bot', {
      expectedRevision: 'rev-1',
      config: { type: 'telegram', senderPolicy: 'pairing' },
      secrets: { token: { operation: 'clear' } },
    });

    expect(store.upsert).toHaveBeenCalledBefore(manager.reloadWorkspace);
    expect(persisted().channels['bot']).not.toHaveProperty('token');
    expect(manager.setSelection).toHaveBeenCalledWith({
      mode: 'names',
      names: ['other'],
    });
    expect(result.instance.runtime).toEqual({
      state: 'error',
      lastError: 'invalid token token=<redacted>',
    });
    expect(manager.reload).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('rejects a channel cwd outside the selected workspace before persisting', async () => {
    const { service, store, manager } = setup({});

    await expect(
      service.upsert('bot', {
        expectedRevision: 'rev-1',
        config: { type: 'telegram', cwd: '/ws/secondary' },
      }),
    ).rejects.toMatchObject({ code: 'channel_workspace_mismatch' });

    expect(store.upsert).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('does not delete config when worker stop is unconfirmed', async () => {
    const { service, store, manager, persisted } = setup({
      committedNames: ['bot'],
    });
    vi.mocked(manager.stopSelection).mockRejectedValueOnce(
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

  it('rejects a stale active delete before any worker side effect', async () => {
    const { service, store, manager, persisted } = setup({
      committedNames: ['bot'],
      snapshot: settingsSnapshot({ startupNames: ['bot'] }),
    });

    await expect(
      service.remove('bot', { expectedRevision: 'stale' }),
    ).rejects.toMatchObject({ code: 'channel_settings_conflict' });

    expect(manager.stopSelection).not.toHaveBeenCalled();
    expect(manager.setSelection).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(persisted()).toEqual(settingsSnapshot({ startupNames: ['bot'] }));
    expect(manager.committedChannelNames()).toEqual(['bot']);
  });

  it('serializes concurrent deletes so a losing revision cannot stop twice', async () => {
    const { service, manager, persisted } = setup({
      committedNames: ['bot'],
      snapshot: settingsSnapshot({ startupNames: ['bot'] }),
    });
    let releaseStop!: () => void;
    const stopPending = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    vi.mocked(manager.stopSelection).mockImplementationOnce(async () => {
      await stopPending;
    });

    const winner = service.remove('bot', { expectedRevision: 'rev-1' });
    await vi.waitFor(() =>
      expect(manager.stopSelection).toHaveBeenCalledOnce(),
    );
    const loser = service.remove('bot', { expectedRevision: 'rev-1' });
    await Promise.resolve();
    expect(manager.stopSelection).toHaveBeenCalledOnce();

    releaseStop();
    await winner;
    await expect(loser).rejects.toMatchObject({
      code: 'channel_settings_conflict',
    });

    expect(manager.stopSelection).toHaveBeenCalledOnce();
    expect(persisted().channels).not.toHaveProperty('bot');
    expect(persisted().startupNames).toEqual([]);
  });

  it('starts and stops from the manager committed order without persisting startup names', async () => {
    const { service, store, manager } = setup({
      committedNames: ['first', 'second'],
      snapshot: settingsSnapshot({
        channels: {
          first: { type: 'telegram' },
          second: { type: 'telegram' },
          bot: { type: 'telegram' },
        },
      }),
    });

    await service.start('bot');
    expect(manager.setSelection).toHaveBeenNthCalledWith(
      1,
      {
        mode: 'names',
        names: ['first', 'second', 'bot'],
      },
      { name: 'bot', workspaceCwd: WORKSPACE },
    );

    await service.stop('second');
    expect(manager.setSelection).toHaveBeenNthCalledWith(2, {
      mode: 'names',
      names: ['first', 'bot'],
    });
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('lists and approves pairing requests only in the selected workspace', async () => {
    const qwenHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-pairing-api-'),
    );
    const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ws-a-'));
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ws-b-'));
    const originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;

    try {
      const snapshot = settingsSnapshot({
        channels: {
          bot: { type: 'dingtalk', senderPolicy: 'pairing' },
        },
      });
      const serviceA = setup({
        snapshot,
        serviceWorkspaceCwd: workspaceA,
      }).service;
      const serviceB = setup({
        snapshot,
        serviceWorkspaceCwd: workspaceB,
      }).service;
      const codeA = new PairingStore('bot', workspaceA).createRequest(
        'sender-a',
        'Alice',
      )!;
      new PairingStore('bot', workspaceB).createRequest('sender-b', 'Bob');

      expect(await serviceA.pairingRequests('bot')).toMatchObject({
        requests: [{ senderId: 'sender-a', senderName: 'Alice', code: codeA }],
      });
      expect(await serviceB.pairingRequests('bot')).toMatchObject({
        requests: [{ senderId: 'sender-b', senderName: 'Bob' }],
      });

      const approved = await serviceA.approvePairing('bot', codeA);
      expect(approved.approved).toMatchObject({
        senderId: 'sender-a',
        senderName: 'Alice',
      });
      expect(approved.requests).toEqual([]);
      expect(new PairingStore('bot', workspaceA).isApproved('sender-a')).toBe(
        true,
      );
      expect(new PairingStore('bot', workspaceB).isApproved('sender-a')).toBe(
        false,
      );
    } finally {
      if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = originalQwenHome;
      for (const dir of [qwenHome, workspaceA, workspaceB]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('enables persisted startup once while preserving order and runtime state', async () => {
    const { service, store, manager, persisted } = setup({
      committedNames: ['bot'],
      snapshot: settingsSnapshot({ startupNames: ['first'] }),
    });

    const result = await service.setStartup('bot', {
      expectedRevision: 'rev-1',
      enabled: true,
    });

    expect(store.setStartupNames).toHaveBeenCalledWith(['first', 'bot'], {
      expectedRevision: 'rev-1',
    });
    expect(persisted().channels).toEqual(settingsSnapshot().channels);
    expect(result.instance.startsWithServe).toBe(true);
    expect(result.instance.runtime.state).toBe('connected');
    expect(manager.setSelection).not.toHaveBeenCalled();
    expect(manager.stopSelection).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('disables persisted startup without mutating the runtime manager', async () => {
    const { service, store, manager } = setup({
      committedNames: ['bot'],
      snapshot: settingsSnapshot({ startupNames: ['first', 'bot', 'last'] }),
    });

    const result = await service.setStartup('bot', {
      expectedRevision: 'rev-1',
      enabled: false,
    });

    expect(store.setStartupNames).toHaveBeenCalledWith(['first', 'last'], {
      expectedRevision: 'rev-1',
    });
    expect(result.instance.startsWithServe).toBe(false);
    expect(manager.setSelection).not.toHaveBeenCalled();
    expect(manager.stopSelection).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('treats enabling one instance under whitespace all as a revision-checked no-op', async () => {
    const { service, store, manager } = setup({
      snapshot: settingsSnapshot({ startupNames: [' all '] }),
    });

    const result = await service.setStartup('bot', {
      expectedRevision: 'rev-1',
      enabled: true,
    });

    expect(result.instance.startsWithServe).toBe(true);
    expect(result.snapshot.revision).toBe('rev-1');
    expect(store.setStartupNames).not.toHaveBeenCalled();
    expect(manager.setSelection).not.toHaveBeenCalled();
    expect(manager.stopSelection).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();

    await expect(
      service.setStartup('bot', {
        expectedRevision: 'stale',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_conflict' });
    expect(store.setStartupNames).not.toHaveBeenCalled();
  });

  it('expands whitespace all to the other configured instances when disabling one', async () => {
    const { service, store, manager } = setup({
      snapshot: settingsSnapshot({
        channels: {
          ' all ': { type: 'telegram' },
          first: { type: 'telegram' },
          bot: { type: 'telegram' },
          last: { type: 'telegram' },
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
    expect(normalizeServeChannelSelection(['first', 'last'])).toEqual({
      mode: 'names',
      names: ['first', 'last'],
    });
    expect(result.instance.startsWithServe).toBe(false);
    expect(result.snapshot.instances['first']?.startsWithServe).toBe(true);
    expect(result.snapshot.instances['last']?.startsWithServe).toBe(true);
    expect(manager.setSelection).not.toHaveBeenCalled();
    expect(manager.stopSelection).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('writes an empty startup list when disabling the only instance under all', async () => {
    const { service, store } = setup({
      snapshot: settingsSnapshot({ startupNames: ['all'] }),
    });

    await service.setStartup('bot', {
      expectedRevision: 'rev-1',
      enabled: false,
    });

    expect(store.setStartupNames).toHaveBeenCalledWith([], {
      expectedRevision: 'rev-1',
    });
    expect(normalizeServeChannelSelection([])).toBeUndefined();
  });

  it('rejects startup changes for an unconfigured instance', async () => {
    const { service, store, manager } = setup({ committedNames: [] });

    await expect(
      service.setStartup('missing', {
        expectedRevision: 'rev-1',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'channel_instance_not_found' });

    expect(store.setStartupNames).not.toHaveBeenCalled();
    expect(manager.setSelection).not.toHaveBeenCalled();
  });

  it.each(['all', ' all ', '\tall\n'])(
    'rejects the reserved %j name for configuration and startup mutations',
    async (reservedName) => {
      const { service, store, manager } = setup({
        snapshot: settingsSnapshot({
          channels: { all: { type: 'telegram' }, bot: { type: 'telegram' } },
          startupNames: ['all'],
        }),
      });

      await expect(
        service.upsert(reservedName, {
          expectedRevision: 'rev-1',
          config: { type: 'telegram' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_channel_instance_name' });
      await expect(
        service.setStartup(reservedName, {
          expectedRevision: 'rev-1',
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: 'invalid_channel_instance_name' });

      expect(store.upsert).not.toHaveBeenCalled();
      expect(store.setStartupNames).not.toHaveBeenCalled();
      expect(manager.setSelection).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['start', 'stop', 'restart'] as const).flatMap((operation) =>
      ['all', ' all ', '\tall\n'].map((name) => [operation, name] as const),
    ),
  )(
    'rejects the reserved name before %s(%j) reaches the manager',
    async (operation, reservedName) => {
      const { service, manager } = setup({
        snapshot: settingsSnapshot({
          channels: { all: { type: 'telegram' }, bot: { type: 'telegram' } },
          startupNames: ['all'],
        }),
      });

      await expect(service[operation](reservedName)).rejects.toMatchObject({
        code: 'invalid_channel_instance_name',
      });

      expect(manager.committedChannelNames).not.toHaveBeenCalled();
      expect(manager.setSelection).not.toHaveBeenCalled();
      expect(manager.stopSelection).not.toHaveBeenCalled();
      expect(manager.reloadWorkspace).not.toHaveBeenCalled();
    },
  );

  it('removes a legacy all config without treating the sentinel as a runtime instance', async () => {
    const { service, store, manager } = setup({
      committedNames: ['all'],
      snapshot: settingsSnapshot({
        channels: { all: { type: 'telegram' }, bot: { type: 'telegram' } },
        startupNames: ['all'],
      }),
    });

    const result = await service.remove('all', {
      expectedRevision: 'rev-1',
    });

    expect(store.remove).toHaveBeenCalledWith('all', {
      expectedRevision: 'rev-1',
    });
    expect(result.snapshot.instances).not.toHaveProperty('all');
    expect(result.snapshot.instances['bot']?.startsWithServe).toBe(true);
    expect(manager.stopSelection).not.toHaveBeenCalled();
    expect(manager.setSelection).not.toHaveBeenCalled();
  });

  it('removes a whitespace legacy all config without mutating runtime selection', async () => {
    const { service, store, manager } = setup({
      committedNames: [' all '],
      snapshot: settingsSnapshot({
        channels: {
          ' all ': { type: 'telegram' },
          bot: { type: 'telegram' },
        },
        startupNames: [' all ', 'bot'],
      }),
    });

    const result = await service.remove(' all ', {
      expectedRevision: 'rev-1',
    });

    expect(store.remove).toHaveBeenCalledWith(' all ', {
      expectedRevision: 'rev-1',
    });
    expect(result.snapshot.instances).not.toHaveProperty(' all ');
    expect(result.snapshot.instances['bot']?.startsWithServe).toBe(true);
    expect(manager.stopSelection).not.toHaveBeenCalled();
    expect(manager.setSelection).not.toHaveBeenCalled();
  });

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
    vi.mocked(manager.setSelection).mockRejectedValueOnce(
      Object.assign(new Error('owner mismatch'), {
        code: 'channel_runtime_owner_mismatch',
      }),
    );

    await expect(service.start('bot')).rejects.toMatchObject({
      code: 'channel_runtime_owner_mismatch',
    });

    expect(manager.setSelection).toHaveBeenCalledWith(
      { mode: 'names', names: ['bot'] },
      { name: 'bot', workspaceCwd: WORKSPACE },
    );
    expect(manager.reload).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'rejects inherited instance name %s before start reaches the manager',
    async (name) => {
      const { service, manager } = setup({ committedNames: [] });

      await expect(service.start(name)).rejects.toMatchObject({
        code: 'channel_instance_not_found',
      });

      expect(manager.committedChannelNames).not.toHaveBeenCalled();
      expect(manager.setSelection).not.toHaveBeenCalled();
      expect(manager.stopSelection).not.toHaveBeenCalled();
      expect(manager.state).not.toHaveBeenCalled();
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'rejects inherited instance name %s before stop reaches the manager',
    async (name) => {
      const { service, manager } = setup({ committedNames: [] });

      await expect(service.stop(name)).rejects.toMatchObject({
        code: 'channel_instance_not_found',
      });

      expect(manager.committedChannelNames).not.toHaveBeenCalled();
      expect(manager.setSelection).not.toHaveBeenCalled();
      expect(manager.stopSelection).not.toHaveBeenCalled();
      expect(manager.state).not.toHaveBeenCalled();
    },
  );
});
