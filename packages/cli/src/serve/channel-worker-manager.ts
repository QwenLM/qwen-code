/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelWebhookTask } from '@qwen-code/channel-base';
import { ChannelWebhookEnqueueError } from './channel-webhook-ipc.js';
import type {
  ChannelWorkerGroup,
  ChannelWorkerGroupSnapshot,
} from './channel-worker-group.js';
import { ChannelWorkerReconcileError } from './channel-worker-group.js';
import {
  ChannelWorkerStartupError,
  ChannelWorkerStopError,
} from './channel-worker-supervisor.js';
import type {
  ChannelStartupAttemptFailure,
  ChannelWorkerSnapshot,
} from './channel-worker-supervisor.js';
import type { ChannelWorkspaceGroup } from './channel-workspace-grouping.js';
import type { ServeChannelSelection } from './types.js';

export type ChannelWorkerControlTransition =
  | 'idle'
  | 'starting'
  | 'reconciling'
  | 'stopping'
  | 'rolling_back';

export interface ChannelWorkerControlState {
  enabled: boolean;
  selection: ServeChannelSelection | null;
  pendingSelection?: ServeChannelSelection;
  transition: ChannelWorkerControlTransition;
  workers: ChannelWorkerGroupSnapshot[];
}

export interface ChannelWorkerSetResult {
  changed: boolean;
  replaced: boolean;
  partial: boolean;
  state: ChannelWorkerControlState;
  /** Internal HTTP status hint; omitted from the response body. */
  created?: boolean;
}

export interface ChannelWorkerStopResult {
  changed: boolean;
  state: ChannelWorkerControlState;
}

export class ChannelWorkerControlError extends Error {
  readonly code:
    | 'channel_worker_start_failed'
    | 'channel_worker_stop_failed'
    | 'channel_worker_not_enabled'
    | 'channel_runtime_owner_mismatch'
    | 'daemon_draining';
  readonly rolledBack?: boolean;
  readonly rollbackError?: string;
  readonly startupFailures?: ChannelStartupAttemptFailure[];
  readonly startupFailuresTruncated?: boolean;

