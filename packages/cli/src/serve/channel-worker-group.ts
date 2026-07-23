/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChannelStartupAttemptFailure,
  ChannelWorkerLogEntry,
  ChannelWorkerRestartPolicy,
  ChannelWorkerSnapshot,
  ChannelWorkerSupervisor,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
import { ChannelWorkerStartupError } from './channel-worker-supervisor.js';
import { ChannelWebhookEnqueueError } from './channel-webhook-ipc.js';
import type { ChannelWorkspaceGroup } from './channel-workspace-grouping.js';
import type { WorkspaceRegistry } from './workspace-registry.js';

/** A channel worker snapshot annotated with its owning workspace. */
export interface ChannelWorkerGroupSnapshot extends ChannelWorkerSnapshot {
  workspaceId: string;
  workspaceCwd: string;
  primary: boolean;
}

export interface ChannelWorkerGroupReconcileResult {
  changed: boolean;
  workers: ChannelWorkerGroupSnapshot[];
}

export class ChannelWorkerReconcileError extends Error {
  readonly rolledBack: boolean;
  readonly rollbackError?: string;
  readonly stopFailed: boolean;
  readonly startupFailures?: ChannelStartupAttemptFailure[];
  readonly startupFailuresTruncated?: boolean;

  constructor(
    message: string,
    options: {
      rolledBack: boolean;
      rollbackError?: string;
      stopFailed?: boolean;
      startupFailures?: readonly ChannelStartupAttemptFailure[];
      startupFailuresTruncated?: boolean;
    },
  ) {
    super(message);
    this.name = 'ChannelWorkerReconcileError';
    this.rolledBack = options.rolledBack;
    this.rollbackError = options.rollbackError;
    this.stopFailed = options.stopFailed === true;
    this.startupFailures = options.startupFailures?.map((failure) => ({
      ...failure,
    }));
    this.startupFailuresTruncated = options.startupFailuresTruncated;
  }
}

/**
 * Manages one `ChannelWorkerSupervisor` per owning workspace. Single-workspace
 * runs collapse to one primary supervisor, preserving the legacy behavior.
 */
export interface ChannelWorkerGroup {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconcile(
    groups: readonly ChannelWorkspaceGroup[],
    options?: { force?: boolean; onRollingBack?: () => void },
  ): Promise<ChannelWorkerGroupReconcileResult>;
  isHealthy(): boolean;
  killAllSync(): void;
  snapshots(): ChannelWorkerGroupSnapshot[];
  /** Primary workspace snapshot, backing the legacy single-worker fields. */
  primarySnapshot(): ChannelWorkerSnapshot;
  beginWorkspaceDrain(workspaceCwd: string): void;
  cancelWorkspaceDrain(workspaceCwd: string): void;
  workspaceActivity(workspaceCwd: string): number;
  removeWorkspace(workspaceCwd: string): Promise<void>;
  restoreWorkspace(workspaceCwd: string): Promise<void>;
  enqueueWebhookTask: ChannelWorkerSupervisor['enqueueWebhookTask'];
}

