/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PairingStore } from '@qwen-code/channel-base';
import type { CreatePairingRequestResult } from '@qwen-code/channel-base';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonChannelRuntimeStatePath } from '../commands/channel/runtime.js';

// Identity-equivalent stand-in for the real helper: every workspace used in
// these tests is nonexistent, where the real canonicalizeWorkspace falls
// back to path.resolve — so the default keeps the other tests' expectations
// while individual tests can simulate a degraded fs (non-ENOENT rethrow).
const mockCanonicalizeWorkspace = vi.hoisted(() =>
  vi.fn((p: string) => path.resolve(p)),
);

vi.mock('@qwen-code/acp-bridge/workspacePaths', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/acp-bridge/workspacePaths')
    >();
  return { ...actual, canonicalizeWorkspace: mockCanonicalizeWorkspace };
});

const mockChannelStateStoreSet = vi.hoisted(() => vi.fn());
const mockChannelStateStoreTrySetMany = vi.hoisted(() => vi.fn());
const mockChannelStateStore = vi.hoisted(() =>
  vi.fn(() => ({
    readAll: vi.fn(() => ({})),
    set: mockChannelStateStoreSet,
    setMany: vi.fn(),
    // Mirror the real best-effort wrapper so a throwing `set` mock
    // still exercises "persistence failure never blocks a stop", and
    // report the persisted boolean for failure-path assertions.
    trySet: (name: string, state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSet(name, state);
        return true;
      } catch {
        return false;
      }
    },
    trySetMany: mockChannelStateStoreTrySetMany,
  })),
);

vi.mock('../commands/channel/channel-state-store.js', () => ({
  ChannelStateStore: mockChannelStateStore,
}));

import type { ChannelSettingsSnapshot } from './channel-settings-store.js';
import {
  createChannelManagementService,
  type ChannelManagementWorkerManager,
} from './channel-management-service.js';
import { ChannelWorkerControlError } from './channel-worker-manager.js';

beforeEach(() => {
  mockChannelStateStore.mockClear();
  mockChannelStateStoreSet.mockClear();
  mockChannelStateStoreTrySetMany.mockClear();
  mockChannelStateStoreTrySetMany.mockReturnValue(true);
  // Individual tests install degraded-fs implementations; reset both the
  // recorded calls and the implementation so a leak cannot cross tests.
  mockCanonicalizeWorkspace.mockClear();
  mockCanonicalizeWorkspace.mockImplementation((p: string) => path.resolve(p));
});

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
      if (enabled) {
        if (names.includes(name)) return { changed: false };
        names = [...names, name];
        return { changed: true };
      }
      if (!names.includes(name)) return { changed: false };
      names = names.filter((item) => item !== name);
      return { changed: true };
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

