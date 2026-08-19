/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelWorkerGroup,
  ChannelWorkerGroupSnapshot,
} from './channel-worker-group.js';
import { ChannelWorkerReconcileError } from './channel-worker-group.js';
import {
  ChannelWorkerControlError,
  createChannelWorkerManager,
} from './channel-worker-manager.js';
import { ChannelWorkerStartupError } from './channel-worker-supervisor.js';
import type { ChannelWorkspaceGroup } from './channel-workspace-grouping.js';
import type { ServeChannelSelection } from './types.js';

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

const PRIMARY = '/ws/primary';
const SECONDARY = '/ws/secondary';

function workspaceGroups(
  selection: ServeChannelSelection,
): ChannelWorkspaceGroup[] {
  return [{ workspaceCwd: PRIMARY, selection }];
}

function splitWorkspaceGroups(
  selection: ServeChannelSelection,
): ChannelWorkspaceGroup[] {
  if (selection.mode === 'all') {
    return [
      { workspaceCwd: PRIMARY, selection },
      { workspaceCwd: SECONDARY, selection },
    ];
  }
  const primary = selection.names.filter(
    (name) => !name.startsWith('secondary-'),
  );
  const secondary = selection.names.filter((name) =>
    name.startsWith('secondary-'),
  );
  return [
    ...(primary.length > 0
      ? [
          {
            workspaceCwd: PRIMARY,
            selection: { mode: 'names' as const, names: primary },
          },
        ]
      : []),
    ...(secondary.length > 0
      ? [
          {
            workspaceCwd: SECONDARY,
            selection: { mode: 'names' as const, names: secondary },
          },
        ]
      : []),
  ];
}

function workerSnapshot(
  overrides: Partial<ChannelWorkerGroupSnapshot> = {},
): ChannelWorkerGroupSnapshot {
  return {
    enabled: true,
    state: 'running',
    channels: ['telegram'],
    requestedChannels: ['telegram'],
    workspaceId: 'primary',
    workspaceCwd: PRIMARY,
    primary: true,
    ...overrides,
  };
}

function fakeGroup(
  overrides: Partial<ChannelWorkerGroup> = {},
): ChannelWorkerGroup {
  const snapshots = [workerSnapshot()];
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    reconcile: vi.fn(async () => ({ changed: true, workers: snapshots })),
    isHealthy: vi.fn(() =>
      snapshots.every((worker) => worker.state === 'running'),
    ),
    killAllSync: vi.fn(),
    snapshots: vi.fn(() => snapshots),
    primarySnapshot: vi.fn(() => snapshots[0]!),
    beginWorkspaceDrain: vi.fn(),
    cancelWorkspaceDrain: vi.fn(),
    workspaceActivity: vi.fn(() => 0),
    removeWorkspace: vi.fn(async () => {}),
    restoreWorkspace: vi.fn(async () => {}),
    deliverChannelMessage: vi.fn(async () => ({ delivered: true as const })),
    enqueueWebhookTask: vi.fn(async () => ({ accepted: true as const })),
    ...overrides,
  };
}

function setup(group = fakeGroup()) {
  const reserveLease = vi.fn();
  const releaseLease = vi.fn();
  const onCommittedSelection = vi.fn();
  const onStateChange = vi.fn();
  const resolveGroups = vi.fn(async (selection: ServeChannelSelection) =>
    workspaceGroups(selection),
  );
  const createGroup = vi.fn(() => group);
  const manager = createChannelWorkerManager({
    resolveGroups,
    createGroup,
    reserveLease,
    releaseLease,
    onCommittedSelection,
    onStateChange,
  });
  return {
    manager,
    group,
    reserveLease,
    releaseLease,
    resolveGroups,
    createGroup,
    onCommittedSelection,
    onStateChange,
  };
}

