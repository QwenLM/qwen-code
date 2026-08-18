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
// clearStoppedRecord's fail-closed pre-read (R15-2) reads through
// `prune([])`: the mock mirrors the real tolerant-empty default and can
// be made to throw per-instance for the degraded-fs failure path.
const mockChannelStateStorePrune = vi.hoisted(() => vi.fn(() => ({})));
const defaultChannelStateStoreFactory = vi.hoisted(() =>
  // The constructor path is load-bearing input (R9-25): declare it so
  // per-instance implementations can read which file they serve.
  (_filePath: string) => ({
    readAll: vi.fn(() => ({})),
    prune: mockChannelStateStorePrune,
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
  }),
);
const mockChannelStateStore = vi.hoisted(() =>
  vi.fn(defaultChannelStateStoreFactory),
);

vi.mock('../commands/channel/channel-state-store.js', () => ({
  ChannelStateStore: mockChannelStateStore,
}));

import type { ChannelSettingsSnapshot } from './channel-settings-store.js';
import {
  createChannelManagementService,
  type ChannelManagementWorkerManager,
} from './channel-management-service.js';
import type { ChannelWorkerGroupSnapshot } from './channel-worker-group.js';
import { ChannelWorkerControlError } from './channel-worker-manager.js';

beforeEach(() => {
  mockChannelStateStore.mockClear();
  // Tests may install per-instance implementations (R9-25); mockClear
  // keeps the implementation, so reset it to the default factory or the
  // override leaks into every later test.
  mockChannelStateStore.mockImplementation(defaultChannelStateStoreFactory);
  // mockReset (not mockClear): clearAllMocks/mockClear do NOT drain
  // queued mockImplementationOnce/mockReturnValueOnce entries, so an
  // unconsumed once-entry left behind by a regression in a pinned path
  // would leak into the NEXT test's first call — mislocalizing the
  // failure or silently flipping results (R15-30). Reset drains the
  // queue; the defaults are re-applied immediately below.
  mockChannelStateStoreSet.mockReset();
  mockChannelStateStoreTrySetMany.mockReset();
  mockChannelStateStoreTrySetMany.mockReturnValue(true);
  mockChannelStateStorePrune.mockReset();
  mockChannelStateStorePrune.mockReturnValue({});
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
    // The stub's workers are never stripped, so the unstripped ownership
    // view can track state(): tests overriding state().workers propagate
    // to workerFor exactly like the real manager's raw snapshots do
    // (R10-1).
    ownershipSnapshots: vi.fn(
      () => manager.state().workers as ChannelWorkerGroupSnapshot[],
    ),
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

  it('clears a persisted stopped record before an active upsert reload (R17-5)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // A surviving `stopped` record (the statePersisted:false loss mode
    // this PR models) makes the reload's filtered resolve throw
    // channel_runtime_owner_mismatch, and upsert's fallback then STOPS
    // the live channel a config update should only reconfigure. Mirror
    // the start/restart entry points: clear before the reload.
    mockChannelStateStorePrune.mockReturnValue({ bot: 'stopped' });

    await service.upsert('bot', {
      expectedRevision: 'rev-1',
      config: { type: 'dingtalk', clientId: 'updated' },
    });

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'active');
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
    // The clear must happen BEFORE the reload: a clear after the resolve
    // still sees the surviving record and takes the fallback stop.
    const clearOrder = mockChannelStateStoreSet.mock.invocationCallOrder[0]!;
    const reloadOrder = vi.mocked(manager.reloadWorkspace).mock
      .invocationCallOrder[0]!;
    expect(clearOrder).toBeLessThan(reloadOrder);
  });

  it('rejects an active upsert when the stopped-record pre-read fails (R17-5)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Fail-closed like the start/restart entry points: an unknown-content
    // pre-read cannot rule out a surviving record, so the reload must not
    // run (R15-2).
    mockChannelStateStorePrune.mockImplementation(() => {
      throw new Error('EIO');
    });

    await expect(
      service.upsert('bot', {
        expectedRevision: 'rev-1',
        config: { type: 'dingtalk', clientId: 'updated' },
      }),
    ).rejects.toMatchObject({ code: 'channel_state_persist_failed' });

    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
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

  it('surfaces the enable commit loss on the start result (R16-2)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The manager's names-mode commit clears committed names' persisted
    // stopped records; when that clear fails it attaches the loss fields
    // (clearRecordsForCommit → clearLossFields). start() used to drop the
    // set result entirely — the loss never reached the client while the
    // surviving record lets the next reload-op resolve filter the
    // explicitly started channel out and permanently trim the committed
    // selection, and the {changed:false} early-return on a retried start
    // can never re-clear it.
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      statePersisted: false,
      statePersistFailedWorkspaces: [WORKSPACE],
    });

    const result = await service.start('bot');

    // The start succeeded, but the response must carry the loss like
    // stop()'s ChannelStopResult does — the route passes the service
    // result straight through to JSON, so the client's retry handle
    // rides this shape (#8975, R16-2).
    expect(result.instance.name).toBe('bot');
    expect(result.statePersisted).toBe(false);
    expect(result.statePersistFailedWorkspaces).toEqual([WORKSPACE]);
  });

  it('keeps the happy-path start shape free of the loss fields (R16-2)', async () => {
    const { service } = setup({ committedNames: [] });

    const result = await service.start('bot');

    // Only-on-failure: the happy-path response shape stays unchanged
    // (mirrors the stop-side convention).
    expect(result.instance.name).toBe('bot');
    expect(result).not.toHaveProperty('statePersisted');
    expect(result).not.toHaveProperty('statePersistFailedWorkspaces');
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
    // Per-instance capture: the shared trySetMany mock cannot correlate a
    // path with the names written through it, so a cross-group swap
    // (aux's names on the primary path or vice versa — exactly the bug
    // that resurrects a channel in the wrong workspace) ships green
    // against membership assertions. Record each store instance's writes
    // keyed by its constructor path (R9-25).
    const writesByPath = new Map<string, string[][]>();
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() => ({})),
      prune: vi.fn(() => ({})),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: vi.fn(() => true),
      trySetMany: vi.fn((names: string[], state: 'active' | 'stopped') => {
        if (state === 'stopped') {
          writesByPath.set(filePath, [
            ...(writesByPath.get(filePath) ?? []),
            [...names],
          ]);
        }
        return mockChannelStateStoreTrySetMany(names, state);
      }),
    }));

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
    // Each workspace's names land behind ITS workspace-derived path.
    expect(writesByPath.get(daemonChannelRuntimeStatePath(WORKSPACE))).toEqual([
      ['bot'],
    ]);
    expect(
      writesByPath.get(daemonChannelRuntimeStatePath('/ws/other')),
    ).toEqual([['aux']]);
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
    // Attribution names exactly the workspace whose write failed, so a
    // retry can target the affected channels (R14).
    expect(result.statePersistFailedWorkspaces).toEqual([WORKSPACE]);
  });

  it('unions the manager disable loss into the stop result (R17-4)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // The names-mode commit inside applySelection clears committed names'
    // persisted stopped records; a clear failure rides statePersisted /
    // statePersistFailedWorkspaces on the disable result — the loss a
    // sibling workspace's surviving record produces. stop() used to build
    // the response only from recordStopForName's own write failures, so
    // the loss never reached the client while the surviving record lets
    // the next reload-op resolve trim the committed selection. start()
    // surfaces the identical signal (R16-2).
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      statePersisted: false,
      statePersistFailedWorkspaces: ['/ws/other'],
    });

    const result = await service.stop('bot');

    expect(result.instance.name).toBe('bot');
    expect(result.statePersisted).toBe(false);
    expect(result.statePersistFailedWorkspaces).toEqual(['/ws/other']);
  });

  it('dedupes overlapping loss attribution on the stop result (R17-4)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Both loss sources name the SAME workspace: the manager's clear
    // failure and this name's own record write failure (the correlated
    // disk condition). The union must dedupe, or the retry handle lists
    // one workspace twice.
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      statePersisted: false,
      statePersistFailedWorkspaces: [WORKSPACE],
    });
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = await service.stop('bot');

    expect(result.statePersisted).toBe(false);
    expect(result.statePersistFailedWorkspaces).toEqual([WORKSPACE]);
  });

  it('records the requested name when the carried tear-down set excludes it (R14-4)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // The carried tear-down set only includes channels that CONNECTED at
    // least once (stoppedChannelsByWorkspace filters on the connected
    // set). When the requested channel never connected — here `bot` is
    // the last committed name and the connected sibling `aux` is the only
    // carried entry — the carried set is defined but excludes it. The
    // old ternary made the single-name fallback structurally unreachable
    // whenever the carried set existed: bot got no stopped record and
    // the next `--channel all` launched it — the explicit stop silently
    // undone. The supplementary write covers the gap.
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      stoppedChannels: [{ workspaceCwd: '/ws/other', names: ['aux'] }],
    });
    const writesByPath = new Map<string, string[][]>();
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() => ({})),
      prune: vi.fn(() => ({})),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: vi.fn((name: string, state: 'active' | 'stopped') => {
        if (state === 'stopped') {
          writesByPath.set(filePath, [
            ...(writesByPath.get(filePath) ?? []),
            [name],
          ]);
        }
        mockChannelStateStoreSet(name, state);
        return true;
      }),
      trySetMany: vi.fn((names: string[], state: 'active' | 'stopped') => {
        if (state === 'stopped') {
          writesByPath.set(filePath, [
            ...(writesByPath.get(filePath) ?? []),
            [...names],
          ]);
        }
        return mockChannelStateStoreTrySetMany(names, state);
      }),
    }));

    const result = await service.stop('bot');

    expect(result.instance.name).toBe('bot');
    // The carried group is persisted…
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['aux'],
      'stopped',
    );
    // …AND the requested name, absent from it, is still recorded through
    // the single-name fallback into THIS workspace's store.
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
    expect(writesByPath.get(daemonChannelRuntimeStatePath(WORKSPACE))).toEqual([
      ['bot'],
    ]);
    // Every write persisted, so the happy-path shape stays unchanged.
    expect(result).not.toHaveProperty('statePersisted');
  });

  it('surfaces the loss when the supplementary single-name write fails (R15-35)', async () => {
    // The combined shape the R14-4 twins leave untested: the carried set
    // EXISTS and excludes the requested name, AND the single-name fallback
    // write fails. A shape-conditional mutation (`if (!carried)
    // failed.push(target)`) keeps the write but drops the failure from
    // aggregation — stop() resolves a clean 200 with no loss indicator,
    // the requested channel gets no stopped record, and the next
    // `--channel all` resurrects it (probe-verified).
    const { service, manager } = setup({ committedNames: ['bot'] });
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      stoppedChannels: [{ workspaceCwd: '/ws/other', names: ['aux'] }],
    });
    // The carried-group write succeeds (trySetMany default true); the
    // single-name fallback write fails.
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = await service.stop('bot');

    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['aux'],
      'stopped',
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
    // The loss rides the success response.
    expect(result.statePersisted).toBe(false);
    expect(result.statePersistFailedWorkspaces).toEqual([WORKSPACE]);
  });

  it('records the requested name on the error path too when the carried set excludes it (R14-4)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Catch-branch twin: the lease-release failure shape carries the same
    // connected-only tear-down set; the requested never-connected name
    // must be recorded here as well.
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        stoppedChannels: [{ workspaceCwd: '/ws/other', names: ['aux'] }],
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });

    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['aux'],
      'stopped',
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('carries the loss on the rethrown error when the supplementary write fails (R15-35)', async () => {
    // Error-path twin of the combined shape: the catch branch persists the
    // carried group AND the excluded requested name best-effort; when the
    // single-name fallback write fails, the rethrown error must carry the
    // loss so the 502 body gives the client a retry handle (R14).
    const { service, manager } = setup({ committedNames: ['bot'] });
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        stoppedChannels: [{ workspaceCwd: '/ws/other', names: ['aux'] }],
      }),
    );
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
      statePersisted: false,
      statePersistFailedWorkspaces: [WORKSPACE],
    });
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
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
    // Per-instance write capture (R15-56): the constructor-path and
    // name-set membership assertions alone admit a cross-wiring (['aux']
    // into the primary file, ['bot'] into /ws/other) that records each
    // stop in the WRONG workspace — skipped where the channel never ran,
    // resurrected in its own. The success-path twin builds this capture
    // for exactly this reason; the error path must too.
    const writesByPath = new Map<string, string[][]>();
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() => ({})),
      prune: vi.fn(() => ({})),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: vi.fn(() => true),
      trySetMany: vi.fn((names: string[], state: 'active' | 'stopped') => {
        if (state === 'stopped') {
          writesByPath.set(filePath, [
            ...(writesByPath.get(filePath) ?? []),
            [...names],
          ]);
        }
        return mockChannelStateStoreTrySetMany(names, state);
      }),
    }));

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
    // Correspondence: each name-set landed in its OWN workspace's file.
    expect(writesByPath.get(daemonChannelRuntimeStatePath(WORKSPACE))).toEqual([
      ['bot'],
    ]);
    expect(
      writesByPath.get(daemonChannelRuntimeStatePath('/ws/other')),
    ).toEqual([['aux']]);
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
      // The rethrown error carries attribution too, so the management
      // route's 500 body can name the failed workspace (R14).
      statePersistFailedWorkspaces: [WORKSPACE],
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

  it('marks statePersisted false when the confirmed-dead stop record fails to persist (#8975)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
      }),
    );
    // The same disk condition that broke startup/rollback can also fail
    // this write: the boolean must be aggregated onto the rethrown error
    // like the sibling stoppedChannels branch, or the 502 body carries no
    // loss indicator, the client has no retry handle, and the channel
    // silently resurrects on the next `--channel all` (#8975).
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      statePersisted: false,
      // Single-name record: attribution names THIS workspace's canonical
      // form, the one whose write failed (R14).
      statePersistFailedWorkspaces: [path.resolve(WORKSPACE)],
    });

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
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

  it('does not persist the stop when the failed disable restored THIS workspace (R9-4)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // `rolledBack` is aggregate across workspaces: a multi-workspace
    // reconcile reports it false when ANY workspace's rollback restart
    // fails — even when THIS workspace's entry was restored and its
    // channel is relaunching. The per-workspace restore report
    // (restoredWorkspaces) is the load-bearing signal: keying on the
    // aggregate flag records a stop for a live channel, which the next
    // `--channel all` start then skips (R9-4).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
        restoredWorkspaces: [WORKSPACE, '/ws/other'],
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
    });

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreTrySetMany).not.toHaveBeenCalled();
  });

  it('persists the stop when the failed disable restored only another workspace (R9-4)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // The guard must be per-workspace, not blanket: when the aggregate
    // rolledBack is false because ANOTHER workspace's restore failed,
    // THIS workspace's entry was NOT restored and the channel stays
    // dead — the stop must still be recorded, or it resurrects on the
    // next `--channel all` start. A regression skipping every persist on
    // rolledBack:false (or matching the restored set loosely) turns this
    // red (R9-4).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
        restoredWorkspaces: ['/ws/other'],
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
    });

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('persists the stop when the failed disable ran no rollback at all (R9-4)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // A reconcile that failed BEFORE any rollback ran (the replacement
    // workers failed to stop, or the daemon is shutting down) carries no
    // restored set: the stopped entry stays dead and the record is
    // correct — the absence of restoredWorkspaces must not be read as
    // "restored" (R9-4).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
      }),
    );

    await expect(service.stop('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
    });

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
  });

  it('matches a restored workspace reported in canonical form (R9-4)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Divergent-canonical twin of the restoredHere tests above: group
    // entries carry CANONICAL cwds, so a symlinked workspace reports its
    // restore under the canonical form while the service opts carry the
    // raw path. The comparison must canonicalize BOTH sides — degrading
    // it to raw string equality misses the restore and records `stopped`
    // for a channel the rollback is relaunching, which the next
    // `--channel all` start then skips (#8975).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
        restoredWorkspaces: [`/canonical${WORKSPACE}`, '/ws/other'],
      }),
    );
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

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreTrySetMany).not.toHaveBeenCalled();
  });

  it('reports a crash-dead worker channel as error, not stopped (R9-5)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // A worker that crash-looped until its restart budget exhausted is
    // excluded from committedChannelNames() (so a per-channel start
    // relaunches it), but its channels must not REPORT as a clean user
    // stop: the async crash never populates diagnostics, and the budget
    // error on the worker is the only trace. runtimeFor must surface it
    // as an error with that diagnostic (R9-5).
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          lastConnectedChannels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    const result = await service.list();

    expect(result.instances['bot']?.runtime).toEqual({
      state: 'error',
      lastError: 'Channel worker restart budget exhausted.',
    });
  });

  it('restarts a crash-dead worker channel instead of rejecting it (R9-5)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // Same shape as the report test: restart is the natural recovery
    // route (reloadWorkspace replaces the dead entry and resets the
    // budget). The committed-names gate must let the terminal-failed
    // owner through, or start() is the only way back while the status
    // claims a clean stop (R9-5).
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    await service.restart('bot');

    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('finds a terminal worker whose channel rides only in lastRequestedChannels (R10-1)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The R10-1 production shape: selection [telegram, bot], bot's
    // connect fails persistently until the restart budget exhausts. The
    // terminal snapshot drops `requestedChannels`, keeps only the last
    // CONNECTED set in `channels`, and carries the attempted set solely
    // in `lastRequestedChannels` — which `state()` strips. Ownership
    // matching must read the unstripped view (ownershipSnapshots), or
    // the predicates are dead: runtimeFor reports a clean stop and
    // restart rejects with 409 instead of recovering via reloadWorkspace.
    //
    // Model the strip in the stub (R11-17): the default stub forwards the
    // SAME unstripped worker objects to both `state()` and
    // `ownershipSnapshots()`, so reverting `workerFor` to read
    // `state().workers` still matched `lastRequestedChannels` and shipped
    // green. In production `state()` returns publicWorkerSnapshot-stripped
    // workers (no `lastRequestedChannels`) while ownershipSnapshots keeps
    // them — split the two views so only the unstripped read matches.
    const unstrippedWorker = {
      enabled: true,
      state: 'failed' as const,
      channels: ['telegram'],
      lastRequestedChannels: ['telegram', 'bot'],
      error: 'Channel worker restart budget exhausted.',
      workspaceId: 'primary',
      workspaceCwd: WORKSPACE,
      primary: true,
    };
    const { lastRequestedChannels: _stripped, ...strippedWorker } =
      unstrippedWorker;
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['telegram', 'bot'] },
      transition: 'idle',
      workers: [strippedWorker],
    });
    vi.mocked(manager.ownershipSnapshots).mockReturnValue([
      unstrippedWorker,
    ] as never);

    const result = await service.list();

    expect(result.instances['bot']?.runtime).toEqual({
      state: 'error',
      lastError: 'Channel worker restart budget exhausted.',
    });

    await service.restart('bot');

    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('recovers a zero-carry mode-all worker that crash-exhausted its budget (R15-16)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The R15-16 reachable shape: a mode-`all` worker that reported ready
    // with ZERO channels (the zero-channel degrade) then crash-exhausted
    // its budget. The terminal snapshot carries NO channel names —
    // `channels`, `lastRequestedChannels` empty, `requestedChannels`/
    // `adapters` dropped — so every `workerFor` match clause misses and
    // the crash launders to a bare `stopped` unless terminalFailedWorkerFor
    // falls back to the empty-carry mode-`all` owner. Model the strip
    // (R11-17): `state()` strips `lastRequestedChannels`, the ownership
    // view keeps it.
    const unstrippedWorker = {
      enabled: true,
      state: 'failed' as const,
      channels: [] as string[],
      lastRequestedChannels: [] as string[],
      error: 'Channel worker restart budget exhausted.',
      workspaceId: 'primary',
      workspaceCwd: WORKSPACE,
      primary: true,
    };
    const { lastRequestedChannels: _stripped, ...strippedWorker } =
      unstrippedWorker;
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: [] },
      transition: 'idle',
      workers: [strippedWorker],
    });
    vi.mocked(manager.ownershipSnapshots).mockReturnValue([
      unstrippedWorker,
    ] as never);

    // The crash must surface the budget diagnostic, not a clean stop.
    const result = await service.list();
    expect(result.instances['bot']?.runtime).toEqual({
      state: 'error',
      lastError: 'Channel worker restart budget exhausted.',
    });

    // start() routes through the workspace reload (the recovery route),
    // not setChannelEnabled — which would collapse the mode-`all`
    // commitment to a single-name selection.
    await service.start('bot');
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
  });

  it('still rejects a restart when no worker owns the channel at all (R9-5)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The recovery gate is scoped to terminal-failed OWNERS: a channel
    // with no worker at all (never started) keeps the 409, or the gate
    // would silently route every uncommitted channel through
    // reloadWorkspace (R9-5).
    vi.mocked(manager.state).mockReturnValue({
      enabled: false,
      selection: null,
      transition: 'idle',
      workers: [],
    });

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_worker_not_enabled',
    });
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('clears a persisted stopped record before a crash-dead restart recovers (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // Same terminal-failed shape as the R9-5 recovery tests: the restart
    // reconciles the workspace with the still-committed selection, and a
    // mode-`all` relaunch's restore filter skips exactly the channels
    // carrying a `stopped` record. Seed that record in the daemon state
    // store: the restart must clear it BEFORE the reconcile, or it
    // resolves success while the channel stays down (#8975).
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() =>
        filePath === daemonChannelRuntimeStatePath(WORKSPACE)
          ? { bot: 'stopped' }
          : {},
      ),
      // clearStoppedRecord's fail-closed pre-read (R15-2) mirrors the
      // tolerant read result here.
      prune: vi.fn(() =>
        filePath === daemonChannelRuntimeStatePath(WORKSPACE)
          ? { bot: 'stopped' }
          : {},
      ),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: (name: string, state: 'active' | 'stopped') => {
        try {
          mockChannelStateStoreSet(name, state);
          return true;
        } catch {
          return false;
        }
      },
      trySetMany: mockChannelStateStoreTrySetMany,
    }));

    await service.restart('bot');

    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(WORKSPACE),
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'active');
    // The clear must land BEFORE the reconcile: a relaunched worker's
    // restore filter reads the record at launch, so a later write would
    // be too late (#8975).
    expect(mockChannelStateStoreSet).toHaveBeenCalledBefore(
      manager.reloadWorkspace,
    );
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('leaves a restart of a crash-dead channel without a stopped record untouched (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // No `stopped` record seeded: the clear is a read-only no-op there,
    // and a recovery that does not depend on the write must not fail on
    // it (#8975).
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    await service.restart('bot');

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('rejects a crash-dead restart when the stopped record cannot be cleared (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The record IS `stopped` and the clear fails (the same disk
    // condition that fails stops): failing loudly is the only honest
    // outcome — reporting a recovery the relaunched worker will not
    // honor would strand the channel down behind a 200 (#8975).
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() =>
        filePath === daemonChannelRuntimeStatePath(WORKSPACE)
          ? { bot: 'stopped' }
          : {},
      ),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: (name: string, state: 'active' | 'stopped') => {
        try {
          mockChannelStateStoreSet(name, state);
          return true;
        } catch {
          return false;
        }
      },
      // clearStoppedRecord's fail-closed pre-read (R15-2) mirrors the
      // tolerant read result here.
      prune: vi.fn(() =>
        filePath === daemonChannelRuntimeStatePath(WORKSPACE)
          ? { bot: 'stopped' }
          : {},
      ),
      trySetMany: mockChannelStateStoreTrySetMany,
    }));
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_state_persist_failed',
    });

    // The reconcile must not run once the clear failed.
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('rejects a crash-dead start when the clear pre-read itself fails (R16-33)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The fail-closed pre-read branch: `prune([])` throws on a
    // non-ENOENT READ failure, leaving the record UNKNOWN. Degrading
    // that to the tolerant path (readAll / catch-empty) would skip the
    // clear, the recovery would resolve 200, and the relaunched worker's
    // restore filter would skip the channel carrying the surviving
    // stopped record — the R15-2 hazard. Pin the rejection AND the
    // skipped reconcile for a throwing prune.
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() => ({})),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: vi.fn(() => true),
      prune: vi.fn(() => {
        if (filePath === daemonChannelRuntimeStatePath(WORKSPACE)) {
          const error = new Error('EIO: i/o error') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return {};
      }),
      trySetMany: mockChannelStateStoreTrySetMany,
    }));

    await expect(service.start('bot')).rejects.toMatchObject({
      code: 'channel_state_persist_failed',
    });

    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('rejects a crash-dead restart when the clear pre-read itself fails (R16-33)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // Restart twin of the start-side pre-read pin: both recovery routes
    // share clearStoppedRecord, but each entry point must fail closed.
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() => ({})),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: vi.fn(() => true),
      prune: vi.fn(() => {
        if (filePath === daemonChannelRuntimeStatePath(WORKSPACE)) {
          const error = new Error('EIO: i/o error') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return {};
      }),
      trySetMany: mockChannelStateStoreTrySetMany,
    }));

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_state_persist_failed',
    });

    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('still recovers a crash-dead channel under divergent canonical forms (R9-5)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // Divergent-canonical twin of the R9-5 recovery tests: the terminal
    // worker carries the CANONICAL workspaceCwd (a symlinked workspace)
    // while the service opts carry the raw path. terminalFailedWorkerFor
    // must canonicalize both sides — degrading it to raw string equality
    // misses the dead owner, so the crash-dead channel keeps the 409
    // instead of recovering through reloadWorkspace (#8975).
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: `/canonical${WORKSPACE}`,
          primary: true,
        },
      ],
    });
    mockCanonicalizeWorkspace.mockImplementation((p: string) =>
      p === WORKSPACE ? `/canonical${WORKSPACE}` : path.resolve(p),
    );

    try {
      await service.restart('bot');
    } finally {
      mockCanonicalizeWorkspace.mockImplementation((p: string) =>
        path.resolve(p),
      );
    }

    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('builds the restart clear store from the canonical workspace under divergent forms (R14)', async () => {
    // Divergent-canonical twin of the restart clear pin: with a
    // symlinked workspace the daemon state file lives under the
    // CANONICAL path's hash. Constructing the clear store from the raw
    // opts path reads/writes a DIFFERENT file than the one the stop
    // record was persisted under — the clear misses, the R14 reload
    // filter (and a mode-`all` relaunch's restore filter) still sees
    // `stopped`, and the recovery resolves while the channel stays down.
    // The recovery test above pins the RECONCILE side; this pins the
    // STORE derivation side of the same hazard (R9-17 doctrine:
    // argument-sensitive path mocks make the split observable).
    const { service, manager } = setup({ committedNames: [] });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: `/canonical${WORKSPACE}`,
          primary: true,
        },
      ],
    });
    mockCanonicalizeWorkspace.mockImplementation((p: string) =>
      p === WORKSPACE ? `/canonical${WORKSPACE}` : path.resolve(p),
    );
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() =>
        filePath === daemonChannelRuntimeStatePath(`/canonical${WORKSPACE}`)
          ? { bot: 'stopped' }
          : {},
      ),
      // clearStoppedRecord's fail-closed pre-read (R15-2) mirrors the
      // tolerant read result here.
      prune: vi.fn(() =>
        filePath === daemonChannelRuntimeStatePath(`/canonical${WORKSPACE}`)
          ? { bot: 'stopped' }
          : {},
      ),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: (name: string, state: 'active' | 'stopped') => {
        try {
          mockChannelStateStoreSet(name, state);
          return true;
        } catch {
          return false;
        }
      },
      trySetMany: mockChannelStateStoreTrySetMany,
    }));

    try {
      await service.restart('bot');
    } finally {
      mockCanonicalizeWorkspace.mockImplementation((p: string) =>
        path.resolve(p),
      );
    }

    // The store is constructed with the CANONICAL-derived path, and the
    // clear landed on the seeded file before the reconcile.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(`/canonical${WORKSPACE}`),
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'active');
    expect(mockChannelStateStoreSet).toHaveBeenCalledBefore(
      manager.reloadWorkspace,
    );
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('clears the retained crash diagnostic when a crash-dead start recovers (R14)', async () => {
    // The start/restart crash-dead routes retain a reconcile failure as
    // the channel's runtime diagnostic; without lifecycle pins a
    // delete/re-retain regression reads green through the error path
    // alone. First attempt rejects and seeds the diagnostic; the second
    // recovers and list() must report the channel connected again — a
    // stale retained error would keep claiming a crash that is gone.
    const { service, manager } = setup({ committedNames: [] });
    const deadWorker = {
      enabled: true,
      state: 'failed' as const,
      channels: ['bot'],
      error: 'Channel worker restart budget exhausted.',
      workspaceId: 'primary',
      workspaceCwd: WORKSPACE,
      primary: true,
    };
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [deadWorker],
    });
    manager.reloadWorkspace.mockRejectedValueOnce(
      Object.assign(new Error('workspace settings exploded'), {
        code: 'channel_worker_start_failed',
      }),
    );

    await expect(service.start('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
    });
    expect((await service.list()).instances['bot']?.runtime).toMatchObject({
      state: 'error',
      lastError: expect.stringContaining('workspace settings exploded'),
    });

    // The worker recovers on the second attempt.
    vi.mocked(manager.committedChannelNames).mockReturnValue(['bot']);
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          ...deadWorker,
          state: 'running' as const,
          error: undefined,
          requestedChannels: ['bot'],
          adapters: [{ name: 'bot', state: 'connected' as const }],
        },
      ],
    });

    await service.start('bot');

    expect((await service.list()).instances['bot']?.runtime).toEqual({
      state: 'connected',
    });
  });

  it('replaces the retained diagnostic when a crash-dead recovery rejects again (R14)', async () => {
    // A recovery that fails AGAIN must replace the retained diagnostic
    // with the latest failure — a set-once regression leaves the stale
    // first error as the only trace of the current state.
    const { service, manager } = setup({ committedNames: [] });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });
    manager.reloadWorkspace.mockRejectedValueOnce(
      Object.assign(new Error('first failure'), {
        code: 'channel_worker_start_failed',
      }),
    );

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
    });
    expect((await service.list()).instances['bot']?.runtime).toMatchObject({
      state: 'error',
      lastError: expect.stringContaining('first failure'),
    });

    manager.reloadWorkspace.mockRejectedValueOnce(
      Object.assign(new Error('second failure'), {
        code: 'channel_worker_start_failed',
      }),
    );

    await expect(service.start('bot')).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
    });
    expect((await service.list()).instances['bot']?.runtime).toMatchObject({
      state: 'error',
      lastError: expect.stringContaining('second failure'),
    });
  });

  it('records a confirmed stop during a starting window (R9-27)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The starting-window guard only rejects an UNCONFIRMABLE stop
    // (changed: false); a CONFIRMED stop (changed: true) resolves and
    // persists even mid-window — the changed:true shape on a starting
    // mode-all worker has no test otherwise, and a regression folding
    // the two shapes together (409 on any starting-window stop) would
    // strand a successfully stopped channel with no record (R9-27).
    manager.setChannelEnabled.mockResolvedValueOnce({ changed: true });
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

    const result = await service.stop('bot');

    expect(result.instance.name).toBe('bot');
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
    expect(result).not.toHaveProperty('statePersisted');
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
    // …together with the R14 attribution field on the single-name path:
    // production sets both together; a mutation dropping or mis-sourcing
    // the single-name attribution ships green without this pin (the
    // group-path pin above only catches the shared-spread variant),
    // leaving the client's targeted retry unaimable at the affected
    // workspace (R14-32).
    expect(result.statePersistFailedWorkspaces).toEqual([
      path.resolve(WORKSPACE),
    ]);
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

  it('rejects an unconfirmable stop while a failed worker still has a restart scheduled (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // The non-terminal side of the guard's failure clause: a crashed
    // worker with restart budget remaining (`state: 'failed'` but
    // `nextRestartAt` DEFINED) relaunches after the delay window and can
    // reconnect the channel — an unconfirmable stop recorded now would
    // be overwritten by it. Only the budget-exhausted terminal shape
    // (nextRestartAt undefined, pinned by the permanently-failed test
    // below) may record stops; collapsing the predicate to treat every
    // failed worker as terminal ships green without this pin and turns
    // the scheduled-restart window into a false 200 (R11-v4).
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
          nextRestartAt: new Date(Date.now() + 5000).toISOString(),
          error: 'Channel worker crashed; restarting.',
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
    // mode-`all` worker must not block this workspace's stop; with no
    // starting worker in THIS workspace to overwrite the record, the stop
    // is confirmable here and IS recorded (the guard compares canonical
    // workspaces, and a sibling workspace's worker reads/writes a
    // different per-workspace state file). Dropping the workspace
    // comparison from the guard turns this into a 409. (R14-14: the old
    // comment clause "nor let an unconfirmable stop persist" contradicted
    // the pinned behavior below.)
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

  it('keeps the starting-window guard actionable under divergent canonical forms (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // Divergent-canonical twin of the starting-window tests: the
    // starting worker carries the CANONICAL workspaceCwd (a symlinked
    // workspace) while the service opts carry the raw path. The guard
    // must canonicalize both sides — degrading it to raw string equality
    // misses the starting worker, so an unconfirmable stop gets recorded
    // instead of the 409, and the relaunching worker overwrites the
    // record (#8975).
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
          workspaceCwd: `/canonical${WORKSPACE}`,
          primary: true,
        },
      ],
    });
    mockCanonicalizeWorkspace.mockImplementation((p: string) =>
      p === WORKSPACE ? `/canonical${WORKSPACE}` : path.resolve(p),
    );

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
    // Seed a persisted stopped record (R14-15): the default empty store
    // mock makes a clear-before-gate reorder unobservable (clearStoppedRecord
    // early-returns when the record is not `stopped`). With the record
    // seeded, moving the clear above the gate would flip it to `active`
    // on a REJECTED 409 restart — resurrecting exactly the explicitly
    // stopped channel this PR keeps stopped.
    mockChannelStateStore.mockImplementation((_filePath: string) => ({
      readAll: vi.fn(() => ({ bot: 'stopped' })),
      // clearStoppedRecord's fail-closed pre-read (R15-2) mirrors the
      // seeded record; the gate rejects before the clear runs (R14-15).
      prune: vi.fn(() => ({ bot: 'stopped' })),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: vi.fn((name: string, state: 'active' | 'stopped') => {
        mockChannelStateStoreSet(name, state);
        return true;
      }),
      trySetMany: mockChannelStateStoreTrySetMany,
    }));

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_worker_not_enabled',
    });
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
  });

  it('rejects restart of a configured channel that is not enabled', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // Seeded-record twin of the pin above (R14-15).
    mockChannelStateStore.mockImplementation((_filePath: string) => ({
      readAll: vi.fn(() => ({ bot: 'stopped' })),
      // clearStoppedRecord's fail-closed pre-read (R15-2) mirrors the
      // seeded record; the gate rejects before the clear runs (R14-15).
      prune: vi.fn(() => ({ bot: 'stopped' })),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: vi.fn((name: string, state: 'active' | 'stopped') => {
        mockChannelStateStoreSet(name, state);
        return true;
      }),
      trySetMany: mockChannelStateStoreTrySetMany,
    }));

    await expect(service.restart('bot')).rejects.toMatchObject({
      code: 'channel_worker_not_enabled',
    });
    expect(manager.reloadWorkspace).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
  });

  it('routes a per-channel start of a crash-dead worker channel through the workspace reload (#8975)', async () => {
    const { service, manager } = setup({ committedNames: [] });
    // Terminal-failed shape (same fixture as the R9-5 restart tests):
    // the dead worker's names are excluded from committedChannelNames(),
    // so the enable path would rebuild the GLOBAL selection from the
    // filtered committed names — collapsing a mode-`all` commitment to
    // names-mode, relaunching healthy workspaces' live workers and
    // laundering the crash diagnostic into a clean `stopped`. The start
    // must take the workspace-scoped reload route restart() uses instead,
    // leaving the committed selection intact (#8975).
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    await service.start('bot');

    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
  });

  it('clears a persisted stopped record before a crash-dead start recovers (R14)', async () => {
    // Start-door twin of the restart clear pin (#8975): the crash-dead
    // start route shares the recovery branch, so the seeded-stopped-record
    // shape must be pinned here too — without a twin, deleting the clear
    // from start() alone (while restart() keeps it) ships green, and an
    // explicitly stopped channel recovered through START reconnects
    // against the recorded stop.
    const { service, manager } = setup({ committedNames: [] });
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'failed',
          channels: ['bot'],
          error: 'Channel worker restart budget exhausted.',
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() =>
        filePath === daemonChannelRuntimeStatePath(WORKSPACE)
          ? { bot: 'stopped' }
          : {},
      ),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      // clearStoppedRecord's fail-closed pre-read (R15-2) mirrors the
      // tolerant read result here.
      prune: vi.fn(() =>
        filePath === daemonChannelRuntimeStatePath(WORKSPACE)
          ? { bot: 'stopped' }
          : {},
      ),
      trySet: (name: string, state: 'active' | 'stopped') => {
        try {
          mockChannelStateStoreSet(name, state);
          return true;
        } catch {
          return false;
        }
      },
      trySetMany: mockChannelStateStoreTrySetMany,
    }));

    await service.start('bot');

    expect(mockChannelStateStore).toHaveBeenCalledWith(
      daemonChannelRuntimeStatePath(WORKSPACE),
    );
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'active');
    // The clear must land BEFORE the reconcile, twin of the restart
    // pin: the R14 reload-selection filter reads the record at resolve
    // time, so a later write would drop the requested name from the
    // recovery target (#8975, R14).
    expect(mockChannelStateStoreSet).toHaveBeenCalledBefore(
      manager.reloadWorkspace,
    );
    expect(manager.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
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

  it('stops a terminal-failed worker channel on remove so the name does not ghost the committed selection (R15-17)', async () => {
    // Symptom 1 (ghost): a terminal-failed worker's channels are excluded
    // from workspaceCommittedNames() (the start/recovery contract), so the
    // remove gate — keyed only on that filtered view — skipped the stop and
    // left the removed name a ghost in the committed selection, failing
    // every later reload-op resolve. Gate on the source of truth too: the
    // dead worker still owns the name, so the stop (and its disable
    // re-commit) must run to trim it.
    const { service, manager, store } = setup({ committedNames: [] });
    const unstrippedWorker = {
      enabled: true,
      state: 'failed' as const,
      channels: ['bot'],
      lastRequestedChannels: ['bot'],
      error: 'Channel worker restart budget exhausted.',
      workspaceId: 'primary',
      workspaceCwd: WORKSPACE,
      primary: true,
    };
    const { lastRequestedChannels: _stripped, ...strippedWorker } =
      unstrippedWorker;
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'names', names: ['bot'] },
      transition: 'idle',
      workers: [strippedWorker],
    });
    vi.mocked(manager.ownershipSnapshots).mockReturnValue([
      unstrippedWorker,
    ] as never);

    // Not committed in the filtered view — the ghost condition.
    expect(manager.committedChannelNames()).toEqual([]);

    await service.remove('bot', { expectedRevision: 'rev-1' });

    // The stop ran despite the filtered-view miss, trimming the ghost,
    // and the channel was removed from settings.
    expect(manager.setChannelEnabled).toHaveBeenCalledWith(
      { name: 'bot', workspaceCwd: WORKSPACE },
      false,
    );
    expect(store.remove).toHaveBeenCalledOnce();
  });

  it('persists the whole-selection tear-down set on the remove() path (R16-16)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Removing the LAST committed channel empties the selection and
    // routes through the whole-selection stop, whose result carries the
    // per-workspace tear-down set. remove() used to discard the result
    // entirely — the only whole-selection tear-down site that never
    // persisted — so the removed channels resurrected on the next
    // `--channel all` start (#8975, R16-16).
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      stoppedChannels: [
        { workspaceCwd: WORKSPACE, names: ['bot'] },
        { workspaceCwd: '/ws/other', names: ['aux'] },
      ],
    });
    // Per-instance capture keyed by constructor path, twin of the stop()
    // success-path test (R9-25): membership alone cannot catch a
    // cross-group swap.
    const writesByPath = new Map<string, string[][]>();
    mockChannelStateStore.mockImplementation((filePath: string) => ({
      readAll: vi.fn(() => ({})),
      prune: vi.fn(() => ({})),
      set: mockChannelStateStoreSet,
      setMany: vi.fn(),
      trySet: vi.fn(() => true),
      trySetMany: vi.fn((names: string[], state: 'active' | 'stopped') => {
        if (state === 'stopped') {
          writesByPath.set(filePath, [
            ...(writesByPath.get(filePath) ?? []),
            [...names],
          ]);
        }
        return mockChannelStateStoreTrySetMany(names, state);
      }),
    }));

    await service.remove('bot', { expectedRevision: 'rev-1' });

    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['bot'],
      'stopped',
    );
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['aux'],
      'stopped',
    );
    expect(writesByPath.get(daemonChannelRuntimeStatePath(WORKSPACE))).toEqual([
      ['bot'],
    ]);
    expect(
      writesByPath.get(daemonChannelRuntimeStatePath('/ws/other')),
    ).toEqual([['aux']]);
    // The carried set covers the requested name here, so no
    // supplementary single-name write rides alongside it (R14).
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
  });

  it('persists the carried tear-down set when remove()s stop fails after tear-down (R16-16)', async () => {
    const { service, manager, store } = setup({ committedNames: ['bot'] });
    // The error variant: stopSelectionNow rejects AFTER the tear-down
    // (lease-release failure) carrying the captured set on the error.
    // remove() used to propagate with no catch — nothing persisted AND
    // the config entry not removed — so every torn-down channel
    // resurrected (#8975, R16-16).
    vi.mocked(manager.setChannelEnabled).mockRejectedValueOnce(
      new ChannelWorkerControlError(
        'channel_worker_stop_failed',
        'lease release failed',
        {
          stoppedChannels: [
            { workspaceCwd: WORKSPACE, names: ['bot'] },
            { workspaceCwd: '/ws/other', names: ['aux'] },
          ],
        },
      ),
    );

    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({ code: 'channel_worker_stop_failed' });

    // The carried set persisted before the rethrow, both groups under
    // their own workspace paths.
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['bot'],
      'stopped',
    );
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledWith(
      ['aux'],
      'stopped',
    );
    // …and the config entry stays put on the failed stop.
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('reports statePersisted false when the remove() stop record fails to persist (R17-2)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // remove() used to discard recordStopForName's return — the only one
    // of its call sites that did — so a persistence failure during
    // deletion returned a clean 200 with no loss signal and no retry
    // handle: a re-issued remove finds the group already cleared and can
    // never re-record, and the next `--channel all` resurrects exactly
    // the channels #8975 must keep stopped. Surface it like stop()'s
    // success path does.
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      stoppedChannels: [
        { workspaceCwd: WORKSPACE, names: ['bot'] },
        { workspaceCwd: '/ws/other', names: ['aux'] },
      ],
    });
    mockChannelStateStoreTrySetMany.mockReturnValueOnce(false);

    const result = await service.remove('bot', { expectedRevision: 'rev-1' });

    expect(result.instance.name).toBe('bot');
    // The second group must still be attempted before reporting the loss.
    expect(mockChannelStateStoreTrySetMany).toHaveBeenCalledTimes(2);
    expect(result.statePersisted).toBe(false);
    expect(result.statePersistFailedWorkspaces).toEqual([WORKSPACE]);
  });

  it('keeps the happy-path remove shape free of the loss fields (R17-2)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      stoppedChannels: [{ workspaceCwd: WORKSPACE, names: ['bot'] }],
    });

    const result = await service.remove('bot', { expectedRevision: 'rev-1' });

    // Only-on-failure: the happy-path response shape stays unchanged,
    // mirroring the stop/start convention.
    expect(result.instance.name).toBe('bot');
    expect(result).not.toHaveProperty('statePersisted');
    expect(result).not.toHaveProperty('statePersistFailedWorkspaces');
  });

  it('unions the manager disable loss into the remove result (R18-2)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Mirrors the stop() R17-4 union: a disable routed through the
    // names-mode commit clears committed names' persisted stopped records,
    // and a clear failure rides statePersisted / statePersistFailedWorkspaces
    // on the disable result. remove() used to read only recordStopForName's
    // own write failures, so a sibling workspace's surviving record trimmed
    // the committed selection on the next reload-op with no loss signal
    // (R18-2).
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      statePersisted: false,
      statePersistFailedWorkspaces: ['/ws/other'],
    });

    const result = await service.remove('bot', { expectedRevision: 'rev-1' });

    expect(result.instance.name).toBe('bot');
    expect(result.statePersisted).toBe(false);
    expect(result.statePersistFailedWorkspaces).toEqual(['/ws/other']);
  });

  it('dedupes overlapping loss attribution on the remove result (R18-2)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Both loss sources name the SAME workspace (the correlated disk
    // condition): the manager's clear failure and this name's own record
    // write failure. The union must dedupe, or the retry handle lists one
    // workspace twice. Mirrors stop()'s R17-4 dedupe test.
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
      statePersisted: false,
      statePersistFailedWorkspaces: [WORKSPACE],
    });
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = await service.remove('bot', { expectedRevision: 'rev-1' });

    expect(result.statePersisted).toBe(false);
    expect(result.statePersistFailedWorkspaces).toEqual([WORKSPACE]);
  });

  it('rejects remove() with channel_worker_starting during the workspace worker starting window (R20-2)', async () => {
    const { service, store, manager } = setup({ committedNames: [] });
    // A mode-`all` worker between launch and first ready owns no names
    // the stop gate can see: committedChannelNames() skips the `['all']`
    // placeholder and every workerFor clause misses a pre-ready snapshot
    // (requestedChannels undefined). remove() used to skip stopChannel
    // and commit the deletion while the in-flight worker connects the
    // removed channel — a live channel with no config, unmanageable
    // (stop/remove throw channel_instance_not_found) until a global
    // reconcile. stop() rejects the identical shape with a 409; remove()
    // must mirror it.
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'all' },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'starting',
          channels: ['all'],
          requestedChannels: undefined,
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({ code: 'channel_worker_starting' });

    // The deletion must not commit in the starting window.
    expect(store.remove).not.toHaveBeenCalled();
    expect(manager.setChannelEnabled).not.toHaveBeenCalled();
  });

  it('lets remove() stop a committed name during a crash-restart window (R20-2)', async () => {
    const { service, store, manager } = setup({ committedNames: ['bot'] });
    // The guard rejects only UNCOMMITTED names: a crash-restarting
    // mode-`all` worker is "starting" (its relaunch may connect any
    // configured channel), but a name it carries IS committed, so its
    // confirmable stop still routes through the gate below the guard.
    vi.mocked(manager.state).mockReturnValue({
      enabled: true,
      selection: { mode: 'all' },
      transition: 'idle',
      workers: [
        {
          enabled: true,
          state: 'starting',
          channels: ['all'],
          requestedChannels: ['bot'],
          lastRequestedChannels: ['bot'],
          workspaceId: 'primary',
          workspaceCwd: WORKSPACE,
          primary: true,
        },
      ],
    });

    const result = await service.remove('bot', { expectedRevision: 'rev-1' });

    expect(result.instance.name).toBe('bot');
    expect(manager.setChannelEnabled).toHaveBeenCalledWith(
      { name: 'bot', workspaceCwd: WORKSPACE },
      false,
    );
    expect(store.remove).toHaveBeenCalledTimes(1);
  });

  it('carries the stop-record loss when the remove() settings write throws (R20-4)', async () => {
    const { service, manager, store } = setup({ committedNames: ['bot'] });
    // The stop succeeds but its `stopped` record fails to persist
    // (degraded disk), and the settings deletion ALSO throws: remove()
    // used to let the bare settings error propagate without the
    // already-computed loss — the stop has already cleared the group and
    // committed the trimmed selection, so a retried remove skips the
    // whole stop block and returns clean success, the loss is never
    // re-recordable, and the next `--channel all` resurrects the
    // explicitly stopped channels (the #8975 regression). The rethrown
    // error must carry the loss like stopChannel's catch branches do.
    vi.mocked(manager.setChannelEnabled).mockResolvedValueOnce({
      changed: true,
    });
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const settingsError = new Error('ENOSPC: settings write failed');
    vi.mocked(store.remove).mockRejectedValueOnce(settingsError);

    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({
      code: 'channel_state_persist_failed',
      statePersisted: false,
      statePersistFailedWorkspaces: [WORKSPACE],
      cause: settingsError,
    });
  });

  it('rethrows a bare settings error unchanged when no stop-record loss is pending (R20-4)', async () => {
    const { service, store } = setup({ committedNames: ['bot'] });
    // No pending loss (the stop record persisted fine): the original
    // settings error keeps its identity — wrapping applies only to the
    // loss-carrying shape.
    const settingsError = new Error('ENOSPC: settings write failed');
    vi.mocked(store.remove).mockRejectedValueOnce(settingsError);

    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toBe(settingsError);
  });

  it('persists the stop when remove() fails with a confirmed-dead disable (R17-6)', async () => {
    const { service, manager, store } = setup({ committedNames: ['bot'] });
    // The per-channel disable via applySelection stopped the worker
    // entry, the replacement selection failed to start, and the rollback
    // restart also failed (rolledBack: false, no stoppedChannels set):
    // the channel is confirmed dead. remove()'s catch used to mirror only
    // stop()'s FIRST catch branch, so nothing persisted — the failed
    // DELETE leaves the channel configured, and the next `--channel all`
    // restarts it, silently undoing the tear-down the DELETE performed.
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
      }),
    );

    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({ code: 'channel_worker_start_failed' });

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('bot', 'stopped');
    // …and the config entry stays put on the failed stop.
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('marks the rethrown remove() error when the confirmed-dead record fails to persist (R17-6)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
      }),
    );
    // The same disk condition that broke startup/rollback can also fail
    // this write: the 502 body must carry the loss or the client has no
    // retry handle.
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      statePersisted: false,
      statePersistFailedWorkspaces: [path.resolve(WORKSPACE)],
    });
  });

  it('does not persist the remove() stop when the failed disable restored THIS workspace (R17-6)', async () => {
    const { service, manager } = setup({ committedNames: ['bot'] });
    // Same restoredWorkspaces guard as stop(): `rolledBack` is aggregate
    // across workspaces — an entry restored in THIS workspace is
    // relaunching, so recording `stopped` would skip a live channel on
    // the next `--channel all` start (R9-4).
    manager.setChannelEnabled.mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_start_failed', 'boom', {
        rolledBack: false,
        restoredWorkspaces: [WORKSPACE],
      }),
    );

    await expect(
      service.remove('bot', { expectedRevision: 'rev-1' }),
    ).rejects.toMatchObject({ code: 'channel_worker_start_failed' });

    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreTrySetMany).not.toHaveBeenCalled();
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