function codeOf(result: CreatePairingRequestResult): string {
  if ('code' in result) return result.code;
  throw new Error(
    `expected a pairing code, got rejection "${result.rejected}"`,
  );
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
    await expect(service.pairingApprovals('bot')).rejects.toMatchObject({
      code: 'channel_workspace_mismatch',
    });
    await expect(
      service.revokePairingApproval('bot', {
        type: 'user',
        id: 'sender-1',
      }),
    ).rejects.toMatchObject({
      code: 'channel_workspace_mismatch',
    });

    expect(store.setStartupNames).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('manages pairing requests and approvals in the selected workspace scope', async () => {
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
      const created = pairing.createRequest('sender-1', 'Alice');
      expect(created).toEqual({ code: expect.any(String) });
      const code = codeOf(created);

      await expect(service.pairingRequests('bot')).resolves.toEqual({
        requests: [
          expect.objectContaining({
            senderId: 'sender-1',
            senderName: 'Alice',
            code,
          }),
        ],
      });
      await expect(service.approvePairing('bot', code)).resolves.toEqual({
        approved: expect.objectContaining({ senderId: 'sender-1', code }),
        requests: [],
      });
      expect(pairing.isApproved('sender-1')).toBe(true);
      await expect(service.pairingApprovals('bot')).resolves.toEqual({
        senderIds: ['sender-1'],
        groupIds: [],
      });
      await expect(
        service.revokePairingApproval('bot', {
          type: 'user',
          id: 'sender-1',
        }),
      ).resolves.toEqual({
        revoked: 'sender-1',
        senderIds: [],
        groupIds: [],
      });
      expect(pairing.isApproved('sender-1')).toBe(false);
      await expect(
        service.revokePairingApproval('bot', {
          type: 'user',
          id: 'sender-1',
        }),
      ).rejects.toMatchObject({
        code: 'channel_pairing_approval_not_found',
      });
    } finally {
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      await fs.rm(qwenHome, { recursive: true, force: true });
    }
  });

  it('manages group pairing when groupPolicy uses pairing mode', async () => {
    const previousQwenHome = process.env['QWEN_HOME'];
    const qwenHome = await fs.mkdtemp(
      path.join(os.tmpdir(), 'channel-management-group-pairing-'),
    );
    process.env['QWEN_HOME'] = qwenHome;
    try {
      const { service } = setup({
        snapshot: settingsSnapshot({
          channels: {
            bot: {
              type: 'dingtalk',
              senderPolicy: 'open',
              groupPolicy: 'pairing',
            },
          },
        }),
      });
      const pairing = new PairingStore('bot', WORKSPACE);
      const code = codeOf(
        pairing.createGroupRequest(
          'group-1',
          'Release Team',
          'sender-1',
          'Alice',
        ),
      );
      const secondCode = codeOf(
        pairing.createGroupRequest(
          'group-2',
          'Platform Team',
          'sender-2',
          'Bob',
        ),
      );

      await expect(service.pairingRequests('bot')).resolves.toEqual({
        requests: [
          expect.objectContaining({
            senderId: 'sender-1',
            subject: {
              type: 'group',
              id: 'group-1',
              name: 'Release Team',
            },
          }),
          expect.objectContaining({
            senderId: 'sender-2',
            subject: {
              type: 'group',
              id: 'group-2',
              name: 'Platform Team',
            },
          }),
        ],
      });
      await expect(service.approvePairing('bot', code)).resolves.toEqual({
        approved: expect.objectContaining({
          subject: { type: 'group', id: 'group-1', name: 'Release Team' },
        }),
        requests: [
          expect.objectContaining({
            subject: { type: 'group', id: 'group-2', name: 'Platform Team' },
          }),
        ],
      });
      await service.approvePairing('bot', secondCode);
      await expect(service.pairingApprovals('bot')).resolves.toEqual({
        senderIds: [],
        groupIds: ['group-1', 'group-2'],
      });
      await expect(
        service.revokePairingApproval('bot', {
          type: 'group',
          id: 'group-1',
        }),
      ).resolves.toEqual({
        revoked: 'group-1',
        senderIds: [],
        groupIds: ['group-2'],
      });
      await expect(
        service.revokePairingApproval('bot', {
          type: 'group',
          id: 'group-1',
        }),
      ).rejects.toMatchObject({
        code: 'channel_pairing_approval_not_found',
      });
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
    // An explicit stop is persisted so `--channel all` skips it (#8975).
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('second', 'stopped');
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('records stops in the workspace state file (#8975)', async () => {
    const { service } = setup({ committedNames: ['bot'] });
    // Simulate a workspace whose canonical form diverges from the raw
    // path (e.g. a symlinked cwd): the store path must be derived from
    // the CANONICAL form, matching the daemon worker's canonical restore
    // read. The expected path is computed from the literal canonical
    // value, NOT through the mock — dropping canonicalForGuard from the
    // persistence call would hash the raw path and turn this red.
    mockCanonicalizeWorkspace.mockImplementation((p: string) =>
      p === WORKSPACE ? `/canonical${WORKSPACE}` : path.resolve(p),
    );

    await service.stop('bot');

    expect(mockCanonicalizeWorkspace).toHaveBeenCalledWith(WORKSPACE);
    // Pin the EXACT workspace-derived path, not just its segments: a stop
    // written under a different hash than the daemon worker's restore read
    // resurrects the stopped channel after the next daemon restart.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(`/canonical${WORKSPACE}`),
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('persists the whole-selection tear-down set on the success path (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Disabling the LAST committed channel routes through the
    // whole-selection stop, which tears down every workspace's workers
    // and returns the per-workspace set. Persisting only the stopped name
    // would leave the other workspaces' torn-down channels unrecorded,
    // so they resurrect on the next `--channel all` start — the DELETE
    // route records both, and this flow's error path persists the groups
    // already (#8975).
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      stoppedChannels: [
        { workspaceCwd: WORKSPACE, names: ['bot'] },
        { workspaceCwd: '/ws/other', names: ['aux'] },
      ],
    });

    const result = await service.stop('bot');

    expect(result.instance.name).toBe('bot');
    expect(mockChannelStateStore).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(WORKSPACE),
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath('/ws/other'),
    );
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['bot'],
      'stopped',
    );
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['aux'],
      'stopped',
    );
    // The group writes replace the single-name write, and every group
    // persisted, so the happy-path shape stays unchanged.
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('statePersisted');
  });

  it('reports statePersisted false when a success-path group write fails (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      stoppedChannels: [
        { workspaceCwd: WORKSPACE, names: ['bot'] },
        { workspaceCwd: '/ws/other', names: ['aux'] },
      ],
    });
    mockChannelStateStoreTrySetMany.mockReturnValueOnce(false);

    const result = await service.stop('bot');

    expect(result.instance.name).toBe('bot');
    // The second group must still be attempted before reporting the loss.
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledTimes(2);
    expect(result.statePersisted).toBe(false);
  });

  it('does not record state when the stop itself fails (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    manager.setChannelEnabled.mockRejectedValueOnce(new Error('stop failed'));

    await expect(service.stop('bot')).rejects.toThrow('stop failed');

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreTrySetMany).not.toHaveBeenCalled();
  });

  it('persists the torn-down channels when a failed stop carries them (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Disabling the LAST committed channel routes through the
    // whole-selection stop, whose lease release can fail AFTER a successful
    // tear-down; the manager carries the torn-down set on the error. The
    // service must persist it like the whole-selection route does, or the
    // channel resurrects on the next `--channel all` start while the
    // per-channel route reports a bare 500 (#8975).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        stoppedChannels: [{ workspaceCwd: WORKSPACE, names: ['bot'] }],
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });

    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(WORKSPACE),
    );
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['bot'],
      'stopped',
    );
    // The success-path single-name write must not run on the failure path.
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
  });

  it('persists every carried group when a failed stop spans workspaces (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Multi-workspace daemon: stopping the last committed channel tears
    // down every group and the lease release fails; the error carries one
    // group per workspace. A first-group-only regression leaves the other
    // workspaces' torn-down channels unrecorded, so they resurrect on the
    // next `--channel all` start (#8975).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        stoppedChannels: [
          { workspaceCwd: WORKSPACE, names: ['bot'] },
          { workspaceCwd: '/ws/other', names: ['aux'] },
        ],
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });

    expect(mockChannelStateStore).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(WORKSPACE),
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath('/ws/other'),
    );
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['bot'],
      'stopped',
    );
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['aux'],
      'stopped',
    );
  });

  it('persists carried groups under their captured canonical workspace form (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // The manager captures stoppedChannels in canonical form (see
    // stoppedChannelsByWorkspace); the service must persist under exactly
    // that form. Re-deriving from the service's raw workspace here would
    // hash a different path than the daemon worker's canonical restore
    // read, so the record is missed and the channel resurrects on the
    // next `--channel all` start. The expected path is computed from the
    // literal carried value, not through any mock (#8975).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        stoppedChannels: [
          { workspaceCwd: `/canonical${WORKSPACE}`, names: ['bot'] },
        ],
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });

    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(`/canonical${WORKSPACE}`),
    );
  });

  it('marks the rethrown error when carried-group persistence also fails (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Under the same disk condition that failed the lease release, the
    // state write can also fail: the boolean must be aggregated like the
    // DELETE route's recordChannelsStopped and ride the rethrown error,
    // so the management route's 500 body can carry the loss — the client
    // has no retry handle once the group is cleared (#8975). Two groups,
    // FIRST write fails: a last-group-overwrites or early-return
    // regression in the aggregation must not report the stop as fully
    // persisted, and the second group must still be attempted.
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        stoppedChannels: [
          { workspaceCwd: WORKSPACE, names: ['bot'] },
          { workspaceCwd: '/ws/other', names: ['aux'] },
        ],
      }),
    );
    mockChannelStateStoreTrySetMany.mockReturnValueOnce(false);

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
      statePersisted: false,
    });

    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['aux'],
      'stopped',
    );
  });

  it('keeps the rethrown error unmarked when every carried group persisted (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        stoppedChannels: [{ workspaceCwd: WORKSPACE, names: ['bot'] }],
      }),
    );

    // toMatchObject cannot pin absence; assert on the rejection directly.
    // The flag field exists on the error class but is only SET on loss,
    // so the fully-persisted shape is undefined, never false (#8975).
    const error = await service.stop('bot').catch((thrown) => thrown);
    expect(error).toMatchObject({ code: 'channel_worker_stop_failed' });
    expect(
      (error as { statePersisted?: boolean }).statePersisted,
    ).toBeUndefined();
  });

  it('persists the stop when a failed disable leaves the channel confirmed dead (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Per-channel disable routes through applySelection: the reconcile
    // stops the old worker entries, the replacement selection fails to
    // start, and the rollback restart also fails (rolledBack: false). The
    // channel is confirmed dead, but this error shape carries no
    // stoppedChannels set — without a record here the next `--channel all`
    // start resurrects it (#8975).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
    });

    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(WORKSPACE),
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
    expect(mockChannelStateStoreTrySetMany).not.toHaveBeenCalled();
  });

  it('persists the confirmed-dead stop under the canonical workspace form (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
      }),
    );
    // Diverging-canonical twin of the success-path test: the expected
    // path is computed from the literal canonical value — replacing
    // canonicalForGuard(opts.workspaceCwd) with the raw path only in the
    // confirmed-dead branch would hash the raw form and turn this red,
    // while the daemon worker's restore read stays canonical (#8975).
    mockCanonicalizeWorkspace.mockImplementation((p: string) =>
      p === WORKSPACE ? `/canonical${WORKSPACE}` : path.resolve(p),
    );

    try {
      await expect(service.stop('bot')).rejects.toMatchObject({
        code: 'channel_worker_start_failed',
      });
    } finally {
      mockCanonicalizeWorkspace.mockImplementation((p: string) =>
        path.resolve(p),
      );
    }

    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(`/canonical${WORKSPACE}`),
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('does not persist the stop when the failed disable rolled back (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // rolledBack: true means the old worker was restored — the channel is
    // not dead, so recording `stopped` would skip a live channel on the
    // next `--channel all` start (#8975).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: true,
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
    });

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreTrySetMany).not.toHaveBeenCalled();
  });

  it('does not persist from a stop-phase failure without a torn-down set (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // The stop-phase failure shape (code channel_worker_stop_failed,
    // rolledBack: false) can leave an old worker alive; keying on
    // rolledBack alone would record a running channel as stopped (#8975).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        rolledBack: false,
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreTrySetMany).not.toHaveBeenCalled();
  });

  it('keeps stopping when state persistence fails (#8975)', async () => {
    const { service } = setup({ committedNames: ['bot'] });
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = await service.stop('bot');

    expect(result.instance.name).toBe('bot');
    // The stop itself succeeded, so the result stays a 200-shape — but it
    // must carry the persistence failure, or the route's client claims a
    // durable stop and the channel silently resurrects on `--channel all`
    // (#8975).
    expect(result.statePersisted).toBe(false);
  });

  it('omits statePersisted when the stop record persisted (#8975)', async () => {
    const { service } = setup({ committedNames: ['bot'] });

    const result = await service.stop('bot');

    expect(result.instance.name).toBe('bot');
    // Happy-path response shape stays unchanged: the flag only appears on
    // failure, matching the whole-selection DELETE route (#8975).
    expect(result).not.toHaveProperty('statePersisted');
  });

  it('still records the stop when canonicalization fails on the persistence path (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // The stop is confirmed (changed: true), so the guard is never
    // evaluated and every canonicalize call in this flow belongs to the
    // persistence path: install a throwing mock there. The throw-safe
    // wrapper must degrade to the path.resolve form instead of letting
    // the raw fs error escape stop() AFTER the channel has already been
    // disabled — an applied-but-unrecorded stop resurrects on the next
    // `--channel all` start (#8975).
    mockCanonicalizeWorkspace.mockImplementation(() => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    const result = await service.stop('bot');

    expect(result.instance.name).toBe('bot');
    expect(manager.setChannelEnabled).toHaveBeenCalledWith(
      { name: 'bot', workspaceCwd: WORKSPACE },
      false,
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(path.resolve(WORKSPACE)),
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('rejects an unconfirmable stop while the workspace worker is starting (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // A crash-restarting mode-`all` worker has not committed real channel
    // names yet: the disable cannot be confirmed (changed: false) and the
    // snapshot still lacks `requestedChannels`.
    manager.setChannelEnabled.mockResolvedValueOnce({ changed: false });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'all' },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'starting',
          channels: ['all'],
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_starting',
    });

    // The stopped record must not be persisted on a stop reported as
    // successful — the relaunching worker could overwrite it.
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
  });

  it('rejects an unconfirmable stop in the mode-all crash-restart window too (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The carry-over shape, contradicting the initial-start shape above:
    // a crash-restarting mode-`all` worker carries its last committed
    // names in `requestedChannels` (DEFINED), while `channels` is still
    // the `['all']` launch placeholder. The guard must key on the
    // placeholder too, or a stop of a channel outside the carried set
    // gets a false 200 and the relaunched worker connects it (absent =
    // active) and overwrites the record (#8975).
    manager.setChannelEnabled.mockResolvedValueOnce({ changed: false });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'all' },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'starting',
          channels: ['all'],
          requestedChannels: ['telegram'],
          lastConnectedChannels: ['telegram'],
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_starting',
    });

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
  });

  it('does not block a stop during a healthy mode-names starting window (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // A mode-names worker defines `requestedChannels` at launch and its
    // `channels` are the real selection names (no `all` placeholder): it
    // can only connect the named selection, so a stop of a channel
    // outside it is safe to record even mid-window.
    manager.setChannelEnabled.mockResolvedValueOnce({ changed: false });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['telegram'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'starting',
          channels: ['telegram'],
          requestedChannels: ['telegram'],
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    await service.stop('bot');

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('records a stop against a permanently failed worker (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // Restart budget exhausted, no restart scheduled: the worker will
    // never connect anything again, so it is not "starting" — the stop
    // record is safe to persist (and the supervisor drops the carried
    // names in this terminal state).
    manager.setChannelEnabled.mockResolvedValueOnce({ changed: false });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'all' },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['all'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    await service.stop('bot');

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('only blocks on a starting worker of the same workspace (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    manager.setChannelEnabled.mockResolvedValueOnce({ changed: false });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'all' },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'starting',
          channels: ['all'],
          workspaceId: 'other',
          workspaceCwd: '/ws/other',
          primary: false,
        },
      ],
    });

    await service.stop('bot');

    // The starting-window guard is workspace-scoped: another workspace's
    // mode-`all` worker must neither block this workspace's stop nor let an
    // unconfirmable stop persist. Dropping the workspace comparison from
    // the guard turns this into a 409.
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('keeps the starting-window guard actionable when the fs is degraded (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    manager.setChannelEnabled.mockResolvedValueOnce({ changed: false });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'all' },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'starting',
          channels: ['all'],
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });
    // canonicalizeWorkspace rethrows non-ENOENT fs errors by design. The
    // stop path compares through a throw-safe form, so a degraded path must
    // degrade to the path.resolve comparison — producing the actionable 409
    // the guard exists for — instead of escaping stop() as a raw EACCES
    // that the route maps to an opaque 500 with no stopped record.
    mockCanonicalizeWorkspace.mockImplementation(() => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    try {
      await expect(service.stop('bot')).rejects.toMatchObject({
        code: 'channel_worker_starting',
      });
    } finally {
      mockCanonicalizeWorkspace.mockImplementation((p: string) =>
        path.resolve(p),
      );
    }

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
  });

  it('still records an idempotent stop when no worker is starting (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    manager.setChannelEnabled.mockResolvedValueOnce({ changed: false });

    await service.stop('bot');

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
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

  it('rejects restart of a channel not running in this workspace', async () => {
    const { service, manager } = setup({
      committedNames: ['bot'],
      workspaceCwd: '/ws/secondary',
    });

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_worker_not_enabled',
    });
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('rejects restart of a configured channel that is not enabled', async () => {
    const { service, manager } = setup({ committedNames: [] });

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_worker_not_enabled',
    });
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
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

  it('scopes committed names so same-name channels across workspaces do not collide', async () => {
    const { service, store, manager } = setup({ committedNames: ['bot'] });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names' as const, names: ['bot'] },
      transition: 'idle' as const,
      workers: [
        {
          enabled: true,
          state: 'running' as const,
          channels: ['bot'],
          requestedChannels: ['bot'],
          adapters: [{ name: 'bot', state: 'connected' as const }],
          workspaceId: 'other',
          workspaceCwd: '/ws/other',
          primary: false,
        },
      ],
    });

    const result = await service.list();
    expect(result.instances['bot']?.runtime).toEqual({ state: 'stopped' });

    const upserted = await service.upsert('bot', {
      expectedRevision: 'rev-1',
      config: { type: 'dingtalk', clientId: 'new-id' },
    });
    expect(upserted.instance.config).toMatchObject({ clientId: 'new-id' });
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
    expect(store.upsert).toHaveBeenCalledOnce();
  });

  it('allows mutations when two same-name workers run in different workspaces', async () => {
    const { service, store, manager } = setup({ committedNames: ['bot'] });
    const twoWorkers = {
      enabled: true,
      selection: { mode: 'names' as const, names: ['bot'] },
      transition: 'idle' as const,
      workers: [
        {
          enabled: true,
          state: 'running' as const,
          channels: ['bot'],
          requestedChannels: ['bot'],
          adapters: [{ name: 'bot', state: 'connected' as const }],
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
        {
          enabled: true,
          state: 'running' as const,
          channels: ['bot'],
          requestedChannels: ['bot'],
          adapters: [{ name: 'bot', state: 'connected' as const }],
          workspaceId: 'other',
          workspaceCwd: '/ws/other',
          primary: false,
        },
      ],
    };
    vi.mocked(manager.state).mockReturnValue(twoWorkers);

    const upserted = await service.upsert('bot', {
      expectedRevision: 'rev-1',
      config: { type: 'dingtalk', clientId: 'updated' },
    });
    expect(upserted.instance.config).toMatchObject({ clientId: 'updated' });
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');

    vi.mocked(manager.state).mockReturnValue(twoWorkers);
    const restarted = await service.restart('bot');
    expect(restarted.instance.runtime).toEqual({ state: 'connected' });

    vi.mocked(manager.state).mockReturnValue(twoWorkers);
    const removed = await service.remove('bot', {
      expectedRevision: 'rev-2',
    });
    expect(removed.snapshot.instances['bot']).toBeUndefined();
    expect(store.remove).toHaveBeenCalledOnce();
  });

  it('rejects mutations when two same-name workers run in the same workspace', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    const twoWorkers = {
      enabled: true,
      selection: { mode: 'names' as const, names: ['bot'] },
      transition: 'idle' as const,
      workers: [
        {
          enabled: true,
          state: 'running' as const,
          channels: ['bot'],
          requestedChannels: ['bot'],
          adapters: [{ name: 'bot', state: 'connected' as const }],
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
        {
          enabled: true,
          state: 'running' as const,
          channels: ['bot'],
          requestedChannels: ['bot'],
          adapters: [{ name: 'bot', state: 'connected' as const }],
          workspaceId: 'primary-dup',
          workspaceCwd: WORKSPACE,
          primary: false,
        },
      ],
    };
    vi.mocked(manager.state).mockReturnValue(twoWorkers);

    await expect(
      service.upsert('bot', {
        expectedRevision: 'rev-1',
        config: { type: 'dingtalk', clientId: 'updated' },
      }),
    ).rejects.toMatchObject({ code: 'channel_runtime_owner_mismatch' });

    vi.mocked(manager.state).mockReturnValue(twoWorkers);
    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_runtime_owner_mismatch',
    });

    vi.mocked(manager.state).mockReturnValue(twoWorkers);
    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({ code: 'channel_runtime_owner_mismatch' });

    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
  });

  it('rejects lifecycle operations for a nonexistent channel', async () => {
    const { service, manager } = setup({ committedNames: [] });

    await expect(service.restart('nonexistent')).rejects.toMatchObject({
      code: 'channel_instance_not_found',
    });
    await expect(service.start('nonexistent')).rejects.toMatchObject({
      code: 'channel_instance_not_found',
    });
    await expect(
      service.remove('nonexistent', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({ code: 'channel_instance_not_found' });
    await expect(service.stop('nonexistent')).rejects.toMatchObject({
      code: 'channel_instance_not_found',
    });
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
  });

  it('rejects setStartup for a nonexistent channel', async () => {
    const { service } = setup({ committedNames: [] });

    await expect(
      service.setStartup('nonexistent', {
        expectedRevision: 'rev-1',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'channel_instance_not_found' });
  });

  it('rejects approval of an unknown pairing code', async () => {
    const previousQwenHome = process.env['QWEN_HOME'];
    const qwenHome = await fs.mkdtemp(
      path.join(os.tmpdir(), 'channel-management-pairing-'),
    );
    process.env['QWEN_HOME'] = qwenHome;
    try {
      const { service } = setup({
        snapshot: settingsSnapshot({
          channels: {
            bot: { type: 'dingtalk', senderPolicy: 'pairing' },
          },
        }),
      });

      await expect(
        service.approvePairing('bot', 'ZZZZZZZZ'),
      ).rejects.toMatchObject({ code: 'channel_pairing_request_not_found' });
    } finally {
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      await fs.rm(qwenHome, { recursive: true, force: true });
    }
  });

  it('rejects pairing operations on a channel without pairing mode', async () => {
    for (const config of [
      { type: 'dingtalk', senderPolicy: 'open' },
      { type: 'dingtalk', senderPolicy: 'open', groupPolicy: 'allowlist' },
      { type: 'dingtalk', senderPolicy: 'open', groupPolicy: 'disabled' },
    ]) {
      const { service } = setup({
        snapshot: settingsSnapshot({
          channels: {
            bot: config,
          },
        }),
      });

      await expect(service.pairingRequests('bot')).rejects.toMatchObject({
        code: 'channel_pairing_not_enabled',
      });
      await expect(
        service.approvePairing('bot', 'ABCDEFGH'),
      ).rejects.toMatchObject({ code: 'channel_pairing_not_enabled' });
      await expect(service.pairingApprovals('bot')).rejects.toMatchObject({
        code: 'channel_pairing_not_enabled',
      });
      await expect(
        service.revokePairingApproval('bot', {
          type: 'user',
          id: 'sender-1',
        }),
      ).rejects.toMatchObject({ code: 'channel_pairing_not_enabled' });
    }
  });
});
