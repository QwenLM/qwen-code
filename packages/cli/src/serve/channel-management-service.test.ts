/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
}) {
  let persisted = options.snapshot ?? settingsSnapshot();
  const store = {
    snapshot: vi.fn(() => persisted),
    upsert: vi.fn(async (name, request) => {
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
  };
  let names = options.committedNames ?? [];
  const manager: ChannelManagementWorkerManager = {
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
      config: { type: 'telegram', senderPolicy: 'open' },
      secrets: { token: { present: true, source: 'environment' } },
      startsWithServe: false,
      runtime: { state: 'connected' },
    });
  });

  it('keeps a failed replacement config and reports the instance as error', async () => {
    const { service, store, manager, persisted } = setup({
      committedNames: ['other', 'bot'],
    });
    vi.mocked(manager.reload).mockRejectedValueOnce(
      new Error('invalid token token=start-secret'),
    );

    const result = await service.upsert('bot', {
      expectedRevision: 'rev-1',
      config: { type: 'telegram', senderPolicy: 'pairing' },
      secrets: { token: { operation: 'clear' } },
    });

    expect(store.upsert).toHaveBeenCalledBefore(vi.mocked(manager.reload));
    expect(persisted().channels['bot']).not.toHaveProperty('token');
    expect(manager.setSelection).toHaveBeenCalledWith({
      mode: 'names',
      names: ['other'],
    });
    expect(result.instance.runtime).toEqual({
      state: 'error',
      lastError: 'invalid token token=<redacted>',
    });
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
    expect(manager.setSelection).toHaveBeenNthCalledWith(1, {
      mode: 'names',
      names: ['first', 'second', 'bot'],
    });

    await service.stop('second');
    expect(manager.setSelection).toHaveBeenNthCalledWith(2, {
      mode: 'names',
      names: ['first', 'bot'],
    });
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
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
});