describe('createChannelWorkerManager', () => {
  it('exposes committed channel names in selection order', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram', 'feishu'],
    };

    expect(test.manager.committedChannelNames()).toEqual([]);
    await test.manager.setSelection(selection);

    const names = test.manager.committedChannelNames();
    expect(names).toEqual(['telegram', 'feishu']);
    names.reverse();
    expect(test.manager.committedChannelNames()).toEqual([
      'telegram',
      'feishu',
    ]);
  });

  it('serializes concurrent owner-scoped channel starts', async () => {
    const test = setup();
    const manager = test.manager;
    test.resolveGroups.mockImplementation(async (selection) =>
      splitWorkspaceGroups(selection),
    );
    await manager.setSelection({ mode: 'names', names: ['telegram'] });

    await Promise.all([
      manager.setChannelEnabled(
        { name: 'primary-bot', workspaceCwd: PRIMARY },
        true,
      ),
      manager.setChannelEnabled(
        { name: 'secondary-bot', workspaceCwd: SECONDARY },
        true,
      ),
    ]);

    expect(manager.committedChannelNames()).toEqual([
      'telegram',
      'primary-bot',
      'secondary-bot',
    ]);
  });

  it('serializes an owner-scoped start with a concurrent stop', async () => {
    const test = setup();
    const manager = test.manager;
    test.resolveGroups.mockImplementation(async (selection) =>
      splitWorkspaceGroups(selection),
    );
    await manager.setSelection({ mode: 'names', names: ['telegram'] });

    await Promise.all([
      manager.setChannelEnabled(
        { name: 'secondary-bot', workspaceCwd: SECONDARY },
        true,
      ),
      manager.setChannelEnabled(
        { name: 'telegram', workspaceCwd: PRIMARY },
        false,
      ),
    ]);

    expect(manager.committedChannelNames()).toEqual(['secondary-bot']);
  });

  it('enables a disabled manager and makes an equal healthy PUT idempotent', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    const enabled = await test.manager.setSelection(selection);
    const unchanged = await test.manager.setSelection(selection);

    expect(enabled).toMatchObject({
      changed: true,
      replaced: false,
      created: true,
    });
    expect(unchanged).toMatchObject({
      changed: false,
      replaced: false,
      created: false,
    });
    expect(test.reserveLease).toHaveBeenCalledTimes(1);
    expect(test.group.start).toHaveBeenCalledTimes(1);
    expect(test.group.reconcile).not.toHaveBeenCalled();
    expect(test.onCommittedSelection).toHaveBeenCalledTimes(1);
    expect(test.onCommittedSelection).toHaveBeenCalledWith(
      selection,
      workspaceGroups(selection),
    );
    expect(test.onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        pendingSelection: selection,
        transition: 'starting',
      }),
    );
    expect(test.onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        selection,
        transition: 'idle',
      }),
    );
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection,
      transition: 'idle',
    });
  });

  it('refreshes workspace topology without forcing unchanged workers', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);

    await test.manager.refreshWorkspaces();

    expect(test.resolveGroups).toHaveBeenLastCalledWith(selection, 'reload');
    expect(test.group.reconcile).toHaveBeenCalledWith(
      workspaceGroups(selection),
    );
    expect(test.onCommittedSelection).toHaveBeenCalledTimes(2);
  });

  it('restores idle and classifies workspace topology reconcile failures', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    vi.mocked(test.group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('secondary failed', {
        rolledBack: true,
      }),
    );

    await expect(test.manager.refreshWorkspaces()).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: true,
    });
    expect(test.manager.state()).toMatchObject({
      transition: 'idle',
      selection,
    });
  });

  it('carries restoredWorkspaces from the reconcile error onto the control error (R10-2)', async () => {
    // The R9-4 chain's untested middle link: the group-level producer
    // (channel-worker-group.test.ts) and the service-level consumer (the
    // R9-4 stop guard) are both pinned, but the manager's classifyFailure
    // spread between them was not. Sever it, and a multi-workspace
    // disable failure whose aggregate rolledBack is false while THIS
    // workspace's entry WAS restored hands the service a control error
    // without the restore report — it records `stopped` for a channel
    // that is relaunching, which the next `--channel all` skips.
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    vi.mocked(test.group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('multi-workspace restore failed', {
        rolledBack: false,
        restoredWorkspaces: [PRIMARY],
      }),
    );

    await expect(
      test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu'],
      }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
      restoredWorkspaces: [PRIMARY],
    });
  });

  it('restores idle when workspace topology resolution fails', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    test.resolveGroups.mockRejectedValueOnce(new Error('settings invalid'));

    await expect(test.manager.refreshWorkspaces()).rejects.toThrow(
      'settings invalid',
    );
    expect(test.manager.state()).toMatchObject({
      transition: 'idle',
      selection,
    });
  });

  it('does not reconcile after forced shutdown interrupts workspace refresh', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    let releaseGroups!: () => void;
    test.resolveGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGroups = () => resolve(workspaceGroups(selection));
        }),
    );

    const refreshing = test.manager.refreshWorkspaces();
    await vi.waitFor(() => expect(test.resolveGroups).toHaveBeenCalledTimes(2));
    test.manager.killAllSync();
    releaseGroups();

    await expect(refreshing).rejects.toMatchObject({ code: 'daemon_draining' });
    expect(test.group.reconcile).not.toHaveBeenCalled();
  });

  it('starts the initial selection through the boot-time path', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    await test.manager.startInitial(selection);

    expect(test.resolveGroups).toHaveBeenCalledWith(selection, 'initial');
    expect(test.reserveLease).toHaveBeenCalledWith(selection);
    expect(test.group.start).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({ enabled: true, selection });
  });

  it('applies an existing workspace drain before a newly created group starts', async () => {
    const test = setup();

    test.manager.beginWorkspaceDrain(PRIMARY);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram'],
    });

    expect(test.group.beginWorkspaceDrain).toHaveBeenCalledWith(PRIMARY);
    expect(
      vi.mocked(test.group.beginWorkspaceDrain).mock.invocationCallOrder[0]!,
    ).toBeLessThan(vi.mocked(test.group.start).mock.invocationCallOrder[0]!);
  });

  it('keeps the boot-time lease reserved when group construction fails', async () => {
    const test = setup();
    test.createGroup.mockImplementationOnce(() => {
      throw new Error('group construction failed');
    });

    await expect(
      test.manager.startInitial({ mode: 'names', names: ['telegram'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
    });

    expect(test.releaseLease).not.toHaveBeenCalled();
    expect(test.manager.state()).toMatchObject({ enabled: true });
  });

  it('marks only the first concurrent enable as created', async () => {
    let releaseStart!: () => void;
    const group = fakeGroup({
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStart = resolve;
          }),
      ),
    });
    const test = setup(group);
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    const first = test.manager.setSelection(selection);
    const second = test.manager.setSelection(selection);
    await vi.waitFor(() => expect(group.start).toHaveBeenCalledTimes(1));
    releaseStart();

    await expect(first).resolves.toMatchObject({ created: true });
    await expect(second).resolves.toMatchObject({ created: false });
  });

  it('reconciles an unhealthy worker when reapplying the same selection', async () => {
    const group = fakeGroup({ isHealthy: vi.fn(() => false) });
    const test = setup(group);
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    await test.manager.setSelection(selection);
    const recovered = await test.manager.setSelection(selection);

    expect(group.reconcile).toHaveBeenCalledWith(workspaceGroups(selection), {
      onRollingBack: expect.any(Function),
    });
    expect(recovered).toMatchObject({
      changed: true,
      replaced: false,
      created: false,
    });
  });

  it('reports partial readiness without treating it as a failed enable', async () => {
    const group = fakeGroup({
      snapshots: () => [
        workerSnapshot({
          channels: ['telegram'],
          requestedChannels: ['telegram', 'discord'],
        }),
      ],
    });
    const test = setup(group);

    await expect(
      test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'discord'],
      }),
    ).resolves.toMatchObject({ partial: true, changed: true });
  });

  it('reconciles replacements without reacquiring the existing lease', async () => {
    const test = setup();
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(test.group.reconcile).mockResolvedValueOnce({
      changed: false,
      workers: test.group.snapshots(),
    });

    const result = await test.manager.setSelection({
      mode: 'names',
      names: ['discord'],
    });

    expect(result).toMatchObject({ changed: true, replaced: true });
    expect(test.reserveLease).toHaveBeenCalledTimes(1);
    expect(test.group.reconcile).toHaveBeenCalledWith(
      workspaceGroups({ mode: 'names', names: ['discord'] }),
      { onRollingBack: expect.any(Function) },
    );
  });

  it('restores an idle transition when reload group resolution fails', async () => {
    const test = setup();
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    test.resolveGroups.mockRejectedValueOnce(new Error('settings invalid'));

    await expect(test.manager.reload()).rejects.toThrow('settings invalid');
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      transition: 'idle',
    });
    expect(test.manager.state()).not.toHaveProperty('pendingSelection');
  });

  it('force-reconciles reload and returns the primary snapshot', async () => {
    const primary = workerSnapshot();
    const secondary = workerSnapshot({
      workspaceId: 'secondary',
      workspaceCwd: '/ws/secondary',
      primary: false,
    });
    const group = fakeGroup({
      snapshots: vi.fn(() => [secondary, primary]),
    });
    const test = setup(group);
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);

    await expect(test.manager.reload()).resolves.toEqual(primary);

    expect(test.resolveGroups).toHaveBeenLastCalledWith(selection, 'reload');
    expect(group.reconcile).toHaveBeenLastCalledWith(
      workspaceGroups(selection),
      { force: true, onRollingBack: expect.any(Function) },
    );
  });

  it('reloads only the requested workspace worker', async () => {
    const primary = workerSnapshot();
    const secondary = workerSnapshot({
      workspaceId: 'secondary',
      workspaceCwd: '/ws/secondary',
      primary: false,
    });
    const initialGroups: ChannelWorkspaceGroup[] = [
      {
        workspaceCwd: PRIMARY,
        selection: { mode: 'names', names: ['telegram'] },
      },
      {
        workspaceCwd: '/ws/secondary',
        selection: { mode: 'names', names: ['feishu'] },
      },
    ];
    const targetGroups: ChannelWorkspaceGroup[] = [
      initialGroups[0]!,
      {
        workspaceCwd: '/ws/secondary',
        selection: { mode: 'names', names: ['changed-elsewhere'] },
      },
    ];
    const group = fakeGroup({ snapshots: vi.fn(() => [primary, secondary]) });
    const test = setup(group);
    test.resolveGroups
      .mockResolvedValueOnce(initialGroups)
      .mockResolvedValueOnce(targetGroups);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });

    await expect(
      test.manager.reloadWorkspace(PRIMARY, 'telegram'),
    ).resolves.toEqual(primary);

    expect(group.reconcile).toHaveBeenLastCalledWith(targetGroups, {
      forceWorkspaceCwd: PRIMARY,
      onRollingBack: expect.any(Function),
    });
    expect(test.onCommittedSelection).toHaveBeenLastCalledWith(
      { mode: 'names', names: ['telegram', 'feishu'] },
      initialGroups,
    );
  });

  describe('filterReloadSelection (R14)', () => {
    // A names-mode dead-worker recovery reconciles from the committed
    // selection; the filter drops names carrying a persisted `stopped`
    // record so the recovery does not force-start an explicitly stopped
    // SIBLING. setup() does not pass the option — build the manager with
    // it here.
    function setupWithFilter(
      filterReloadSelection: (
        selection: ServeChannelSelection,
        groups: readonly ChannelWorkspaceGroup[],
      ) => ServeChannelSelection,
      group = fakeGroup(),
    ) {
      const reserveLease = vi.fn();
      const releaseLease = vi.fn();
      const resolveGroups = vi.fn(async (selection: ServeChannelSelection) =>
        workspaceGroups(selection),
      );
      const createGroup = vi.fn(() => group);
      const manager = createChannelWorkerManager({
        resolveGroups,
        createGroup,
        reserveLease,
        releaseLease,
        filterReloadSelection,
      });
      return { manager, group, resolveGroups };
    }

    it('applies the filter to reload resolves only', async () => {
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter((name) => name !== 'telegram'),
            }
          : selection,
      );
      const test = setupWithFilter(filter);
      const selection: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram', 'feishu'],
      };
      await test.manager.setSelection(selection);
      // `set` resolves are UNFILTERED: explicit selections force-start
      // regardless of persisted state (#8975).
      expect(filter).not.toHaveBeenCalled();
      expect(test.resolveGroups).toHaveBeenLastCalledWith(selection, 'set');

      await test.manager.reload();

      expect(filter).toHaveBeenCalledTimes(1);
      expect(test.resolveGroups).toHaveBeenLastCalledWith(
        { mode: 'names', names: ['feishu'] },
        'reload',
      );
    });

    it('keeps the setChannelEnabled rebuild resolve unfiltered too (R16-35)', async () => {
      // The "`set` resolves are UNFILTERED" pin above covers setSelection
      // only; setChannelEnabled's per-channel enable rebuild is the OTHER
      // `'set'`-operation resolve — the one the service's explicit
      // by-name start routes through. Routing it through the reload
      // filter while a committed sibling carries a surviving `stopped`
      // record silently trims the committed selection (or leaves the
      // sibling committed-but-ownerless): the two hazard classes the
      // filter's own option doc cites (#8975, R14). Probe-verified: the
      // mutation shipped green until this pin existed.
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter((name) => name !== 'telegram'),
            }
          : selection,
      );
      const test = setupWithFilter(filter);
      await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
      filter.mockClear();

      await test.manager.setChannelEnabled(
        { name: 'feishu', workspaceCwd: PRIMARY },
        true,
      );

      expect(filter).not.toHaveBeenCalled();
      expect(test.resolveGroups).toHaveBeenLastCalledWith(
        { mode: 'names', names: ['telegram', 'feishu'] },
        'set',
      );
      // The committed selection kept BOTH names: nothing trimmed.
      expect(test.manager.state().selection).toEqual({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });
    });

    it('applies the filter to reloadWorkspace resolves', async () => {
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter((name) => name !== 'telegram'),
            }
          : selection,
      );
      const test = setupWithFilter(filter);
      await test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });

      await test.manager.reloadWorkspace(PRIMARY, 'feishu');

      expect(test.resolveGroups).toHaveBeenLastCalledWith(
        { mode: 'names', names: ['feishu'] },
        'reload',
      );
    });

    it('passes the committed groups to the filter for workspace attribution', async () => {
      const filter = vi.fn((selection: ServeChannelSelection) => selection);
      const test = setupWithFilter(filter);
      const selection: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram'],
      };
      await test.manager.setSelection(selection);

      await test.manager.reload();

      expect(filter).toHaveBeenCalledWith(selection, [
        { workspaceCwd: PRIMARY, selection },
      ]);
    });

    it('degrades to the unfiltered selection when the filter throws', async () => {
      // Never-fails: the filter reads per-workspace state files in
      // production; an unexpected error must not break recovery — the
      // pre-R14 (unfiltered) reconcile is the degrade target.
      const test = setupWithFilter(() => {
        throw new Error('state read exploded');
      });
      const selection: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram', 'feishu'],
      };
      await test.manager.setSelection(selection);

      await expect(test.manager.reload()).resolves.toBeDefined();
      expect(test.resolveGroups).toHaveBeenLastCalledWith(selection, 'reload');
    });

    it('applies the filter to refreshWorkspaces resolves (R14-33)', async () => {
      // refreshWorkspaces is the AUTOMATIC reconcile trigger (workspace
      // attach/detach). An unfiltered resolve there force-starts an
      // explicitly stopped channel between two manual reloads — a third
      // entry point the reload/reloadWorkspace pins alone leave open.
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter((name) => name !== 'telegram'),
            }
          : selection,
      );
      const test = setupWithFilter(filter);
      await test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });

      await test.manager.refreshWorkspaces();

      expect(test.resolveGroups).toHaveBeenLastCalledWith(
        { mode: 'names', names: ['feishu'] },
        'reload',
      );
    });

    it('commits the filtered selection so a later reload cannot resurrect the dropped name (R14-2)', async () => {
      // Resolving with the filtered selection while committing the
      // UNFILTERED one desyncs the bookkeeping: committedGroups is
      // trimmed, so the next reload's owner lookup misses the filtered
      // name, the keep-fallback (`owner ? !stoppedIn(...) : true`)
      // retains it, and the reconcile force-starts the explicitly
      // stopped channel — the resurrection the filter exists to prevent.
      // Committed state must stay coherent with what was reconciled.
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter((name) => name !== 'telegram'),
            }
          : selection,
      );
      const test = setupWithFilter(filter);
      await test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });

      await test.manager.reload();

      // The committed selection is coherent with what was reconciled…
      expect(test.manager.state().selection).toEqual({
        mode: 'names',
        names: ['feishu'],
      });
      // …and the reconcile itself ran against the FILTERED groups, not
      // the committed ones: reconciling committedGroups would
      // force-start the stopped sibling, and the ready `active` write
      // would erase its record permanently (R15-57).
      expect(test.group.reconcile).toHaveBeenLastCalledWith(
        [
          {
            workspaceCwd: PRIMARY,
            selection: { mode: 'names', names: ['feishu'] },
          },
        ],
        expect.objectContaining({ force: true }),
      );

      await test.manager.reload();

      // …so a SECOND reload resolves the same filtered selection instead
      // of resurrecting the dropped name through the keep-fallback.
      expect(test.resolveGroups).toHaveBeenLastCalledWith(
        { mode: 'names', names: ['feishu'] },
        'reload',
      );
      expect(test.manager.state().selection).toEqual({
        mode: 'names',
        names: ['feishu'],
      });
    });

    it('commits the filtered selection on refreshWorkspaces too (R14-2 twin)', async () => {
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter((name) => name !== 'telegram'),
            }
          : selection,
      );
      const test = setupWithFilter(filter);
      await test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });

      await test.manager.refreshWorkspaces();

      expect(test.manager.state().selection).toEqual({
        mode: 'names',
        names: ['feishu'],
      });
    });

    it('rejects reloadWorkspace when the filter drops the requested name (R15-38)', async () => {
      // A union "fix" re-adding the dropped requested name would
      // resurrect an explicitly stopped channel through reloadWorkspace:
      // the resolve must fail the owner check instead.
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter((name) => name !== 'telegram'),
            }
          : selection,
      );
      const test = setupWithFilter(filter);
      await test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });

      await expect(
        test.manager.reloadWorkspace(PRIMARY, 'telegram'),
      ).rejects.toMatchObject({ code: 'channel_runtime_owner_mismatch' });
    });

    it('commits the filtered selection on reloadWorkspace too (R15-38 coherence)', async () => {
      // commit(filteredSelection, …) — committing the UNFILTERED
      // selection desyncs it from the filtered resolve: the next
      // reload's keep-fallback retains the stopped name and the
      // reconcile force-starts it.
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter((name) => name !== 'telegram'),
            }
          : selection,
      );
      const test = setupWithFilter(filter);
      await test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });

      await test.manager.reloadWorkspace(PRIMARY, 'feishu');

      expect(test.manager.state().selection).toEqual({
        mode: 'names',
        names: ['feishu'],
      });
    });

    it('keeps preserved other-workspace names committed on reloadWorkspace (R17-3)', async () => {
      // reloadWorkspace's reconcile is scoped to ONE workspace
      // (forceWorkspaceCwd): entries owned by other workspaces are
      // preserved as-is. When the global filter drops a name owned by a
      // PRESERVED workspace (a surviving `stopped` record), committing
      // the globally filtered selection trims it while its worker keeps
      // running — committedGroups desyncs from committedSelection, a
      // later per-channel stop hits the disable early-return with
      // nothing to tear down, and the channel runs unmanaged until the
      // next global reconcile. The commit must stay scoped to what was
      // reconciled; the resolve itself stays globally filtered.
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter(
                (name) => name !== 'secondary-feishu',
              ),
            }
          : selection,
      );
      const group = fakeGroup();
      const resolveGroups = vi.fn(async (selection: ServeChannelSelection) =>
        splitWorkspaceGroups(selection),
      );
      const manager = createChannelWorkerManager({
        resolveGroups,
        createGroup: vi.fn(() => group),
        reserveLease: vi.fn(),
        releaseLease: vi.fn(),
        filterReloadSelection: filter,
      });
      await manager.setSelection({
        mode: 'names',
        names: ['telegram', 'secondary-feishu'],
      });

      await manager.reloadWorkspace(PRIMARY, 'telegram');

      // The resolve ran against the globally filtered selection…
      expect(resolveGroups).toHaveBeenLastCalledWith(
        { mode: 'names', names: ['telegram'] },
        'reload',
      );
      // …and the reconcile only touched the requested workspace…
      expect(group.reconcile).toHaveBeenLastCalledWith(
        [
          {
            workspaceCwd: PRIMARY,
            selection: { mode: 'names', names: ['telegram'] },
          },
        ],
        expect.objectContaining({ forceWorkspaceCwd: PRIMARY }),
      );
      // …but the commit keeps the preserved workspace's name, staying
      // coherent with committedGroups (both entries still live).
      expect(manager.state().selection).toEqual({
        mode: 'names',
        names: ['telegram', 'secondary-feishu'],
      });
      expect(manager.committedChannelNames()).toEqual([
        'telegram',
        'secondary-feishu',
      ]);

      // A second scoped reload is stable: the filter drops the foreign
      // name again and the scoped commit restores it again.
      await manager.reloadWorkspace(PRIMARY, 'telegram');
      expect(manager.state().selection).toEqual({
        mode: 'names',
        names: ['telegram', 'secondary-feishu'],
      });
    });

    it('still drops the reconciled workspace own filtered names on reloadWorkspace (R17-3 boundary)', async () => {
      // The scoped commit must NOT re-add names owned by the reconciled
      // workspace itself: that would resurrect an explicitly stopped
      // channel through reloadWorkspace (the R15-38 hazard). The filter
      // drops one PRIMARY-owned and one SECONDARY-owned name; only the
      // foreign one may come back. A blanket "keep everything committed"
      // regression turns red on telegram, a plain R15-38-style global
      // commit on secondary-feishu.
      const filter = vi.fn((selection: ServeChannelSelection) =>
        selection.mode === 'names'
          ? {
              mode: 'names' as const,
              names: selection.names.filter(
                (name) => name !== 'telegram' && name !== 'secondary-feishu',
              ),
            }
          : selection,
      );
      const group = fakeGroup();
      const manager = createChannelWorkerManager({
        resolveGroups: vi.fn(async (selection: ServeChannelSelection) =>
          splitWorkspaceGroups(selection),
        ),
        createGroup: vi.fn(() => group),
        reserveLease: vi.fn(),
        releaseLease: vi.fn(),
        filterReloadSelection: filter,
      });
      await manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu', 'secondary-feishu'],
      });

      await manager.reloadWorkspace(PRIMARY, 'feishu');

      // telegram (owned by the reconciled workspace) stays dropped;
      // secondary-feishu (owned by the preserved workspace) stays
      // committed.
      expect(manager.state().selection).toEqual({
        mode: 'names',
        names: ['feishu', 'secondary-feishu'],
      });
    });

    it('passes EVERY committed group to the filter in multi-workspace resolves (R15-37)', async () => {
      // Per-workspace attribution is the filter's core contract: passing
      // only the first committed group (or keying the state cache on a
      // constant) makes a secondary workspace's `stopped` record
      // invisible — the next reload-op force-starts the explicitly
      // stopped channel there.
      const filter = vi.fn((selection: ServeChannelSelection) => selection);
      const group = fakeGroup();
      const manager = createChannelWorkerManager({
        resolveGroups: vi.fn(async (selection: ServeChannelSelection) =>
          splitWorkspaceGroups(selection),
        ),
        createGroup: vi.fn(() => group),
        reserveLease: vi.fn(),
        releaseLease: vi.fn(),
        filterReloadSelection: filter,
      });
      const selection: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram', 'secondary-feishu'],
      };
      await manager.setSelection(selection);

      await manager.reload();

      expect(filter).toHaveBeenCalledWith(selection, [
        {
          workspaceCwd: PRIMARY,
          selection: { mode: 'names', names: ['telegram'] },
        },
        {
          workspaceCwd: SECONDARY,
          selection: { mode: 'names', names: ['secondary-feishu'] },
        },
      ]);
    });
  });

  describe('clearStoppedRecords (R14)', () => {
    // The explicit-set side of the reload-filter contract: a names-mode
    // (re-)commit force-starts, but pre-existing stopped records must not
    // survive the commit — an automatic reload-op resolve before the
    // worker connects would otherwise filter the still-starting name out
    // and leave it committed-but-ownerless with the record never
    // cleared.
    function setupWithClear(
      clearStoppedRecords: (
        groups: readonly ChannelWorkspaceGroup[],
      ) => readonly string[],
      group = fakeGroup(),
    ) {
      const resolveGroups = vi.fn(async (selection: ServeChannelSelection) =>
        workspaceGroups(selection),
      );
      const manager = createChannelWorkerManager({
        resolveGroups,
        createGroup: vi.fn(() => group),
        reserveLease: vi.fn(),
        releaseLease: vi.fn(),
        clearStoppedRecords,
      });
      return { manager, resolveGroups };
    }

    it('clears records after a successful names-mode commit', async () => {
      const clearStoppedRecords = vi.fn(() => [] as string[]);
      const test = setupWithClear(clearStoppedRecords);
      const selection: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram'],
      };

      await test.manager.setSelection(selection);

      expect(clearStoppedRecords).toHaveBeenCalledTimes(1);
      expect(clearStoppedRecords).toHaveBeenCalledWith([
        { workspaceCwd: PRIMARY, selection },
      ]);
    });

    it('clears records once per commit, including the reconcile branch (R15-7)', async () => {
      // Production has TWO clearRecordsForCommit call sites in
      // applySelection (group creation and reconcile): the second commit
      // over an existing group exercises the reconcile one. Dropping the
      // hook there leaves a stale stopped record, and an automatic
      // refreshWorkspaces before the ready `active` write filters the
      // still-starting name out — committed-but-ownerless.
      const clearStoppedRecords = vi.fn(() => [] as string[]);
      const test = setupWithClear(clearStoppedRecords);
      const first: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram'],
      };
      const second: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram', 'feishu'],
      };

      await test.manager.setSelection(first);
      await test.manager.setSelection(second);

      expect(clearStoppedRecords).toHaveBeenCalledTimes(2);
      expect(clearStoppedRecords).toHaveBeenNthCalledWith(1, [
        { workspaceCwd: PRIMARY, selection: first },
      ]);
      expect(clearStoppedRecords).toHaveBeenNthCalledWith(2, [
        { workspaceCwd: PRIMARY, selection: second },
      ]);
    });

    it('re-runs the clear on a same-selection retry and re-reports its loss (R20-5)', async () => {
      // The retry the set result's warning promises ("retry `qwen
      // channel set` to re-clear") used to hit applySelection's
      // sameSelection early return BEFORE clearRecordsForCommit ran: the
      // surviving `stopped` record was never re-cleared, the retry
      // reported success with no loss fields, and the next reload-op
      // resolve filtered the name out and permanently trimmed the
      // committed selection. The early-return branch must re-run the
      // clear and re-report its loss — idempotent, no reconcile.
      const group = fakeGroup();
      const clearStoppedRecords = vi
        .fn()
        .mockReturnValueOnce([PRIMARY] as string[])
        .mockReturnValueOnce([PRIMARY] as string[]);
      const test = setupWithClear(clearStoppedRecords, group);
      const selection: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram'],
      };

      const first = await test.manager.setSelection(selection);
      expect(first).toMatchObject({
        changed: true,
        statePersisted: false,
        statePersistFailedWorkspaces: [PRIMARY],
      });

      const retry = await test.manager.setSelection(selection);

      expect(clearStoppedRecords).toHaveBeenCalledTimes(2);
      expect(retry).toMatchObject({
        changed: false,
        statePersisted: false,
        statePersistFailedWorkspaces: [PRIMARY],
      });
      // Idempotent: the retry re-clears without reconciling.
      expect(group.reconcile).not.toHaveBeenCalled();

      // Once the clear succeeds, the retry reports no loss.
      clearStoppedRecords.mockReturnValue([] as string[]);
      const clean = await test.manager.setSelection(selection);
      expect(clearStoppedRecords).toHaveBeenCalledTimes(3);
      expect(clean).toMatchObject({ changed: false });
      expect(clean).not.toHaveProperty('statePersisted');
    });

    it('clears records on the initial start path (R15-58)', async () => {
      // Production reaches the hook via startInitial too (serve wiring);
      // a mutation skipping the clear when initial === true leaves
      // pre-existing stopped records alive past the restart commit.
      const clearStoppedRecords = vi.fn(() => [] as string[]);
      const test = setupWithClear(clearStoppedRecords);
      const selection: ServeChannelSelection = {
        mode: 'names',
        names: ['telegram'],
      };

      await test.manager.startInitial(selection);

      expect(clearStoppedRecords).toHaveBeenCalledTimes(1);
      expect(clearStoppedRecords).toHaveBeenCalledWith([
        { workspaceCwd: PRIMARY, selection },
      ]);
    });

    it('clears records on the setChannelEnabled rebuild commit (R16-51)', async () => {
      // The third production commit entry point: the service routes
      // per-channel start/stop through setChannelEnabled's rebuild
      // (channel-management-service's start/stop/remove). Moving
      // clearRecordsForCommit out of the shared applySelection into the
      // setSelection/startInitial callers only — or gating it on the
      // resolve reason — leaves an explicit by-name start committing
      // WITHOUT clearing the stopped record: the next automatic
      // reload-op resolve filters the name and commit trims it
      // permanently (the R15-19 silent undo this describe warns about).
      const clearStoppedRecords = vi.fn(() => [] as string[]);
      // The static fake group's snapshots must own BOTH names: the
      // disable half runs assertCommittedOwner against them (the mock
      // reconcile does not update snapshots the way production does).
      const group = fakeGroup({
        snapshots: vi.fn(() => [
          workerSnapshot({
            channels: ['telegram', 'feishu'],
            requestedChannels: ['telegram', 'feishu'],
          }),
        ]),
      });
      const test = setupWithClear(clearStoppedRecords, group);
      await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
      clearStoppedRecords.mockClear();

      await test.manager.setChannelEnabled(
        { name: 'feishu', workspaceCwd: PRIMARY },
        true,
      );

      expect(clearStoppedRecords).toHaveBeenCalledTimes(1);
      expect(clearStoppedRecords).toHaveBeenCalledWith([
        {
          workspaceCwd: PRIMARY,
          selection: { mode: 'names', names: ['telegram', 'feishu'] },
        },
      ]);

      // The non-empty disable rebuild rides the same shared path from
      // the other direction.
      clearStoppedRecords.mockClear();
      await test.manager.setChannelEnabled(
        { name: 'feishu', workspaceCwd: PRIMARY },
        false,
      );

      expect(clearStoppedRecords).toHaveBeenCalledTimes(1);
      expect(clearStoppedRecords).toHaveBeenCalledWith([
        {
          workspaceCwd: PRIMARY,
          selection: { mode: 'names', names: ['telegram'] },
        },
      ]);
    });

    it('does not clear records on a mode-all commit', async () => {
      // mode-`all` restore honors stopped records by design (#8975);
      // clearing them on an all-mode commit would resurrect exactly the
      // channels the user stopped.
      const clearStoppedRecords = vi.fn(() => [] as string[]);
      const test = setupWithClear(clearStoppedRecords);

      await test.manager.setSelection({ mode: 'all' });

      expect(clearStoppedRecords).not.toHaveBeenCalled();
    });

    it('never lets a throwing clear fail an already-committed selection', async () => {
      const clearStoppedRecords = vi.fn((): string[] => {
        throw new Error('state write exploded');
      });
      const test = setupWithClear(clearStoppedRecords);

      await expect(
        test.manager.setSelection({ mode: 'names', names: ['telegram'] }),
      ).resolves.toBeDefined();
      expect(test.manager.state().selection).toEqual({
        mode: 'names',
        names: ['telegram'],
      });
    });

    it('surfaces reported clear failures on the set result (R15-19)', async () => {
      // A surviving stopped record means the reload filter DROPS the
      // name and a later reload-op permanently trims the committed
      // selection: the loss must ride the set result like the DELETE
      // route's, not vanish into a silent degrade.
      const clearStoppedRecords = vi.fn(() => [PRIMARY]);
      const test = setupWithClear(clearStoppedRecords);

      const result = await test.manager.setSelection({
        mode: 'names',
        names: ['telegram'],
      });

      expect(result.statePersisted).toBe(false);
      expect(result.statePersistFailedWorkspaces).toEqual([PRIMARY]);
      expect(test.manager.state().selection).toEqual({
        mode: 'names',
        names: ['telegram'],
      });
    });

    it('surfaces reported clear failures on the reconcile-branch result too (R16-52)', async () => {
      // The R15-19 pin exercises only applySelection's group-creation
      // branch; the reconcile branch's clearLossFields spread is the
      // COMMON case — every commit after the first over a running group
      // takes it. Dropping the spread there reports a clean success on
      // the shape every PUT /workspace/channel after the first returns,
      // the client never retries, and the surviving record lets a later
      // reload-op filter permanently trim the committed selection
      // (R15-19).
      const clearStoppedRecords = vi.fn(() => [PRIMARY]);
      const test = setupWithClear(clearStoppedRecords);

      await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
      const result = await test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });

      expect(clearStoppedRecords).toHaveBeenCalledTimes(2);
      expect(result.statePersisted).toBe(false);
      expect(result.statePersistFailedWorkspaces).toEqual([PRIMARY]);
      expect(test.manager.state().selection).toEqual({
        mode: 'names',
        names: ['telegram', 'feishu'],
      });
    });

    it('keeps the happy-path set result shape when every clear persists', async () => {
      const clearStoppedRecords = vi.fn(() => [] as string[]);
      const test = setupWithClear(clearStoppedRecords);

      const result = await test.manager.setSelection({
        mode: 'names',
        names: ['telegram'],
      });

      expect(result).not.toHaveProperty('statePersisted');
      expect(result).not.toHaveProperty('statePersistFailedWorkspaces');
    });
  });

  it.each([
    {
      label: 'moves to another workspace',
      targetGroups: [
        {
          workspaceCwd: PRIMARY,
          selection: { mode: 'names' as const, names: ['other'] },
        },
        {
          workspaceCwd: '/ws/secondary',
          selection: { mode: 'names' as const, names: ['feishu', 'bot'] },
        },
      ],
    },
    {
      label: 'becomes ownerless',
      targetGroups: [
        {
          workspaceCwd: PRIMARY,
          selection: { mode: 'names' as const, names: ['other'] },
        },
        {
          workspaceCwd: '/ws/secondary',
          selection: { mode: 'names' as const, names: ['feishu'] },
        },
      ],
    },
  ])(
    'rejects targeted reload when the edited channel $label',
    async ({ targetGroups }) => {
      const initialGroups: ChannelWorkspaceGroup[] = [
        {
          workspaceCwd: PRIMARY,
          selection: { mode: 'names', names: ['bot', 'other'] },
        },
        {
          workspaceCwd: '/ws/secondary',
          selection: { mode: 'names', names: ['feishu'] },
        },
      ];
      const test = setup();
      test.resolveGroups
        .mockResolvedValueOnce(initialGroups)
        .mockResolvedValueOnce(targetGroups);
      await test.manager.setSelection({
        mode: 'names',
        names: ['bot', 'other', 'feishu'],
      });
      vi.mocked(test.group.reconcile).mockClear();

      await expect(
        test.manager.reloadWorkspace(PRIMARY, 'bot'),
      ).rejects.toMatchObject({ code: 'channel_runtime_owner_mismatch' });

      expect(test.group.reconcile).not.toHaveBeenCalled();
      expect(test.onCommittedSelection).toHaveBeenLastCalledWith(
        { mode: 'names', names: ['bot', 'other', 'feishu'] },
        initialGroups,
      );
    },
  );

  it('rejects a required owner mismatch before reconciling selection', async () => {
    const test = setup();
    test.resolveGroups.mockResolvedValueOnce([
      {
        workspaceCwd: '/ws/secondary',
        selection: { mode: 'names', names: ['bot'] },
      },
    ]);

    await expect(
      test.manager.setSelection(
        { mode: 'names', names: ['bot'] },
        { name: 'bot', workspaceCwd: PRIMARY },
      ),
    ).rejects.toMatchObject({ code: 'channel_runtime_owner_mismatch' });

    expect(test.createGroup).not.toHaveBeenCalled();
    expect(test.group.reconcile).not.toHaveBeenCalled();
    expect(test.reserveLease).not.toHaveBeenCalled();
    expect(test.onStateChange).not.toHaveBeenCalled();
  });

  it('preserves workspace-attributed startup failures from reload', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    vi.mocked(test.group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('reload failed', {
        rolledBack: true,
        startupFailures: [
          {
            workspaceCwd: '/ws/secondary',
            channel: 'telegram',
            phase: 'connect',
            code: 'ECONNREFUSED',
            message: 'connection refused',
          },
        ],
      }),
    );

    await expect(test.manager.reload()).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: true,
      startupFailures: [
        {
          workspaceCwd: '/ws/secondary',
          channel: 'telegram',
          phase: 'connect',
          code: 'ECONNREFUSED',
          message: 'connection refused',
        },
      ],
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection,
      transition: 'idle',
    });
  });

  it('does not reconcile after forced shutdown interrupts reload resolution', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    let releaseGroups!: () => void;
    test.resolveGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGroups = () => resolve(workspaceGroups(selection));
        }),
    );

    const reloading = test.manager.reload();
    await vi.waitFor(() =>
      expect(test.resolveGroups).toHaveBeenLastCalledWith(selection, 'reload'),
    );
    test.manager.killAllSync();
    releaseGroups();

    await expect(reloading).rejects.toMatchObject({ code: 'daemon_draining' });
    expect(test.group.reconcile).not.toHaveBeenCalled();
  });

  it('keeps the old committed selection when reconcile rolls back', async () => {
    const group = fakeGroup();
    const test = setup(group);
    const oldSelection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(oldSelection);
    vi.mocked(group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('discord failed', {
        rolledBack: true,
      }),
    );

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['discord'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: true,
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection: oldSelection,
      transition: 'idle',
    });
    expect(test.releaseLease).not.toHaveBeenCalled();
  });

  it('publishes rolling_back while a failed replacement restores old workers', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    let releaseRollback!: () => void;
    vi.mocked(group.reconcile).mockImplementationOnce(
      async (_groups, options) => {
        options?.onRollingBack?.();
        await new Promise<void>((resolve) => {
          releaseRollback = resolve;
        });
        throw new ChannelWorkerReconcileError('replacement failed', {
          rolledBack: true,
        });
      },
    );

    const replacing = test.manager.setSelection({
      mode: 'names',
      names: ['discord'],
    });
    await vi.waitFor(() => {
      expect(test.manager.state()).toMatchObject({
        transition: 'rolling_back',
        pendingSelection: { mode: 'names', names: ['discord'] },
      });
    });
    releaseRollback();
    await expect(replacing).rejects.toMatchObject({ rolledBack: true });
    expect(test.manager.state().transition).toBe('idle');
  });

  it('retains a failed first-start group and lease until DELETE confirms stop', async () => {
    const group = fakeGroup();
    vi.mocked(group.start).mockRejectedValueOnce(
      new ChannelWorkerStartupError('spawn failed', {
        workspaceCwd: PRIMARY,
        startupFailures: [
          {
            channel: 'telegram',
            phase: 'connect',
            message: 'provider failed',
          },
        ],
      }),
    );
    vi.mocked(group.stop)
      .mockRejectedValueOnce(new Error('exit not observed'))
      .mockResolvedValueOnce(undefined);
    const test = setup(group);

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['telegram'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
      rollbackError: 'exit not observed',
      startupFailures: [
        expect.objectContaining({
          workspaceCwd: PRIMARY,
          message: 'provider failed',
        }),
      ],
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection: null,
    });
    expect(test.releaseLease).not.toHaveBeenCalled();

    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: true,
      state: { enabled: false },
    });
    expect(group.stop).toHaveBeenCalledTimes(2);
    expect(test.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('returns attempted startup failures while current state reflects successful rollback', async () => {
    const group = fakeGroup();
    const startupError = new ChannelWorkerStartupError('worker failed', {
      workspaceCwd: PRIMARY,
      startupFailures: [
        {
          channel: 'telegram',
          phase: 'connect',
          code: 'ECONNREFUSED',
          message: 'connection refused',
        },
      ],
      startupFailuresTruncated: true,
    });
    vi.mocked(group.start).mockRejectedValueOnce(startupError);
    const test = setup(group);

    const error = await test.manager
      .setSelection({ mode: 'names', names: ['telegram'] })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: true,
      startupFailuresTruncated: true,
      startupFailures: [
        {
          workspaceCwd: PRIMARY,
          channel: 'telegram',
          phase: 'connect',
          code: 'ECONNREFUSED',
          message: 'connection refused',
        },
      ],
    });
    expect(test.manager.state()).toEqual({
      enabled: false,
      selection: null,
      transition: 'idle',
      workers: [],
    });
    (error as ChannelWorkerControlError).startupFailures![0]!.message =
      'mutated';
    expect(startupError.startupFailures![0]!.message).toBe(
      'connection refused',
    );
  });

  it('does not replace attempted failures with a reconcile rollback error', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('replacement failed', {
        rolledBack: false,
        rollbackError: 'restore failed',
        startupFailures: [
          {
            workspaceCwd: PRIMARY,
            channel: 'discord',
            phase: 'connect',
            message: 'invalid token',
          },
        ],
      }),
    );

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['discord'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
      rollbackError: 'restore failed',
      startupFailures: [
        expect.objectContaining({
          workspaceCwd: PRIMARY,
          channel: 'discord',
          message: 'invalid token',
        }),
      ],
    });
  });

  it('keeps a lease-only failure enabled so DELETE can retry its release', async () => {
    const test = setup();
    test.createGroup.mockImplementationOnce(() => {
      throw new Error('group construction failed');
    });
    test.releaseLease
      .mockImplementationOnce(() => {
        throw new Error('lease release failed');
      })
      .mockImplementationOnce(() => {});

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['telegram'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
      rollbackError: 'lease release failed',
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection: null,
      transition: 'idle',
      workers: [],
    });

    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: true,
      state: { enabled: false },
    });
    expect(test.releaseLease).toHaveBeenCalledTimes(2);
  });

  it('treats a stop-rejected group as lost so a per-channel start recovers (R14)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.stop).mockRejectedValueOnce(new Error('still alive'));

    await expect(test.manager.stopSelection()).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });
    // Pre-R14 kept the group latched mid-tear-down with the lease and the
    // committed selection intact: a per-channel start for a torn-down
    // channel early-returned 200 {changed:false} (nothing relaunched) and
    // every reconcile rejected on the stopping latch — dead channels
    // reporting success. The rejected group is unrecoverable, so drop it
    // (and the lease/commitment) and let the next operation create a
    // fresh one (R14).
    expect(test.releaseLease).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({
      enabled: false,
      selection: null,
      workers: [],
    });

    await expect(
      test.manager.setChannelEnabled(
        { name: 'telegram', workspaceCwd: PRIMARY },
        true,
      ),
    ).resolves.toMatchObject({ changed: true });
    expect(test.createGroup).toHaveBeenCalledTimes(2);
  });

  it('keeps the lease when a stop-rejected group is lost to a persistent release failure (R14)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.stop).mockRejectedValueOnce(new Error('still alive'));
    test.releaseLease.mockImplementation(() => {
      throw new Error('lease owner changed');
    });

    await expect(test.manager.stopSelection()).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });
    // The lost-group cleanup still ran (no stopping latch, no stale
    // commitment); only the lease stays held because the release kept
    // failing — enabled reports it until a later stop clears it (R14).
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection: null,
      workers: [],
    });
    // The release was ATTEMPTED before the cleanup latched the lease
    // (R14-16): without this pin an implementation could skip the release
    // and latch directly — indistinguishable in state, but the lease then
    // never gets a release attempt again.
    expect(test.releaseLease).toHaveBeenCalledTimes(1);

    // …and a follow-up stop clears the limbo state once the release
    // succeeds.
    test.releaseLease.mockImplementation(() => undefined);
    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: true,
    });
    expect(test.manager.state()).toMatchObject({ enabled: false });
  });

  it('clears a confirmed-stopped group when lease release fails and retries', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    test.releaseLease.mockImplementationOnce(() => {
      throw new Error('lease owner changed');
    });

    // The tear-down already succeeded before release() threw, and the group
    // is cleared — no retry can re-capture the names, so the error must
    // carry them for the route to persist (#8975).
    await expect(test.manager.stopSelection()).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
      stoppedChannels: [{ workspaceCwd: PRIMARY, names: ['telegram'] }],
    });
    // The lost-group cleanup retries the release in the catch (R14): the
    // transient failure clears, so nothing stays latched on the lease.
    expect(test.releaseLease).toHaveBeenCalledTimes(2);
    expect(test.manager.state()).toMatchObject({
      enabled: false,
      selection: null,
      workers: [],
    });

    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: false,
      state: { enabled: false },
    });
    expect(group.stop).toHaveBeenCalledTimes(1);
    expect(test.releaseLease).toHaveBeenCalledTimes(2);
  });

  it('carries the captured channels on a failed multi-workspace stop (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        workspaceId: 'primary',
        workspaceCwd: PRIMARY,
        primary: true,
        channels: ['telegram'],
        requestedChannels: ['telegram'],
      }),
      workerSnapshot({
        workspaceId: 'secondary',
        workspaceCwd: SECONDARY,
        primary: false,
        channels: ['feishu'],
        requestedChannels: ['feishu'],
      }),
    ]);
    // A partial failure: one workspace's worker is already torn down when
    // the other fails to exit, so the rejection must still carry the
    // captured set for persistence — otherwise the stopped channels
    // resurrect on the next `--channel all` start.
    vi.mocked(group.stop).mockRejectedValueOnce(new Error('stop failed'));

    await expect(test.manager.stopSelection()).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
      stoppedChannels: [
        { workspaceCwd: PRIMARY, names: ['telegram'] },
        { workspaceCwd: SECONDARY, names: ['feishu'] },
      ],
    });
  });

  it('carries the captured channels when the group throws a wrapped control error (R14-17)', async () => {
    // Twin of the multi-workspace pin with the wrapped error classes the
    // group's stop path actually raises (ChannelWorkerStopError is a
    // ChannelWorkerControlError subclass; the classifyFailure spread
    // `{ ...(stoppedChannels.length > 0 ? { stoppedChannels } : {}) }`
    // must land on the rethrown error regardless of the error class — a
    // plain `new ChannelWorkerControlError(...)` construction would drop
    // the captured set and the stopped channels would resurrect).
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        workspaceId: 'primary',
        workspaceCwd: PRIMARY,
        primary: true,
        channels: ['telegram'],
        requestedChannels: ['telegram'],
      }),
    ]);
    vi.mocked(group.stop).mockRejectedValueOnce(
      new ChannelWorkerControlError('channel_worker_stop_failed', 'boom', {
        rolledBack: false,
      }),
    );

    await expect(test.manager.stopSelection()).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
      stoppedChannels: [{ workspaceCwd: PRIMARY, names: ['telegram'] }],
    });
  });

  it('reports the torn-down channels on stop for state persistence (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['telegram', 'feishu'],
        requestedChannels: ['telegram', 'feishu'],
      }),
    ]);

    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: true,
      stoppedChannels: [
        { workspaceCwd: PRIMARY, names: ['telegram', 'feishu'] },
      ],
    });
  });

  it('records only connected channels after a partial start (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
    // telegram connected, feishu's connect failed: the ready report commits
    // the attempted set in requestedChannels and the connected set in
    // channels. The capture must intersect the two — recording a
    // never-connected channel as explicitly stopped would keep it skipped
    // on every later `--channel all` start after the cause is fixed.
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['telegram'],
        requestedChannels: ['telegram', 'feishu'],
      }),
    ]);

    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: true,
      stoppedChannels: [{ workspaceCwd: PRIMARY, names: ['telegram'] }],
    });
  });

  it('records no phantom names when a stop lands in the mode-all initial starting window (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    // The INITIAL-start shape, before any ready report: only the `['all']`
    // launch placeholder is present, no `requestedChannels` and no carried
    // connected set. A stop in that window has no real names to persist and
    // must not record the phantom `all` entry. (A CRASH-restart window is
    // different: the supervisor carries the last committed names across the
    // relaunch — see the crash-restart tests below.)
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'starting',
        requestedChannels: undefined,
        channels: ['all'],
      }),
    ]);

    // The same placeholder must not leak into committed names either: an
    // owner-scoped enable issued in this window would otherwise build a
    // names selection containing the phantom `all`.
    expect(test.manager.committedChannelNames()).toEqual([]);

    const result = await test.manager.stopSelection();

    expect(result).toMatchObject({ changed: true });
    expect(result.stoppedChannels).toBeUndefined();
    // An empty capture must not short-circuit the tear-down: the manager
    // reporting {changed: true} while the worker survives is the zombie
    // shape the degraded-canonicalization twin pins (#8975).
    expect(group.stop).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({ enabled: false });
  });

  it('reports the carried requestedChannels as committed during a mode-all crash-restart window (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    // The CRASH-restart counterpart of the initial-window test above:
    // the supervisor carries the last committed names across the
    // relaunch (`requestedChannels` defined) while `channels` is still
    // the `['all']` launch placeholder. committedChannelNames() must
    // read the carried set — flipping the precedence to `channels ??
    // requestedChannels` ships green without this pin: the placeholder
    // filters out, the relaunching worker's channels read as uncommitted
    // and a per-channel start/stop reconciles a replacement selection
    // against the mid-relaunch worker (R11-v5).
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'starting',
        channels: ['all'],
        requestedChannels: ['telegram', 'feishu'],
      }),
    ]);

    expect(test.manager.committedChannelNames()).toEqual([
      'telegram',
      'feishu',
    ]);
  });

  it('filters the phantom all placeholder out of a carried connected set (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    // Defense-in-depth shape: a worker IPC ready message omitting the
    // arrays makes completeReady fall back to the `['all']` placeholder
    // and carry it into lastConnectedChannels. The capture filter must
    // drop it, or a phantom `{names: ['all']}` group leaks into
    // stoppedChannels and gets persisted into the state store (#8975).
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['all'],
        requestedChannels: undefined,
        lastConnectedChannels: ['all'],
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toBeUndefined();
    // Empty capture must not short-circuit the tear-down (zombie shape,
    // see the degraded-canonicalization twin) (#8975).
    expect(group.stop).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({ enabled: false });
  });

  it('skips empty capture groups on guard-passing zero-channel shapes (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    // The shape this PR's own zero-channel ready path commits:
    // `requestedChannels: []` is truthy (passes the nothing-ever-confirmed
    // guard) with an empty carried connected set; any later stopSelection
    // intersects to empty. The empty group must be skipped entirely —
    // leaking `[{workspaceCwd, names: []}]` attaches a non-empty array to
    // both the success result and the failure error, riding the HTTP
    // 200/500 bodies (#8975).
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: [],
        requestedChannels: ['telegram'],
        lastConnectedChannels: [],
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toBeUndefined();
    // Empty capture must not short-circuit the tear-down (zombie shape,
    // see the degraded-canonicalization twin) (#8975).
    expect(group.stop).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({ enabled: false });
  });

  it('records the carried connected set when a stop lands in the mode-all crash-restart window (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    // The crash-restart shape the supervisor produces: the last committed
    // names are carried in `requestedChannels`, `channels` is the `['all']`
    // launch placeholder again, and the connected set from the last ready
    // report rides in `lastConnectedChannels`. Intersecting with the
    // placeholder would empty the capture (every stopped channel
    // resurrects); intersecting with the attempted set would record
    // channels that never connected. The capture must intersect the
    // carried CONNECTED set.
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'starting',
        channels: ['all'],
        requestedChannels: ['telegram', 'feishu'],
        lastConnectedChannels: ['telegram'],
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toEqual([
      { workspaceCwd: PRIMARY, names: ['telegram'] },
    ]);
  });

  it('records only the connected channels in a mode-names crash-restart window (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
    // Mode-names twin of the crash-restart window: the launch placeholder
    // equals the selection names, so intersecting with `channels` degrades
    // to the full attempted set and would record a channel whose connect
    // failed before the crash as explicitly stopped though it never ran.
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'starting',
        channels: ['telegram', 'feishu'],
        requestedChannels: ['telegram', 'feishu'],
        lastConnectedChannels: ['telegram'],
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toEqual([
      { workspaceCwd: PRIMARY, names: ['telegram'] },
    ]);
  });

  it('records nothing when a mode-names stop lands before the first ready report (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
    // The mode-names window BEFORE the first ready report: the selection
    // names ride in `requestedChannels`/`channels` from launch, but no
    // connected set exists yet (`lastConnectedChannels` undefined).
    // Falling back to the attempted set there would persist
    // never-connected channels as explicitly `stopped`, skipping them on
    // every later `--channel all` until manually started — contradicting
    // this capture's contract that only actually-connected channels are
    // recorded (#8975).
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'starting',
        channels: ['telegram', 'feishu'],
        requestedChannels: ['telegram', 'feishu'],
        lastConnectedChannels: undefined,
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toBeUndefined();
    // Empty capture must not short-circuit the tear-down (zombie shape,
    // see the degraded-canonicalization twin) (#8975).
    expect(group.stop).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({ enabled: false });
  });

  it('captures the attempted set once the worker is running with no carried connected set (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
    // Control twin of the pre-ready test above: the SAME snapshot with
    // `state: 'running'` has committed its channels via a ready report,
    // so the fallback to `channels` is authoritative and both names are
    // captured (#8975).
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'running',
        channels: ['telegram', 'feishu'],
        requestedChannels: ['telegram', 'feishu'],
        lastConnectedChannels: undefined,
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toEqual([
      { workspaceCwd: PRIMARY, names: ['telegram', 'feishu'] },
    ]);
  });

  it('unions the post-stop capture when a crash-restart ready commits during tear-down (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    // Supervisor-internal crash-restarts bypass the manager lane: a
    // relaunch whose ready report commits during the stop's tear-down
    // window connects channels the pre-stop capture never recorded (and
    // the worker already wrote them `active`). The pre-stop snapshot alone
    // would tear them down without a `stopped` record, resurrecting them
    // on the next `--channel all` — the exact regression this PR fixes.
    // The group must be re-read once stop() settles and both captures
    // unioned.
    // The fixture is asymmetric in BOTH directions: `feishu` is
    // contributed by the PRE-stop capture only (connected before the
    // stop, gone from the post-stop snapshot) and `whatsapp` by the
    // POST-stop capture only (requested but still unconnected pre-stop,
    // committed during the tear-down) — deleting EITHER capture turns
    // the expectation red, pinning both halves of the union instead of
    // just one superset (R10-21, R11-v3).
    const preStop = workerSnapshot({
      state: 'starting',
      channels: ['all'],
      requestedChannels: ['telegram', 'feishu', 'whatsapp'],
      lastConnectedChannels: ['telegram', 'feishu'],
    });
    const postStop = workerSnapshot({
      state: 'running',
      channels: ['telegram', 'whatsapp'],
      requestedChannels: ['telegram', 'whatsapp'],
      lastConnectedChannels: ['telegram', 'whatsapp'],
    });
    let stopped = false;
    vi.mocked(group.stop).mockImplementation(async () => {
      stopped = true;
    });
    vi.mocked(group.snapshots).mockImplementation(() =>
      stopped ? [postStop] : [preStop],
    );

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toEqual([
      { workspaceCwd: PRIMARY, names: ['telegram', 'feishu', 'whatsapp'] },
    ]);
  });

  it('unions the post-stop capture on a REJECTING stop too (#8975)', async () => {
    // Reject-path twin: the post-stop capture's `finally` placement exists
    // for stops that throw after a partial tear-down. Moving the push into
    // the success-only path keeps every resolve-path test green while a
    // crash-restart ready committing during a REJECTING multi-workspace
    // stop carries only the pre-stop capture — the channel that committed
    // in the window (already written `active` by the worker) gets no
    // `stopped` record and resurrects on the next `--channel all`
    // (R10-21). The fixture is asymmetric in BOTH directions (see the
    // resolve-path twin), so dropping the `finally` push turns this red
    // too (R11-v3).
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    const preStop = workerSnapshot({
      state: 'starting',
      channels: ['all'],
      requestedChannels: ['telegram', 'feishu', 'whatsapp'],
      lastConnectedChannels: ['telegram', 'feishu'],
    });
    const postStop = workerSnapshot({
      state: 'running',
      channels: ['telegram', 'whatsapp'],
      requestedChannels: ['telegram', 'whatsapp'],
      lastConnectedChannels: ['telegram', 'whatsapp'],
    });
    let stopped = false;
    vi.mocked(group.stop).mockImplementation(async () => {
      stopped = true;
      throw new Error('worker refused to exit');
    });
    vi.mocked(group.snapshots).mockImplementation(() =>
      stopped ? [postStop] : [preStop],
    );

    await expect(test.manager.stopSelection()).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
      stoppedChannels: [
        { workspaceCwd: PRIMARY, names: ['telegram', 'feishu', 'whatsapp'] },
      ],
    });
  });

  it('strips lastConnectedChannels from the public control state but not the stop capture (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    // `lastConnectedChannels` is an internal input of the stop capture,
    // undeclared in the SDK's DaemonChannelWorkerSnapshot: the control
    // state rides HTTP responses verbatim, so it must not leak there —
    // while the capture (which reads the group snapshots directly) must
    // keep seeing it (#8975).
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'starting',
        channels: ['all'],
        requestedChannels: ['telegram'],
        lastConnectedChannels: ['telegram'],
        // The dead-name computation's internal input (R9-6) must strip
        // from the control state alongside lastConnectedChannels —
        // narrowing the strip to the connected set leaks it on every
        // GET/PUT/DELETE /workspace/channel response (#8975).
        lastRequestedChannels: ['telegram'],
      }),
    ]);

    const state = test.manager.state();

    expect(state.workers[0]).not.toHaveProperty('lastConnectedChannels');
    expect(state.workers[0]).not.toHaveProperty('lastRequestedChannels');
    // Positive survival pin on the clone path: stripping the internal
    // fields must not delete SDK-declared fields — an over-strip ships
    // the control state without the fields the SDK's
    // DaemonChannelWorkerSnapshot declares (#8975).
    expect(state.workers[0]).toMatchObject({
      state: 'starting',
      channels: ['all'],
      requestedChannels: ['telegram'],
    });

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toEqual([
      { workspaceCwd: PRIMARY, names: ['telegram'] },
    ]);
  });

  it('strips lastConnectedChannels from every public snapshot surface (#8975)', async () => {
    // state() was already stripped; the sibling surfaces riding GET
    // /daemon/status (primarySnapshot/snapshots) and the reload responses
    // must strip too, or raw API clients couple to an internal stop-
    // capture input the SDK's DaemonChannelWorkerSnapshot does not
    // declare. The capture reads the group snapshots directly and must
    // stay untouched (#8975). lastRequestedChannels (the dead-name
    // computation's input, R9-6) strips alongside it.
    const leaked = workerSnapshot({
      channels: ['telegram'],
      requestedChannels: ['telegram'],
      lastConnectedChannels: ['telegram'],
      lastRequestedChannels: ['telegram'],
    });
    const group = fakeGroup({
      snapshots: vi.fn(() => [leaked]),
      primarySnapshot: vi.fn(() => leaked),
      // Feed reconcile's return with the SAME leaked worker (R11-43):
      // reload()/reloadWorkspace() currently discard reconcile's return,
      // but a refactor switching their return source to the reconcile
      // workers would keep every strip assertion green against the clean
      // default fake while production leaks both internal fields on the
      // POST /workspace/channel/reload HTTP responses.
      reconcile: vi.fn(async () => ({ changed: true, workers: [leaked] })),
    });
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });

    expect(test.manager.primarySnapshot()).not.toHaveProperty(
      'lastConnectedChannels',
    );
    expect(test.manager.primarySnapshot()).not.toHaveProperty(
      'lastRequestedChannels',
    );
    expect(test.manager.snapshots()[0]).not.toHaveProperty(
      'lastConnectedChannels',
    );
    expect(test.manager.snapshots()[0]).not.toHaveProperty(
      'lastRequestedChannels',
    );
    // Positive survival pins on the clone path: the strip must delete
    // ONLY the internal fields — an over-strip (an allow-list forgetting
    // `channels`/`state`, or one stray extra delete) keeps every
    // absence assertion green while the HTTP responses ship without the
    // fields the SDK's DaemonChannelWorkerSnapshot declares (#8975).
    expect(test.manager.primarySnapshot()).toMatchObject({
      channels: ['telegram'],
      state: 'running',
    });
    expect(test.manager.snapshots()[0]).toMatchObject({
      channels: ['telegram'],
      state: 'running',
    });
    const reloaded = await test.manager.reload();
    expect(reloaded).not.toHaveProperty('lastConnectedChannels');
    expect(reloaded).not.toHaveProperty('lastRequestedChannels');
    expect(reloaded).toMatchObject({
      channels: ['telegram'],
      state: 'running',
    });
    const reloadedWorkspace = await test.manager.reloadWorkspace(
      PRIMARY,
      'telegram',
    );
    expect(reloadedWorkspace).not.toHaveProperty('lastConnectedChannels');
    expect(reloadedWorkspace).not.toHaveProperty('lastRequestedChannels');
    expect(reloadedWorkspace).toMatchObject({
      channels: ['telegram'],
      state: 'running',
    });
    // The capture's input is intact.
    expect(group.snapshots()[0]).toHaveProperty('lastConnectedChannels', [
      'telegram',
    ]);
    // ownershipSnapshots is the in-process ownership view, never
    // serialized over HTTP: it must KEEP the carried sets, or the
    // service's terminal-worker predicates read stripped snapshots and
    // go dead (R10-1).
    expect(test.manager.ownershipSnapshots()[0]).toHaveProperty(
      'lastConnectedChannels',
      ['telegram'],
    );
    expect(test.manager.ownershipSnapshots()[0]).toHaveProperty(
      'lastRequestedChannels',
      ['telegram'],
    );
  });

  it('relaunches a terminal-failed mode-all worker on a per-channel start (#8975)', async () => {
    // Budget exhausted AFTER ready committed: the terminal snapshot keeps
    // `channels` (the connected set) but drops requestedChannels/adapters.
    // committedChannelNames() must skip the dead worker, or the natural
    // recovery command `qwen channel start telegram` early-returns
    // {changed: false} on it and the channel stays down — no restart is
    // scheduled and nothing else relaunches the worker (#8975).
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['telegram'],
        requestedChannels: undefined,
        adapters: undefined,
        lastConnectedChannels: ['telegram'],
        // The ready-committed attempted set survives on the terminal
        // snapshot for the dead-name computation (R9-6).
        lastRequestedChannels: ['telegram'],
        error: 'Channel worker restart budget exhausted.',
      }),
    ]);

    expect(test.manager.committedChannelNames()).toEqual([]);

    const result = await test.manager.setChannelEnabled(
      { name: 'telegram', workspaceCwd: PRIMARY },
      true,
    );

    expect(result).toMatchObject({ changed: true });
    expect(test.resolveGroups).toHaveBeenLastCalledWith(
      { mode: 'names', names: ['telegram'] },
      'set',
    );
    expect(group.reconcile).toHaveBeenCalledTimes(1);
  });

  it('rejects starting a non-carried channel on a terminal mode-all worker instead of committing it (R19-1, R21-12)', async () => {
    // Mode-all twin of the R21-12 names-mode pin: a mode-`all`
    // commitment carries no name list, committedChannelNames() skips
    // terminal-failed workers wholesale (the R8-18 start/recovery
    // contract), and the NEW name is not in the dead worker's carried
    // set — so its workspace rides preserveWorkspaceCwds and reconcile
    // drops the target wholesale. Committing the name anyway would
    // latch a phantom (changed:true, nothing running, every retry
    // early-returns success), and the only alternative — replacing the
    // terminal entry — resurrects the carried crash-loopers on a fresh
    // budget. The start must fail fast and direct the user to the
    // worker restart (R21-12). The carried-name union this shape used
    // to pin stays covered by the carried-name relaunch pin above
    // (#8975) and the disable-direction collapse pin below (R19-1).
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['all'],
        requestedChannels: undefined,
        adapters: undefined,
        lastConnectedChannels: ['telegram', 'feishu'],
        lastRequestedChannels: ['telegram', 'feishu'],
        error: 'Channel worker restart budget exhausted.',
      }),
    ]);

    // The dead worker's names stay excluded from the filtered view.
    expect(test.manager.committedChannelNames()).toEqual([]);

    await expect(
      test.manager.setChannelEnabled(
        { name: 'slack', workspaceCwd: PRIMARY },
        true,
      ),
    ).rejects.toMatchObject({ code: 'channel_worker_start_failed' });

    expect(group.reconcile).not.toHaveBeenCalled();
    // The mode-`all` commitment stays intact — nothing was committed.
    expect(test.manager.state().selection).toEqual({ mode: 'all' });
  });

  it('retains terminal mode-all carried names instead of collapsing to a whole-stop when the last live channel is disabled (R19-1)', async () => {
    // Mode-all sibling of the R15-17 collapse pin: disabling the LAST
    // live channel under a mode-`all` commitment must trim to the dead
    // worker's carried names — not collapse to names=[] whose whole-stop
    // capture intersects the terminal worker's carried connected set and
    // persists the crashed (never user-stopped) channels as clean
    // stopped records (crash laundering against R9-5) (R19-1).
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['all'],
        requestedChannels: undefined,
        adapters: undefined,
        lastConnectedChannels: ['dead'],
        lastRequestedChannels: ['dead'],
        primary: false,
        error: 'Channel worker restart budget exhausted.',
      }),
      workerSnapshot({
        state: 'running',
        channels: ['live'],
        requestedChannels: ['live'],
        primary: false,
      }),
    ]);

    // The dead worker's names stay excluded from the filtered view.
    expect(test.manager.committedChannelNames()).toEqual(['live']);

    const result = await test.manager.setChannelEnabled(
      { name: 'live', workspaceCwd: PRIMARY },
      false,
    );

    // Trimmed to the carried dead name, not collapsed to a whole-stop:
    // the lease stays reserved and the committed selection keeps `dead`.
    expect(result).toMatchObject({ changed: true });
    expect(test.releaseLease).not.toHaveBeenCalled();
    expect(test.manager.state().selection).toEqual({
      mode: 'names',
      names: ['dead'],
    });
  });

  // The R19-1 rebuild pins above mock reconcile away (fakeGroup), so the
  // relaunch side effect of resolving the dead worker's carried names is
  // unobserved there. These pins watch the reconcile contract itself:
  // the manager must hand reconcile preserveWorkspaceCwds for every
  // terminal-failed worker that does not carry the toggled name, or the
  // dead workspace is replaced with a fresh entry on a FRESH restart
  // budget — resurrecting the crash-looping channel the budget exists to
  // stop (R20-3).
  const terminalSecondary = (): ChannelWorkerGroupSnapshot =>
    workerSnapshot({
      state: 'failed',
      workspaceId: 'secondary',
      workspaceCwd: SECONDARY,
      primary: false,
      channels: [],
      requestedChannels: undefined,
      adapters: undefined,
      lastRequestedChannels: ['secondary-dead'],
      lastConnectedChannels: ['secondary-dead'],
      error: 'Channel worker restart budget exhausted.',
    });

  function setupDeadSibling() {
    const group = fakeGroup();
    const test = setup(group);
    test.resolveGroups.mockImplementation(async (selection) =>
      splitWorkspaceGroups(selection),
    );
    return { group, test };
  }

  it('preserves the terminal-failed workspace on a sibling disable rebuild (R20-3)', async () => {
    const { group, test } = setupDeadSibling();
    await test.manager.setSelection({
      mode: 'names',
      names: ['live', 'secondary-dead'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['live'],
        requestedChannels: ['live'],
      }),
      terminalSecondary(),
    ]);

    // The dead worker's names stay excluded from the filtered view.
    expect(test.manager.committedChannelNames()).toEqual(['live']);

    const result = await test.manager.setChannelEnabled(
      { name: 'live', workspaceCwd: PRIMARY },
      false,
    );

    // The committed selection keeps the dead name (the R19-1 contract)...
    expect(result).toMatchObject({ changed: true });
    expect(test.manager.state().selection).toEqual({
      mode: 'names',
      names: ['secondary-dead'],
    });
    // ...but the reconcile must not touch the dead workspace: its target
    // (resolved from the carried name) rides preserveWorkspaceCwds, so no
    // fresh entry relaunches `secondary-dead` on a fresh budget.
    expect(group.reconcile).toHaveBeenCalledTimes(1);
    const reconcileOptions = vi.mocked(group.reconcile).mock.calls[0]![1];
    expect(reconcileOptions?.preserveWorkspaceCwds).toEqual(
      new Set([SECONDARY]),
    );
  });

  it('preserves the terminal-failed workspace on a sibling enable rebuild (R20-3)', async () => {
    const { group, test } = setupDeadSibling();
    await test.manager.setSelection({
      mode: 'names',
      names: ['live', 'secondary-dead'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['live'],
        requestedChannels: ['live'],
      }),
      terminalSecondary(),
    ]);

    const result = await test.manager.setChannelEnabled(
      { name: 'new', workspaceCwd: PRIMARY },
      true,
    );

    expect(result).toMatchObject({ changed: true });
    expect(test.resolveGroups).toHaveBeenLastCalledWith(
      { mode: 'names', names: ['live', 'secondary-dead', 'new'] },
      'set',
    );
    expect(test.manager.state().selection).toEqual({
      mode: 'names',
      names: ['live', 'secondary-dead', 'new'],
    });
    const reconcileOptions = vi.mocked(group.reconcile).mock.calls[0]![1];
    expect(reconcileOptions?.preserveWorkspaceCwds).toEqual(
      new Set([SECONDARY]),
    );
  });

  it('does not preserve the terminal workspace when disabling its own ghost name (R20-3)', async () => {
    // The ghost-removal contract (R15-17) must survive the preserve fix:
    // disabling a dead-committed name re-commits the trimmed selection,
    // and the dead workspace's entry goes with it — preserving it here
    // would leave a stale entry for a channel that no longer exists.
    const { group, test } = setupDeadSibling();
    await test.manager.setSelection({
      mode: 'names',
      names: ['live', 'secondary-dead'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['live'],
        requestedChannels: ['live'],
      }),
      terminalSecondary(),
    ]);

    const result = await test.manager.setChannelEnabled(
      { name: 'secondary-dead', workspaceCwd: SECONDARY },
      false,
    );

    expect(result).toMatchObject({ changed: true });
    expect(test.manager.state().selection).toEqual({
      mode: 'names',
      names: ['live'],
    });
    expect(group.reconcile).toHaveBeenCalledTimes(1);
    const reconcileOptions = vi.mocked(group.reconcile).mock.calls[0]![1];
    expect(reconcileOptions?.preserveWorkspaceCwds).toBeUndefined();
  });

  it('preserves the terminal-failed workspace on a refreshWorkspaces reconcile (R21-11)', async () => {
    // The routine attach/detach trigger reconciles the committed
    // selection ghost names included (reloadSelection only filters
    // persisted stopped records, which budget exhaustion never writes).
    // Without the preserve guard the dead workspace's entry is replaced
    // on a FRESH restart budget — the R20-3 resurrection reached through
    // the reload-op path: every re-exhaustion plus next attach/detach
    // relaunches the crash-looping channel again (R21-11).
    const { group, test } = setupDeadSibling();
    await test.manager.setSelection({
      mode: 'names',
      names: ['live', 'secondary-dead'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['live'],
        requestedChannels: ['live'],
      }),
      terminalSecondary(),
    ]);

    await test.manager.refreshWorkspaces();

    // The resolve keeps the ghost name...
    expect(test.resolveGroups).toHaveBeenLastCalledWith(
      { mode: 'names', names: ['live', 'secondary-dead'] },
      'reload',
    );
    // ...and the reconcile receives the terminal workspace as preserved.
    expect(group.reconcile).toHaveBeenCalledTimes(1);
    const reconcileOptions = vi.mocked(group.reconcile).mock.calls[0]![1];
    expect(reconcileOptions?.preserveWorkspaceCwds).toEqual(
      new Set([SECONDARY]),
    );
  });

  it('preserves the terminal-failed workspace on a forced reload reconcile (R21-11)', async () => {
    // reload()'s force:true skips the unchanged gate unconditionally, so
    // the preserve check — which the entry loop runs BEFORE that gate —
    // is the only thing standing between a routine reload and a fresh
    // restart budget for the crash-looping channel (R21-11).
    const { group, test } = setupDeadSibling();
    await test.manager.setSelection({
      mode: 'names',
      names: ['live', 'secondary-dead'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['live'],
        requestedChannels: ['live'],
      }),
      terminalSecondary(),
    ]);

    await test.manager.reload();

    expect(test.resolveGroups).toHaveBeenLastCalledWith(
      { mode: 'names', names: ['live', 'secondary-dead'] },
      'reload',
    );
    expect(group.reconcile).toHaveBeenCalledTimes(1);
    const reconcileOptions = vi.mocked(group.reconcile).mock.calls[0]![1];
    expect(reconcileOptions?.force).toBe(true);
    expect(reconcileOptions?.preserveWorkspaceCwds).toEqual(
      new Set([SECONDARY]),
    );
  });

  it('rejects starting a channel the terminal-failed owner worker never carried (R21-12)', async () => {
    // The owner workspace rides preserveWorkspaceCwds (a relaunch would
    // resurrect the carried crash-looper on a fresh budget), so
    // reconcile drops the new name's target wholesale. Committing the
    // name anyway would latch a phantom: `currentlyEnabled` then
    // early-returns success on every retry while nothing runs, and only
    // a worker restart or daemon restart recovers it. The start must
    // fail fast with a structured error instead (R21-12).
    const { group, test } = setupDeadSibling();
    await test.manager.setSelection({
      mode: 'names',
      names: ['live', 'secondary-dead'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['live'],
        requestedChannels: ['live'],
      }),
      terminalSecondary(),
    ]);

    await expect(
      test.manager.setChannelEnabled(
        { name: 'secondary-new', workspaceCwd: SECONDARY },
        true,
      ),
    ).rejects.toMatchObject({ code: 'channel_worker_start_failed' });

    expect(group.reconcile).not.toHaveBeenCalled();
    // Nothing was committed — the phantom latch must not engage, and the
    // dead sibling stays retained (R15-17).
    expect(test.manager.state().selection).toEqual({
      mode: 'names',
      names: ['live', 'secondary-dead'],
    });
    expect(test.manager.committedChannelNames()).toEqual(['live']);
  });

  it('relaunches a terminal-failed mode-names worker on a per-channel start (#8975)', async () => {
    // Mode-names twin: the committed names come from the selection, not
    // the worker snapshot, so the dead worker's names must be subtracted
    // there too; an explicit start is the only path back up (#8975).
    const group = fakeGroup({ isHealthy: vi.fn(() => false) });
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['telegram'],
        requestedChannels: undefined,
        adapters: undefined,
        lastRequestedChannels: ['telegram'],
        error: 'Channel worker restart budget exhausted.',
      }),
    ]);

    expect(test.manager.committedChannelNames()).toEqual([]);

    const result = await test.manager.setChannelEnabled(
      { name: 'telegram', workspaceCwd: PRIMARY },
      true,
    );

    expect(result).toMatchObject({ changed: true });
    expect(group.reconcile).toHaveBeenCalledTimes(1);
  });

  it('keeps a crashed-but-restart-scheduled worker committed (R11-37)', async () => {
    // Manager-side twin of the service predicate pin (R11-v4):
    // isTerminalFailedWorker's `&& nextRestartAt === undefined` clause is
    // the boundary between a budget-exhausted TERMINAL worker and a
    // crashed worker with a restart still SCHEDULED. Every other
    // failed-worker fixture leaves nextRestartAt unset, so collapsing the
    // predicate to `state === 'failed'` shipped green — making
    // committedChannelNames() drop a scheduled-restart worker's names,
    // so a per-channel start in that window reconciles a replacement
    // against the mid-relaunch worker instead of idempotently returning
    // {changed: false}.
    const group = fakeGroup({ isHealthy: vi.fn(() => false) });
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['telegram'],
        requestedChannels: undefined,
        adapters: undefined,
        lastRequestedChannels: ['telegram'],
        nextRestartAt: new Date(Date.now() + 5000).toISOString(),
        error: 'Channel worker crashed; restart scheduled.',
      }),
    ]);

    // The scheduled restart keeps the worker NON-terminal: its names stay
    // committed.
    expect(test.manager.committedChannelNames()).toEqual(['telegram']);

    const result = await test.manager.setChannelEnabled(
      { name: 'telegram', workspaceCwd: PRIMARY },
      true,
    );
    // Idempotent: no replacement reconcile against the mid-relaunch
    // worker.
    expect(result).toMatchObject({ changed: false });
    expect(group.reconcile).not.toHaveBeenCalled();
  });

  it('keeps a crashed-but-restart-scheduled mode-all worker committed (R11-37)', async () => {
    // Mode-all twin of the boundary test above: the mode-`all` branch of
    // committedChannelNames uses the same isTerminalFailedWorker
    // predicate but reads its names from the worker snapshots, so
    // widening the skip to every failed worker drops a scheduled-restart
    // worker's names during the backoff window — committedChannelNames()
    // returns [] and a per-channel start rebuilds a replacement selection
    // against the mid-relaunch worker (the R11-v5 defect shape) instead
    // of idempotently returning {changed: false} (#8975).
    const group = fakeGroup({ isHealthy: vi.fn(() => false) });
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['all'],
        requestedChannels: ['telegram'],
        nextRestartAt: new Date(Date.now() + 5000).toISOString(),
        error: 'Channel worker crashed; restart scheduled.',
      }),
    ]);

    // The scheduled restart keeps the worker NON-terminal: its carried
    // names stay committed.
    expect(test.manager.committedChannelNames()).toEqual(['telegram']);

    const result = await test.manager.setChannelEnabled(
      { name: 'telegram', workspaceCwd: PRIMARY },
      true,
    );
    // Idempotent: no replacement reconcile against the mid-relaunch
    // worker.
    expect(result).toMatchObject({ changed: false });
    expect(group.reconcile).not.toHaveBeenCalled();
  });

  it('relaunches a never-connected channel on a terminal-failed mode-names worker (R9-6)', async () => {
    // The dead-name computation must consume the FULL attempted set
    // (lastRequestedChannels), not just the last ready's connected subset
    // in `channels`: feishu's connect failed before the crash, so it is
    // absent from `channels`. Without the attempted set feishu stays
    // "committed" on the dead worker and its own start throws
    // channel_runtime_owner_mismatch (assertCommittedOwner finds no
    // owning worker) instead of relaunching — the channel is
    // unrecoverable through its own start command (R9-6).
    const group = fakeGroup({ isHealthy: vi.fn(() => false) });
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['telegram'],
        requestedChannels: undefined,
        adapters: undefined,
        lastConnectedChannels: ['telegram'],
        lastRequestedChannels: ['telegram', 'feishu'],
        error: 'Channel worker restart budget exhausted.',
      }),
    ]);

    // BOTH names are dead on the terminal worker — feishu included.
    expect(test.manager.committedChannelNames()).toEqual([]);

    const result = await test.manager.setChannelEnabled(
      { name: 'feishu', workspaceCwd: PRIMARY },
      true,
    );

    // R15-17: the enable rebuild sources names from the COMMITTED
    // selection, not the filtered committedChannelNames() view, so the
    // dead sibling `telegram` is retained (not silently dropped) and the
    // recovery reconcile relaunches the whole committed selection.
    // feishu — the never-connected channel this test targets — is still
    // relaunched.
    expect(result).toMatchObject({ changed: true });
    expect(test.resolveGroups).toHaveBeenLastCalledWith(
      { mode: 'names', names: ['telegram', 'feishu'] },
      'set',
    );
    expect(group.reconcile).toHaveBeenCalledTimes(1);

    // The disable direction must not throw the 409 owner-mismatch for a
    // dead channel: it trims feishu from the committed selection
    // (retaining the dead sibling telegram — no collapse to the
    // whole-stop, R15-17) rather than rejecting.
    const disable = await test.manager.setChannelEnabled(
      { name: 'feishu', workspaceCwd: PRIMARY },
      false,
    );
    expect(disable).toMatchObject({ changed: true });
    expect(test.resolveGroups).toHaveBeenLastCalledWith(
      { mode: 'names', names: ['telegram'] },
      'set',
    );
  });

  it('retains a dead sibling instead of collapsing to a whole-stop when the last live channel is disabled (R15-17)', async () => {
    // Symptom 2 (collapse): committed [dead, live], `dead` on a
    // terminal-failed worker (excluded from committedChannelNames),
    // `live` healthy. Disabling the LAST live channel must trim to
    // [dead] — rebuilding from the committed selection's source of truth
    // — NOT collapse to names=[] whose whole-stop capture intersects the
    // terminal worker's carried connected set and persists the crashed
    // (never user-stopped) `dead` channel as a clean stopped record
    // (crash laundering against R9-5).
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['dead', 'live'],
    });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['dead'],
        requestedChannels: undefined,
        adapters: undefined,
        lastConnectedChannels: ['dead'],
        error: 'Channel worker restart budget exhausted.',
      }),
      workerSnapshot({
        state: 'running',
        channels: ['live'],
        requestedChannels: ['live'],
        primary: false,
      }),
    ]);

    // dead is excluded from the filtered view, live is committed.
    expect(test.manager.committedChannelNames()).toEqual(['live']);

    const result = await test.manager.setChannelEnabled(
      { name: 'live', workspaceCwd: PRIMARY },
      false,
    );

    // Trimmed to the dead sibling, not collapsed to a whole-stop: the
    // lease stays reserved and the committed selection keeps `dead`.
    expect(result).toMatchObject({ changed: true });
    expect(test.releaseLease).not.toHaveBeenCalled();
    expect(test.manager.state().selection).toEqual({
      mode: 'names',
      names: ['dead'],
    });
  });

  it('records only the connected channels from a budget-exhausted mode-names worker (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
    // Budget-exhausted TERMINAL snapshot: the supervisor drops
    // requestedChannels/adapters (an explicit start must not see the dead
    // worker as enabled) but keeps lastConnectedChannels for this capture
    // and lastRequestedChannels for the dead-name computation (R9-6);
    // `channels` is the last ready's connected subset. Intersecting with
    // the attempted set would record a never-connected channel as
    // explicitly stopped, skipping it on every later `--channel all`
    // start — the capture must ignore lastRequestedChannels and record
    // only the connected set (#8975).
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['telegram'],
        requestedChannels: undefined,
        lastConnectedChannels: ['telegram'],
        lastRequestedChannels: ['telegram', 'feishu'],
        error: 'Channel worker restart budget exhausted.',
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toEqual([
      { workspaceCwd: PRIMARY, names: ['telegram'] },
    ]);
  });

  it('records the carried connected set from a budget-exhausted mode-all worker (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    // Mode-all twin: `channels` is still the `['all']` launch placeholder
    // and requestedChannels is gone — without the carried connected set
    // the capture would record NOTHING and lose the explicit
    // whole-selection stop entirely (every channel resurrects) (#8975).
    // The ready-committed attempted set rides lastRequestedChannels for
    // the dead-name computation (R9-6); the capture must still record
    // exactly the connected set.
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['all'],
        requestedChannels: undefined,
        lastConnectedChannels: ['telegram', 'feishu'],
        lastRequestedChannels: ['telegram', 'feishu'],
        error: 'Channel worker restart budget exhausted.',
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toEqual([
      { workspaceCwd: PRIMARY, names: ['telegram', 'feishu'] },
    ]);
  });

  it('records nothing from a budget-exhausted worker that never connected (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
    // Budget exhausted before any ready report ever committed: nothing
    // actually connected, so there is no carried connected set and
    // nothing to record — the attempted set must not be pinned as
    // stopped. The attempted set IS carried on lastRequestedChannels
    // (launch derives it from the selection) for the dead-name
    // computation (R9-6); the capture must ignore it here (#8975).
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        state: 'failed',
        channels: ['telegram', 'feishu'],
        requestedChannels: undefined,
        lastConnectedChannels: undefined,
        lastRequestedChannels: ['telegram', 'feishu'],
        error: 'Channel worker restart budget exhausted.',
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toBeUndefined();
    // Empty capture must not short-circuit the tear-down (zombie shape,
    // see the degraded-canonicalization twin) (#8975).
    expect(group.stop).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({ enabled: false });
  });

  it('keeps the stop capture alive when workspace canonicalization fails (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['telegram'],
        requestedChannels: ['telegram'],
      }),
    ]);
    // canonicalizeWorkspace rethrows non-ENOENT fs errors by design; a
    // degraded worker path must degrade to the resolved form instead of
    // escaping the stop before any tear-down as an opaque 500 with no
    // structured code or stoppedChannels.
    mockCanonicalizeWorkspace.mockImplementation(() => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    try {
      await expect(test.manager.stopSelection()).resolves.toMatchObject({
        changed: true,
        stoppedChannels: [
          { workspaceCwd: path.resolve(PRIMARY), names: ['telegram'] },
        ],
      });
    } finally {
      mockCanonicalizeWorkspace.mockImplementation((p: string) =>
        path.resolve(p),
      );
    }
    // The degraded path must degrade to the resolved form AFTER a full
    // tear-down, not return the capture without one: a stop that reports
    // these names as torn down but never ran the tear-down would get them
    // persisted as stopped while the workers stay alive — zombies skipped
    // by every later `--channel all` (#8975).
    expect(group.stop).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({ enabled: false });
  });

  it('groups torn-down channels per workspace on stop (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'all' });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        workspaceId: 'primary',
        workspaceCwd: PRIMARY,
        primary: true,
        channels: ['telegram'],
        requestedChannels: ['telegram'],
      }),
      workerSnapshot({
        workspaceId: 'secondary',
        workspaceCwd: SECONDARY,
        primary: false,
        channels: ['feishu'],
        requestedChannels: ['feishu'],
      }),
    ]);

    const result = await test.manager.stopSelection();

    expect(result.stoppedChannels).toEqual([
      { workspaceCwd: PRIMARY, names: ['telegram'] },
      { workspaceCwd: SECONDARY, names: ['feishu'] },
    ]);
  });

  it('captures stopped channels under the canonical workspace form (#8975)', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.snapshots).mockReturnValue([
      workerSnapshot({
        channels: ['telegram'],
        requestedChannels: ['telegram'],
      }),
    ]);
    // Simulate a workspace whose canonical form diverges from the raw
    // path (e.g. a symlinked cwd): the capture must carry the CANONICAL
    // form, matching the daemon worker's canonical restore read — the
    // expected value is computed from the literal canonical value, not
    // through the mock, so dropping canonicalization from
    // stoppedChannelsByWorkspace would carry the raw path and turn this
    // red: stops persisted under the raw hash are missed by the restore
    // read and the channels resurrect on `--channel all` (#8975).
    mockCanonicalizeWorkspace.mockImplementation((p: string) =>
      p === PRIMARY ? `/canonical${PRIMARY}` : path.resolve(p),
    );

    try {
      const result = await test.manager.stopSelection();
      expect(result.stoppedChannels).toEqual([
        { workspaceCwd: `/canonical${PRIMARY}`, names: ['telegram'] },
      ]);
    } finally {
      mockCanonicalizeWorkspace.mockImplementation((p: string) =>
        path.resolve(p),
      );
    }
  });

  it('omits torn-down channels when only a lease was reserved (#8975)', async () => {
    const test = setup();
    test.createGroup.mockImplementationOnce(() => {
      throw new Error('group construction failed');
    });
    // The failed rollback cannot release the lease, so the stop only has a
    // lease to clean up — no workers, hence no channel names to persist.
    test.releaseLease.mockImplementationOnce(() => {
      throw new Error('lease release failed');
    });
    await expect(
      test.manager.setSelection({ mode: 'names', names: ['telegram'] }),
    ).rejects.toMatchObject({ code: 'channel_worker_start_failed' });

    const result = await test.manager.stopSelection();

    expect(result.changed).toBe(true);
    expect(result.stoppedChannels).toBeUndefined();
    // The stop must still release the lease held by the failed start: in
    // production the lease is the channel-service pidfile reservation, so
    // skipping release() here leaves a stale lease that refuses every
    // later channel start until a daemon restart (#8975). Two calls: the
    // failed rollback attempt plus the successful stop release.
    expect(test.releaseLease).toHaveBeenCalledTimes(2);
  });

  it('rejects webhook work after shutdown latches', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });

    await test.manager.shutdown();

    await expect(
      test.manager.enqueueWebhookTask({
        channelName: 'telegram',
        source: 'alerts',
        eventType: 'failed',
        targetRef: 'default',
        title: 'Build failed',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'channel_worker_unavailable' });
    expect(group.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it('rejects delivery while shutdown is draining workers', async () => {
    let releaseStop!: () => void;
    const group = fakeGroup({
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStop = resolve;
          }),
      ),
    });
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });

    const shutdown = test.manager.shutdown();
    await vi.waitFor(() => expect(group.stop).toHaveBeenCalled());

    await expect(
      test.manager.deliverChannelMessage(PRIMARY, {
        deliveryId: 'task-1:1000',
        channelName: 'telegram',
        target: { type: 'chat', id: 'group-42' },
        text: 'daily result',
      }),
    ).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
      message: 'Daemon is shutting down.',
    });
    expect(group.deliverChannelMessage).not.toHaveBeenCalled();

    releaseStop();
    await shutdown;
  });

  it('routes delivery through the committed group and exact workspace', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram'],
    });
    const delivery = {
      deliveryId: 'task-1:1000',
      channelName: 'telegram',
      target: { type: 'chat' as const, id: 'group-42' },
      text: 'daily result',
    };

    await expect(
      test.manager.deliverChannelMessage(PRIMARY, delivery),
    ).resolves.toEqual({ delivered: true });
    expect(group.deliverChannelMessage).toHaveBeenCalledWith(delivery, PRIMARY);
  });

  it('serializes mutations and rejects queued work once shutdown latches', async () => {
    let releaseStart!: () => void;
    const group = fakeGroup({
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStart = resolve;
          }),
      ),
    });
    const test = setup(group);
    const enabling = test.manager.setSelection({
      mode: 'names',
      names: ['telegram'],
    });
    await vi.waitFor(() => expect(group.start).toHaveBeenCalled());
    const shutdown = test.manager.shutdown();
    const queuedSet = test.manager.setSelection({
      mode: 'names',
      names: ['discord'],
    });

    releaseStart();
    await enabling;
    await shutdown;
    await expect(queuedSet).rejects.toBeInstanceOf(ChannelWorkerControlError);
    await expect(queuedSet).rejects.toMatchObject({ code: 'daemon_draining' });
    expect(test.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('finishes mutations queued before shutdown in FIFO order', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    let releaseFirst!: () => void;
    vi.mocked(group.reconcile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ changed: true, workers: group.snapshots() });
        }),
    );

    const first = test.manager.setSelection({
      mode: 'names',
      names: ['discord'],
    });
    const second = test.manager.setSelection({
      mode: 'names',
      names: ['feishu'],
    });
    const shutdown = test.manager.shutdown();
    await vi.waitFor(() => expect(group.reconcile).toHaveBeenCalledTimes(1));
    releaseFirst();

    await expect(first).resolves.toMatchObject({ changed: true });
    await expect(second).resolves.toMatchObject({ changed: true });
    await shutdown;
    expect(group.reconcile).toHaveBeenCalledTimes(2);
    expect(group.stop).toHaveBeenCalledTimes(1);
  });

  it('publishes stopping while daemon shutdown waits for workers', async () => {
    let releaseStop!: () => void;
    const group = fakeGroup({
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStop = resolve;
          }),
      ),
    });
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });

    const shutdown = test.manager.shutdown();
    await vi.waitFor(() => {
      expect(test.manager.state().transition).toBe('stopping');
    });
    releaseStop();
    await shutdown;

    expect(test.manager.state()).toMatchObject({
      enabled: false,
      transition: 'idle',
    });
  });

  it('keeps the lease and worker references during synchronous forced shutdown', async () => {
    const test = setup();
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });

    test.manager.killAllSync();

    expect(test.group.killAllSync).toHaveBeenCalledTimes(1);
    expect(test.releaseLease).not.toHaveBeenCalled();
    expect(test.manager.state()).toMatchObject({ enabled: true });
  });

  it('does not create a worker after forced shutdown interrupts group resolution', async () => {
    const test = setup();
    let releaseGroups!: () => void;
    test.resolveGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGroups = () =>
            resolve(workspaceGroups({ mode: 'names', names: ['telegram'] }));
        }),
    );

    const enabling = test.manager.setSelection({
      mode: 'names',
      names: ['telegram'],
    });
    await vi.waitFor(() => expect(test.resolveGroups).toHaveBeenCalledTimes(1));
    test.manager.killAllSync();
    releaseGroups();

    await expect(enabling).rejects.toMatchObject({ code: 'daemon_draining' });
    expect(test.reserveLease).not.toHaveBeenCalled();
    expect(test.createGroup).not.toHaveBeenCalled();
    expect(test.group.start).not.toHaveBeenCalled();
  });
});