  constructor(
    code: ChannelWorkerControlError['code'],
    message: string,
    details: {
      rolledBack?: boolean;
      rollbackError?: string;
      startupFailures?: readonly ChannelStartupAttemptFailure[];
      startupFailuresTruncated?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ChannelWorkerControlError';
    this.code = code;
    this.rolledBack = details.rolledBack;
    this.rollbackError = details.rollbackError;
    this.startupFailures = details.startupFailures?.map((failure) => ({
      ...failure,
    }));
    this.startupFailuresTruncated = details.startupFailuresTruncated;
  }
}

export interface CreateChannelWorkerManagerOptions {
  resolveGroups: (
    selection: ServeChannelSelection,
    operation: 'initial' | 'set' | 'reload',
  ) => Promise<readonly ChannelWorkspaceGroup[]>;
  createGroup: (groups: readonly ChannelWorkspaceGroup[]) => ChannelWorkerGroup;
  reserveLease: (selection: ServeChannelSelection) => void;
  releaseLease: () => void;
  initialLeaseReserved?: boolean;
  onCommittedSelection?: (
    selection: ServeChannelSelection | undefined,
    groups: readonly ChannelWorkspaceGroup[],
  ) => void;
  onStateChange?: (state: ChannelWorkerControlState) => void;
}

export interface ChannelWorkerManager {
  startInitial(selection: ServeChannelSelection): Promise<void>;
  setSelection(
    selection: ServeChannelSelection,
    requiredOwner?: ChannelWorkerRequiredOwner,
  ): Promise<ChannelWorkerSetResult>;
  stopSelection(): Promise<ChannelWorkerStopResult>;
  reload(): Promise<ChannelWorkerSnapshot>;
  reloadWorkspace(workspaceCwd: string): Promise<ChannelWorkerSnapshot>;
  state(): ChannelWorkerControlState;
  primarySnapshot(): ChannelWorkerSnapshot;
  snapshots(): ChannelWorkerGroupSnapshot[];
  committedChannelNames(): string[];
  enqueueWebhookTask(
    task: ChannelWebhookTask,
  ): ReturnType<ChannelWorkerGroup['enqueueWebhookTask']>;
  beginWorkspaceDrain(workspaceCwd: string): void;
  cancelWorkspaceDrain(workspaceCwd: string): void;
  workspaceActivity(workspaceCwd: string): number;
  removeWorkspace(workspaceCwd: string): Promise<void>;
  restoreWorkspace(workspaceCwd: string): Promise<void>;
  refreshWorkspaces(): Promise<void>;
  workerChanged(): void;
  shutdown(): Promise<void>;
  killAllSync(): void;
}

export interface ChannelWorkerRequiredOwner {
  name: string;
  workspaceCwd: string;
}

const DISABLED_SNAPSHOT: ChannelWorkerSnapshot = {
  enabled: false,
  state: 'disabled',
  channels: [],
};

function cloneSelection(
  selection: ServeChannelSelection,
): ServeChannelSelection {
  return selection.mode === 'all'
    ? { mode: 'all' }
    : { mode: 'names', names: [...selection.names] };
}

function cloneGroups(
  groups: readonly ChannelWorkspaceGroup[],
): ChannelWorkspaceGroup[] {
  return groups.map((group) => ({
    workspaceCwd: group.workspaceCwd,
    selection: cloneSelection(group.selection),
  }));
}

function selectionsEqual(
  left: ServeChannelSelection | undefined,
  right: ServeChannelSelection,
): boolean {
  if (!left || left.mode !== right.mode) return false;
  if (left.mode === 'all') return true;
  if (right.mode === 'all' || left.names.length !== right.names.length) {
    return false;
  }
  return left.names.every((name, index) => name === right.names[index]);
}

function isPartial(workers: readonly ChannelWorkerGroupSnapshot[]): boolean {
  return workers.some((worker) => {
    if (!worker.requestedChannels) return false;
    const connected = new Set(worker.channels);
    return worker.requestedChannels.some((name) => !connected.has(name));
  });
}

function groupIncludesName(
  group: ChannelWorkspaceGroup,
  name: string,
): boolean {
  return group.selection.mode === 'all' || group.selection.names.includes(name);
}

function assertRequiredOwner(
  targetGroups: readonly ChannelWorkspaceGroup[],
  requiredOwner: ChannelWorkerRequiredOwner,
): void {
  const owners = targetGroups.filter((target) =>
    groupIncludesName(target, requiredOwner.name),
  );
  if (
    owners.length !== 1 ||
    owners[0]!.workspaceCwd !== requiredOwner.workspaceCwd
  ) {
    throw new ChannelWorkerControlError(
      'channel_runtime_owner_mismatch',
      `Channel "${requiredOwner.name}" does not resolve to workspace "${requiredOwner.workspaceCwd}".`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startupFailureDetails(error: unknown): {
  startupFailures?: readonly ChannelStartupAttemptFailure[];
  startupFailuresTruncated?: boolean;
} {
  if (
    !(
      error instanceof ChannelWorkerStartupError ||
      error instanceof ChannelWorkerReconcileError
    ) ||
    !error.startupFailures
  ) {
    return {};
  }
  return {
    startupFailures: error.startupFailures,
    ...(error.startupFailuresTruncated
      ? { startupFailuresTruncated: true }
      : {}),
  };
}

export function createChannelWorkerManager(
  opts: CreateChannelWorkerManagerOptions,
): ChannelWorkerManager {
  let committedSelection: ServeChannelSelection | undefined;
  let committedGroups: ChannelWorkspaceGroup[] = [];
  let pendingSelection: ServeChannelSelection | undefined;
  let transition: ChannelWorkerControlTransition = 'idle';
  let group: ChannelWorkerGroup | undefined;
  let leaseReserved = opts.initialLeaseReserved === true;
  let draining = false;
  let hardKilled = false;
  let lane: Promise<void> = Promise.resolve();
  const workspaceDrains = new Set<string>();

  const snapshot = (): ChannelWorkerControlState => ({
    enabled:
      committedSelection !== undefined || group !== undefined || leaseReserved,
    selection: committedSelection ? cloneSelection(committedSelection) : null,
    ...(pendingSelection
      ? { pendingSelection: cloneSelection(pendingSelection) }
      : {}),
    transition,
    workers: group?.snapshots() ?? [],
  });

  const notify = () => {
    opts.onStateChange?.(snapshot());
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lane.then(operation, operation);
    lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const drainingError = () =>
    new ChannelWorkerControlError(
      'daemon_draining',
      'Daemon is shutting down.',
    );

  const reserve = (selection: ServeChannelSelection) => {
    if (leaseReserved) return;
    opts.reserveLease(selection);
    leaseReserved = true;
  };

  const release = () => {
    if (!leaseReserved) return;
    opts.releaseLease();
    leaseReserved = false;
  };

  const setTransition = (
    next: ChannelWorkerControlTransition,
    pending?: ServeChannelSelection,
  ) => {
    transition = next;
    pendingSelection = pending ? cloneSelection(pending) : undefined;
    notify();
  };

  const commit = (
    selection: ServeChannelSelection | undefined,
    groups: readonly ChannelWorkspaceGroup[],
  ) => {
    committedSelection = selection ? cloneSelection(selection) : undefined;
    committedGroups = cloneGroups(groups);
    transition = 'idle';
    pendingSelection = undefined;
    opts.onCommittedSelection?.(committedSelection, groups);
    notify();
  };

  const classifyFailure = (
    error: unknown,
    fallbackCode: 'channel_worker_start_failed' | 'channel_worker_stop_failed',
  ): ChannelWorkerControlError => {
    if (error instanceof ChannelWorkerReconcileError) {
      return new ChannelWorkerControlError(
        error.stopFailed ? 'channel_worker_stop_failed' : fallbackCode,
        error.message,
        {
          rolledBack: error.rolledBack,
          ...(error.rollbackError
            ? { rollbackError: error.rollbackError }
            : {}),
          ...startupFailureDetails(error),
        },
      );
    }
    return new ChannelWorkerControlError(
      error instanceof ChannelWorkerStopError
        ? 'channel_worker_stop_failed'
        : fallbackCode,
      errorMessage(error),
      startupFailureDetails(error),
    );
  };

  const applySelection = async (
    selection: ServeChannelSelection,
    initial: boolean,
    resolvedGroups?: readonly ChannelWorkspaceGroup[],
  ): Promise<ChannelWorkerSetResult> => {
    if (hardKilled) throw drainingError();
    const enabling = !snapshot().enabled;
    const replacing = committedSelection !== undefined;
    const sameSelection = selectionsEqual(committedSelection, selection);
    if (sameSelection && group?.isHealthy()) {
      return {
        changed: false,
        replaced: false,
        partial: isPartial(group.snapshots()),
        state: snapshot(),
        created: false,
      };
    }

    setTransition(replacing ? 'reconciling' : 'starting', selection);
    let targetGroups: readonly ChannelWorkspaceGroup[];
    try {
      targetGroups =
        resolvedGroups ??
        (await opts.resolveGroups(selection, initial ? 'initial' : 'set'));
      if (hardKilled) throw drainingError();
      reserve(selection);
    } catch (error) {
      setTransition('idle');
      throw error;
    }

    if (!group) {
      let candidate: ChannelWorkerGroup;
      try {
        candidate = opts.createGroup(targetGroups);
      } catch (error) {
        let cleanupError: unknown;
        if (!initial) {
          try {
            release();
          } catch (releaseError) {
            cleanupError = releaseError;
          }
        }
        setTransition('idle');
        throw new ChannelWorkerControlError(
          'channel_worker_start_failed',
          errorMessage(error),
          cleanupError
            ? { rolledBack: false, rollbackError: errorMessage(cleanupError) }
            : { rolledBack: !initial },
        );
      }
      group = candidate;
      for (const workspaceCwd of workspaceDrains) {
        candidate.beginWorkspaceDrain(workspaceCwd);
      }
      notify();
      try {
        await candidate.start();
      } catch (error) {
        const startupDetails = startupFailureDetails(error);
        let cleanupError: unknown;
        try {
          await candidate.stop();
        } catch (stopError) {
          cleanupError = stopError;
        }
        if (!cleanupError) {
          if (!initial) {
            try {
              release();
            } catch (releaseError) {
              cleanupError = releaseError;
            }
          }
          if (!cleanupError) group = undefined;
        }
        setTransition('idle');
        throw new ChannelWorkerControlError(
          'channel_worker_start_failed',
          errorMessage(error),
          cleanupError
            ? {
                rolledBack: false,
                rollbackError: errorMessage(cleanupError),
                ...startupDetails,
              }
            : { rolledBack: true, ...startupDetails },
        );
      }
      commit(selection, targetGroups);
      return {
        changed: true,
        replaced: false,
        partial: isPartial(candidate.snapshots()),
        state: snapshot(),
        created: enabling,
      };
    }

    try {
      const result = await group.reconcile(targetGroups, {
        onRollingBack: () => setTransition('rolling_back', selection),
      });
      commit(selection, targetGroups);
      return {
        changed: result.changed || !sameSelection,
        replaced: !sameSelection,
        partial: isPartial(result.workers),
        state: snapshot(),
        created: enabling,
      };
    } catch (error) {
      setTransition('idle');
      throw classifyFailure(error, 'channel_worker_start_failed');
    }
  };

  const manager: ChannelWorkerManager = {
    async startInitial(selection) {
      if (draining) throw drainingError();
      await enqueue(async () => {
        await applySelection(selection, true);
      });
    },
    setSelection(selection, requiredOwner) {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        if (!requiredOwner) return applySelection(selection, false);
        const targetGroups = await opts.resolveGroups(selection, 'set');
        assertRequiredOwner(targetGroups, requiredOwner);
        if (hardKilled) throw drainingError();
        return applySelection(selection, false, targetGroups);
      });
    },
    stopSelection() {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        const hadState = group !== undefined || leaseReserved;
        if (!hadState) {
          return { changed: false, state: snapshot() };
        }
        setTransition('stopping');
        try {
          if (group) {
            await group.stop();
            group = undefined;
          }
          release();
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_stop_failed');
        }
        commit(undefined, []);
        return { changed: hadState, state: snapshot() };
      });
    },
    reload() {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        if (!group || !committedSelection) {
          throw new ChannelWorkerControlError(
            'channel_worker_not_enabled',
            'This daemon has no channel worker to reload.',
          );
        }
        setTransition('reconciling', committedSelection);
        let targetGroups: readonly ChannelWorkspaceGroup[];
        try {
          targetGroups = await opts.resolveGroups(committedSelection, 'reload');
        } catch (error) {
          setTransition('idle');
          throw error;
        }
        if (hardKilled) throw drainingError();
        try {
          await group.reconcile(targetGroups, {
            force: true,
            onRollingBack: () =>
              setTransition('rolling_back', committedSelection),
          });
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_start_failed');
        }
        commit(committedSelection, targetGroups);
        const snapshots = group.snapshots();
        return (
          snapshots.find((worker) => worker.primary) ??
          snapshots[0] ?? { ...DISABLED_SNAPSHOT }
        );
      });
    },
    reloadWorkspace(workspaceCwd) {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        if (!group || !committedSelection) {
          throw new ChannelWorkerControlError(
            'channel_worker_not_enabled',
            'This daemon has no channel worker to reload.',
          );
        }
        setTransition('reconciling', committedSelection);
        let targetGroups: readonly ChannelWorkspaceGroup[];
        try {
          targetGroups = await opts.resolveGroups(committedSelection, 'reload');
          if (
            targetGroups.filter(
              (target) => target.workspaceCwd === workspaceCwd,
            ).length !== 1 ||
            committedGroups.filter(
              (target) => target.workspaceCwd === workspaceCwd,
            ).length !== 1
          ) {
            throw new ChannelWorkerControlError(
              'channel_runtime_owner_mismatch',
              `Workspace "${workspaceCwd}" does not own a committed channel worker.`,
            );
          }
        } catch (error) {
          setTransition('idle');
          throw error;
        }
        if (hardKilled) throw drainingError();
        try {
          await group.reconcile(targetGroups, {
            forceWorkspaceCwd: workspaceCwd,
            onRollingBack: () =>
              setTransition('rolling_back', committedSelection),
          });
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_start_failed');
        }
        const targetGroup = targetGroups.find(
          (target) => target.workspaceCwd === workspaceCwd,
        )!;
        const nextCommittedGroups = committedGroups.map((committedGroup) =>
          committedGroup.workspaceCwd === workspaceCwd
            ? targetGroup
            : committedGroup,
        );
        commit(committedSelection, nextCommittedGroups);
        const worker = group
          .snapshots()
          .find((snapshot) => snapshot.workspaceCwd === workspaceCwd);
        if (!worker) {
          throw new ChannelWorkerControlError(
            'channel_runtime_owner_mismatch',
            `Workspace "${workspaceCwd}" has no channel worker after reload.`,
          );
        }
        return worker;
      });
    },
    state: snapshot,
    primarySnapshot: () => group?.primarySnapshot() ?? { ...DISABLED_SNAPSHOT },
    snapshots: () => group?.snapshots() ?? [],
    committedChannelNames() {
      if (!committedSelection) return [];
      if (committedSelection.mode === 'names') {
        return [...committedSelection.names];
      }
      const names = new Set<string>();
      for (const worker of group?.snapshots() ?? []) {
        for (const name of worker.requestedChannels ?? worker.channels) {
          names.add(name);
        }
      }
      return [...names];
    },
    enqueueWebhookTask(task) {
      if (!group || draining) {
        return Promise.reject(
          new ChannelWebhookEnqueueError(
            'channel_worker_unavailable',
            draining
              ? 'Daemon is shutting down.'
              : 'Channel worker is not running.',
          ),
        ) as ReturnType<ChannelWorkerGroup['enqueueWebhookTask']>;
      }
      return group.enqueueWebhookTask(task);
    },
    beginWorkspaceDrain(workspaceCwd) {
      workspaceDrains.add(workspaceCwd);
      group?.beginWorkspaceDrain(workspaceCwd);
    },
    cancelWorkspaceDrain(workspaceCwd) {
      workspaceDrains.delete(workspaceCwd);
      group?.cancelWorkspaceDrain(workspaceCwd);
    },
    workspaceActivity(workspaceCwd) {
      return group?.workspaceActivity(workspaceCwd) ?? 0;
    },
    removeWorkspace(workspaceCwd) {
      return enqueue(async () => {
        try {
          await group?.removeWorkspace(workspaceCwd);
          notify();
        } finally {
          workspaceDrains.delete(workspaceCwd);
        }
      });
    },
    restoreWorkspace(workspaceCwd) {
      return enqueue(async () => {
        await group?.restoreWorkspace(workspaceCwd);
        notify();
      });
    },
    refreshWorkspaces() {
      return enqueue(async () => {
        if (!group || !committedSelection) return;
        setTransition('reconciling', committedSelection);
        let targetGroups: readonly ChannelWorkspaceGroup[];
        try {
          targetGroups = await opts.resolveGroups(committedSelection, 'reload');
        } catch (error) {
          setTransition('idle');
          throw error;
        }
        if (hardKilled) throw drainingError();
        try {
          await group.reconcile(targetGroups);
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_start_failed');
        }
        commit(committedSelection, targetGroups);
      });
    },
    workerChanged: notify,
    shutdown() {
      draining = true;
      return enqueue(async () => {
        if (group || leaseReserved) setTransition('stopping');
        try {
          if (group) {
            await group.stop();
            group = undefined;
          }
          release();
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_stop_failed');
        }
        commit(undefined, []);
      });
    },
    killAllSync() {
      draining = true;
      hardKilled = true;
      group?.killAllSync();
      pendingSelection = undefined;
      transition = 'idle';
      notify();
    },
  };
  return manager;
}