export interface ChannelWorkerGroupSharedOptions {
  cliEntryPath: string;
  daemonUrl: string;
  daemonToken?: string;
  restartPolicy?: ChannelWorkerRestartPolicy;
  startupTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface CreateChannelWorkerGroupOptions {
  groups: readonly ChannelWorkspaceGroup[];
  registry: WorkspaceRegistry;
  createSupervisor: (
    opts: CreateChannelWorkerSupervisorOptions,
  ) => ChannelWorkerSupervisor;
  shared: ChannelWorkerGroupSharedOptions;
  onReady?: (snapshot: ChannelWorkerGroupSnapshot) => void;
  onExit?: (snapshot: ChannelWorkerGroupSnapshot) => void;
  onStateChange?: () => void;
  onLog?: (entry: ChannelWorkerLogEntry & { workspaceCwd: string }) => void;
}

const DISABLED_SNAPSHOT: ChannelWorkerSnapshot = {
  enabled: false,
  state: 'disabled',
  channels: [],
};

interface ChannelWorkerGroupEntry {
  workspaceId: string;
  workspaceCwd: string;
  primary: boolean;
  selection: ChannelWorkspaceGroup['selection'];
  generation: number;
  supervisor: ChannelWorkerSupervisor;
  stopPromise?: Promise<void>;
}

function selectionsEqual(
  left: ChannelWorkspaceGroup['selection'],
  right: ChannelWorkspaceGroup['selection'],
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === 'all') return true;
  if (right.mode === 'all' || left.names.length !== right.names.length) {
    return false;
  }
  return left.names.every((name, index) => name === right.names[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startupFailureDetails(error: unknown): {
  startupFailures?: readonly ChannelStartupAttemptFailure[];
  startupFailuresTruncated?: boolean;
} {
  if (!(error instanceof ChannelWorkerStartupError)) return {};
  return {
    startupFailures: error.startupFailures,
    ...(error.startupFailuresTruncated
      ? { startupFailuresTruncated: true }
      : {}),
  };
}

export function createChannelWorkerGroup(
  opts: CreateChannelWorkerGroupOptions,
): ChannelWorkerGroup {
  let generation = 0;
  let entries = new Map<string, ChannelWorkerGroupEntry>();
  const groupsByWorkspace = new Map(
    opts.groups.map((group) => [group.workspaceCwd, group]),
  );
  const pendingEntries = new Set<ChannelWorkerGroupEntry>();
  const pendingGenerations = new Map<string, number>();
  const drainingWorkspaces = new Set<string>();
  const removalPromises = new Map<string, Promise<void>>();
  let reconciling: Promise<ChannelWorkerGroupReconcileResult> | undefined;
  let stopping = false;
  let groupStarted = false;

  const withMeta = (
    entry: ChannelWorkerGroupEntry,
    snapshot: ChannelWorkerSnapshot,
  ): ChannelWorkerGroupSnapshot => ({
    ...snapshot,
    ...(snapshot.startupFailures
      ? {
          startupFailures: snapshot.startupFailures.map((failure) => ({
            ...failure,
          })),
        }
      : {}),
    workspaceId: entry.workspaceId,
    workspaceCwd: entry.workspaceCwd,
    primary: entry.primary,
  });
  const createEntry = (
    group: ChannelWorkspaceGroup,
  ): ChannelWorkerGroupEntry => {
    const runtime = opts.registry.getByWorkspaceCwd(group.workspaceCwd);
    if (!runtime) {
      throw new Error(
        `Channel worker group references unregistered workspace "${group.workspaceCwd}".`,
      );
    }
    if (!runtime.trusted) {
      throw Object.assign(
        new Error(
          `Channel worker group workspace "${runtime.workspaceCwd}" is not trusted.`,
        ),
        { code: 'untrusted_workspace' },
      );
    }

    const entryGeneration = ++generation;
    const withRuntimeMeta = (
      snapshot: ChannelWorkerSnapshot,
    ): ChannelWorkerGroupSnapshot => ({
      ...snapshot,
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
      primary: runtime.primary,
    });
    const supervisor = opts.createSupervisor({
      cliEntryPath: opts.shared.cliEntryPath,
      daemonUrl: opts.shared.daemonUrl,
      ...(opts.shared.daemonToken
        ? { daemonToken: opts.shared.daemonToken }
        : {}),
      workspace: runtime.workspaceCwd,
      selection: group.selection,
      // Multi-workspace runtimes expose a per-workspace env overlay; a
      // parent-process runtime leaves it undefined so the supervisor inherits
      // process.env exactly as before.
      ...(runtime.env.effectiveEnv
        ? { workerBaseEnv: runtime.env.effectiveEnv }
        : {}),
      ...(opts.shared.restartPolicy
        ? { restartPolicy: opts.shared.restartPolicy }
        : {}),
      ...(opts.shared.startupTimeoutMs !== undefined
        ? { startupTimeoutMs: opts.shared.startupTimeoutMs }
        : {}),
      ...(opts.shared.heartbeatTimeoutMs !== undefined
        ? { heartbeatTimeoutMs: opts.shared.heartbeatTimeoutMs }
        : {}),
      ...(opts.onReady
        ? {
            onReady: (snapshot) => {
              if (
                entries.get(runtime.workspaceCwd)?.generation ===
                entryGeneration
              ) {
                opts.onReady!(withRuntimeMeta(snapshot));
              } else if (
                pendingGenerations.get(runtime.workspaceCwd) !== entryGeneration
              ) {
                opts.onLog?.({
                  stream: 'stderr',
                  line: `Ignored stale channel worker ready (generation=${entryGeneration}).`,
                  workspaceCwd: runtime.workspaceCwd,
                });
              }
            },
          }
        : {}),
      ...(opts.onExit
        ? {
            onExit: (snapshot) => {
              if (
                entries.get(runtime.workspaceCwd)?.generation ===
                entryGeneration
              ) {
                opts.onExit!(withRuntimeMeta(snapshot));
              } else if (
                pendingGenerations.get(runtime.workspaceCwd) !== entryGeneration
              ) {
                opts.onLog?.({
                  stream: 'stderr',
                  line: `Ignored stale channel worker exit (generation=${entryGeneration}).`,
                  workspaceCwd: runtime.workspaceCwd,
                });
              }
            },
          }
        : {}),
      ...(opts.onLog
        ? {
            onLog: (logEntry) =>
              opts.onLog!({
                ...logEntry,
                workspaceCwd: runtime.workspaceCwd,
              }),
          }
        : {}),
    });
    return {
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
      primary: runtime.primary,
      selection: group.selection,
      generation: entryGeneration,
      supervisor,
    };
  };

  for (const group of opts.groups) {
    const entry = createEntry(group);
    entries.set(entry.workspaceCwd, entry);
  }

  const entrySnapshots = (): ChannelWorkerGroupSnapshot[] =>
    [...entries.values()].map((entry) =>
      withMeta(entry, entry.supervisor.snapshot()),
    );

  const stopEntry = (entry: ChannelWorkerGroupEntry): Promise<void> => {
    if (!entry.stopPromise) {
      const stopPromise = entry.supervisor
        .stop()
        .finally(() => opts.onStateChange?.());
      entry.stopPromise = stopPromise;
      void stopPromise.then(
        () => {
          if (entry.stopPromise === stopPromise) entry.stopPromise = undefined;
        },
        () => {
          if (entry.stopPromise === stopPromise) entry.stopPromise = undefined;
        },
      );
    }
    return entry.stopPromise;
  };

  const stopEntriesBestEffort = async (
    entriesToStop: readonly ChannelWorkerGroupEntry[],
  ): Promise<void> => {
    await Promise.allSettled(entriesToStop.map((entry) => stopEntry(entry)));
  };

  const stopAllEntries = async (
    entriesToStop: readonly ChannelWorkerGroupEntry[],
  ): Promise<void> => {
    const results = await Promise.allSettled(
      entriesToStop.map((entry) => stopEntry(entry)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  };

  const stopEntriesForRollback = async (
    entriesToStop: readonly ChannelWorkerGroupEntry[],
  ): Promise<{
    error?: string;
    failedEntries: ChannelWorkerGroupEntry[];
  }> => {
    let firstError: string | undefined;
    const failedEntries: ChannelWorkerGroupEntry[] = [];
    for (const entry of entriesToStop) {
      try {
        await stopEntry(entry);
      } catch (error) {
        firstError ??= errorMessage(error);
        failedEntries.push(entry);
      }
    }
    return {
      ...(firstError ? { error: firstError } : {}),
      failedEntries,
    };
  };

  const restoreEntries = async (
    entriesToRestore: readonly ChannelWorkerGroupEntry[],
  ): Promise<{ rolledBack: boolean; rollbackError?: string }> => {
    let firstError: string | undefined;
    for (const entry of entriesToRestore) {
      try {
        await entry.supervisor.start();
      } catch (error) {
        firstError ??= errorMessage(error);
      }
    }
    return firstError
      ? { rolledBack: false, rollbackError: firstError }
      : { rolledBack: true };
  };

  const routeEntry = (
    channelName: string,
  ): ChannelWorkerGroupEntry | undefined => {
    for (const entry of entries.values()) {
      if (
        entry.selection.mode === 'all' ||
        entry.selection.names.includes(channelName)
      ) {
        return entry;
      }
    }
    return undefined;
  };

  const detachEntry = (entry: ChannelWorkerGroupEntry): void => {
    if (entries.get(entry.workspaceCwd)?.generation === entry.generation) {
      entries.delete(entry.workspaceCwd);
    }
    pendingEntries.delete(entry);
    if (pendingGenerations.get(entry.workspaceCwd) === entry.generation) {
      pendingGenerations.delete(entry.workspaceCwd);
    }
  };

  const group: ChannelWorkerGroup = {
    async start() {
      // Start sequentially so a failing initial launch can roll back every
      // worker that already reached ready before propagating the failure.
      stopping = false;
      const started: ChannelWorkerGroupEntry[] = [];
      try {
        for (const entry of entries.values()) {
          if (drainingWorkspaces.has(entry.workspaceCwd)) {
            throw new Error('Workspace drained during channel worker startup.');
          }
          if (stopping) {
            throw new Error('Channel worker group stopped during startup.');
          }
          started.push(entry);
          await entry.supervisor.start();
          if (stopping) {
            throw new Error('Channel worker group stopped during startup.');
          }
          if (
            entries.get(entry.workspaceCwd)?.generation !== entry.generation ||
            drainingWorkspaces.has(entry.workspaceCwd)
          ) {
            throw new Error('Workspace drained during channel worker startup.');
          }
        }
        groupStarted = true;
      } catch (error) {
        groupStarted = false;
        await stopEntriesBestEffort(started);
        throw error;
      }
    },
    async stop() {
      stopping = true;
      groupStarted = false;
      await reconciling?.catch(() => {});
      await stopAllEntries([...entries.values()]);
    },
    reconcile(targetGroups, reconcileOptions) {
      if (stopping) {
        return Promise.reject(
          new ChannelWorkerReconcileError(
            'Channel worker group has not completed stopping.',
            { rolledBack: true, stopFailed: true },
          ),
        );
      }
      if (drainingWorkspaces.size > 0) {
        return Promise.reject(
          new ChannelWorkerReconcileError(
            'Channel worker configuration cannot change while a workspace is draining.',
            { rolledBack: true },
          ),
        );
      }
      if (reconciling) return reconciling;
      reconciling = (async () => {
        const targets = new Map(
          targetGroups.map((target) => [target.workspaceCwd, target]),
        );
        const unchanged = new Map<string, ChannelWorkerGroupEntry>();
        const oldAffected: ChannelWorkerGroupEntry[] = [];
        const newEntries: ChannelWorkerGroupEntry[] = [];

        for (const [workspaceCwd, entry] of entries) {
          const target = targets.get(workspaceCwd);
          const healthy = entry.supervisor.snapshot().state === 'running';
          if (
            target &&
            !reconcileOptions?.force &&
            healthy &&
            selectionsEqual(entry.selection, target.selection)
          ) {
            unchanged.set(workspaceCwd, entry);
            targets.delete(workspaceCwd);
          } else {
            oldAffected.push(entry);
          }
        }
        for (const target of targets.values()) {
          const entry = createEntry(target);
          newEntries.push(entry);
          pendingEntries.add(entry);
          pendingGenerations.set(entry.workspaceCwd, entry.generation);
        }
        if (oldAffected.length === 0 && newEntries.length === 0) {
          return { changed: false, workers: entrySnapshots() };
        }

        const stoppedOld: ChannelWorkerGroupEntry[] = [];
        try {
          for (const entry of oldAffected) {
            await stopEntry(entry);
            stoppedOld.push(entry);
          }
        } catch (error) {
          reconcileOptions?.onRollingBack?.();
          const rollback = await restoreEntries(stoppedOld);
          throw new ChannelWorkerReconcileError(errorMessage(error), {
            ...rollback,
            stopFailed: true,
          });
        }

        const startedNew: ChannelWorkerGroupEntry[] = [];
        try {
          for (const entry of newEntries) {
            if (drainingWorkspaces.has(entry.workspaceCwd)) {
              throw new Error(
                'Workspace drained during channel worker reconcile.',
              );
            }
            if (stopping) {
              throw new Error('Channel worker group stopped during reconcile.');
            }
            startedNew.push(entry);
            await entry.supervisor.start();
            if (stopping) {
              throw new Error('Channel worker group stopped during reconcile.');
            }
            if (drainingWorkspaces.has(entry.workspaceCwd)) {
              throw new Error(
                'Workspace drained during channel worker reconcile.',
              );
            }
          }
          if (drainingWorkspaces.size > 0) {
            throw new Error(
              'Workspace drained during channel worker reconcile.',
            );
          }
        } catch (error) {
          reconcileOptions?.onRollingBack?.();
          const startupDetails = startupFailureDetails(error);
          const cleanup = await stopEntriesForRollback(startedNew);
          if (cleanup.error) {
            for (const entry of cleanup.failedEntries) {
              entries.set(entry.workspaceCwd, entry);
            }
            throw new ChannelWorkerReconcileError(errorMessage(error), {
              rolledBack: false,
              rollbackError: cleanup.error,
              ...startupDetails,
            });
          }
          if (stopping) {
            throw new ChannelWorkerReconcileError(errorMessage(error), {
              rolledBack: false,
              ...startupDetails,
            });
          }
          const rollback = await restoreEntries(stoppedOld);
          throw new ChannelWorkerReconcileError(errorMessage(error), {
            ...rollback,
            ...startupDetails,
          });
        }

        const committed = new Map(unchanged);
        for (const entry of newEntries) {
          committed.set(entry.workspaceCwd, entry);
        }
        entries = committed;
        const targetWorkspaceCwds = new Set(
          targetGroups.map((target) => target.workspaceCwd),
        );
        for (const workspaceCwd of groupsByWorkspace.keys()) {
          if (!targetWorkspaceCwds.has(workspaceCwd)) {
            groupsByWorkspace.delete(workspaceCwd);
          }
        }
        for (const target of targetGroups) {
          groupsByWorkspace.set(target.workspaceCwd, target);
        }
        return { changed: true, workers: entrySnapshots() };
      })().finally(() => {
        pendingEntries.clear();
        pendingGenerations.clear();
        reconciling = undefined;
      });
      return reconciling;
    },
    isHealthy() {
      return (
        entries.size > 0 &&
        [...entries.values()].every(
          (entry) => entry.supervisor.snapshot().state === 'running',
        )
      );
    },
    killAllSync() {
      stopping = true;
      groupStarted = false;
      for (const entry of entries.values()) {
        entry.supervisor.killAllSync();
      }
      for (const entry of pendingEntries) {
        entry.supervisor.killAllSync();
      }
    },
    snapshots: entrySnapshots,
    primarySnapshot() {
      const primary = [...entries.values()].find((entry) => entry.primary);
      return primary?.supervisor.snapshot() ?? { ...DISABLED_SNAPSHOT };
    },
    beginWorkspaceDrain(workspaceCwd) {
      drainingWorkspaces.add(workspaceCwd);
    },
    cancelWorkspaceDrain(workspaceCwd) {
      drainingWorkspaces.delete(workspaceCwd);
    },
    workspaceActivity(workspaceCwd) {
      if (pendingGenerations.has(workspaceCwd)) return 1;
      const entry = entries.get(workspaceCwd);
      if (!entry) return 0;
      const snapshot = entry.supervisor.snapshot();
      return snapshot.state === 'starting' ||
        snapshot.state === 'running' ||
        snapshot.nextRestartAt !== undefined
        ? 1
        : 0;
    },
    removeWorkspace(workspaceCwd) {
      const existing = removalPromises.get(workspaceCwd);
      if (existing) return existing;
      drainingWorkspaces.add(workspaceCwd);
      const removal = (async () => {
        try {
          await reconciling?.catch(() => {});
          const entry = entries.get(workspaceCwd);
          if (!entry) return;
          let killError: unknown;
          try {
            await stopEntry(entry);
          } catch {
            try {
              entry.supervisor.killAllSync();
            } catch (err) {
              killError = err;
            }
          } finally {
            detachEntry(entry);
          }
          if (killError) throw killError;
        } finally {
          drainingWorkspaces.delete(workspaceCwd);
        }
      })();
      removalPromises.set(workspaceCwd, removal);
      void removal.then(
        () => {
          if (removalPromises.get(workspaceCwd) === removal) {
            removalPromises.delete(workspaceCwd);
          }
        },
        () => {
          if (removalPromises.get(workspaceCwd) === removal) {
            removalPromises.delete(workspaceCwd);
          }
        },
      );
      return removal;
    },
    async restoreWorkspace(workspaceCwd) {
      if (entries.has(workspaceCwd)) return;
      const target = groupsByWorkspace.get(workspaceCwd);
      if (!target) return;
      const entry = createEntry(target);
      entries.set(workspaceCwd, entry);
      if (!groupStarted || stopping) {
        detachEntry(entry);
        return;
      }
      try {
        await entry.supervisor.start();
        if (stopping || !groupStarted) {
          await stopEntry(entry).catch(() => {
            try {
              entry.supervisor.killAllSync();
            } catch {
              // Best-effort cleanup after the group stopped concurrently.
            }
          });
          detachEntry(entry);
        }
      } catch (err) {
        await stopEntry(entry).catch(() => {
          try {
            entry.supervisor.killAllSync();
          } catch {
            // Preserve the start failure that caused the rollback.
          }
        });
        detachEntry(entry);
        throw err;
      }
    },
    async enqueueWebhookTask(task) {
      const entry = routeEntry(task.channelName);
      if (!entry || drainingWorkspaces.has(entry.workspaceCwd)) {
        throw new ChannelWebhookEnqueueError(
          'channel_worker_unavailable',
          `No channel worker owns channel "${task.channelName}".`,
        );
      }
      return entry.supervisor.enqueueWebhookTask(task);
    },
  };
  return group;
}
