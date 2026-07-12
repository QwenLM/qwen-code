/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChannelWorkerLogEntry,
  ChannelWorkerRestartPolicy,
  ChannelWorkerSnapshot,
  ChannelWorkerSupervisor,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
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

  constructor(
    message: string,
    options: {
      rolledBack: boolean;
      rollbackError?: string;
      stopFailed?: boolean;
    },
  ) {
    super(message);
    this.name = 'ChannelWorkerReconcileError';
    this.rolledBack = options.rolledBack;
    this.rollbackError = options.rollbackError;
    this.stopFailed = options.stopFailed === true;
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

export function createChannelWorkerGroup(
  opts: CreateChannelWorkerGroupOptions,
): ChannelWorkerGroup {
  let generation = 0;
  let entries = new Map<string, ChannelWorkerGroupEntry>();
  const pendingGenerations = new Map<string, number>();
  let reconciling: Promise<ChannelWorkerGroupReconcileResult> | undefined;
  let stopping = false;

  const withMeta = (
    entry: ChannelWorkerGroupEntry,
    snapshot: ChannelWorkerSnapshot,
  ): ChannelWorkerGroupSnapshot => ({
    ...snapshot,
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
              } else {
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

  const stopEntry = async (entry: ChannelWorkerGroupEntry): Promise<void> => {
    try {
      await entry.supervisor.stop();
    } finally {
      opts.onStateChange?.();
    }
  };

  const startEntries = async (
    entriesToStart: readonly ChannelWorkerGroupEntry[],
  ): Promise<void> => {
    for (const entry of entriesToStart) {
      await entry.supervisor.start();
    }
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
    try {
      await startEntries(entriesToRestore);
      return { rolledBack: true };
    } catch (error) {
      return { rolledBack: false, rollbackError: errorMessage(error) };
    }
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

  const group: ChannelWorkerGroup = {
    async start() {
      // Start sequentially so a failing initial launch can roll back every
      // worker that already reached ready before propagating the failure.
      stopping = false;
      const started: ChannelWorkerGroupEntry[] = [];
      try {
        for (const entry of entries.values()) {
          if (stopping) {
            throw new Error('Channel worker group stopped during startup.');
          }
          started.push(entry);
          await entry.supervisor.start();
          if (stopping) {
            throw new Error('Channel worker group stopped during startup.');
          }
        }
      } catch (error) {
        await stopEntriesBestEffort(started);
        throw error;
      }
    },
    async stop() {
      stopping = true;
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
            startedNew.push(entry);
            await entry.supervisor.start();
          }
        } catch (error) {
          reconcileOptions?.onRollingBack?.();
          const cleanup = await stopEntriesForRollback(startedNew);
          if (cleanup.error) {
            for (const entry of cleanup.failedEntries) {
              entries.set(entry.workspaceCwd, entry);
            }
            throw new ChannelWorkerReconcileError(errorMessage(error), {
              rolledBack: false,
              rollbackError: cleanup.error,
            });
          }
          const rollback = await restoreEntries(stoppedOld);
          throw new ChannelWorkerReconcileError(errorMessage(error), rollback);
        }

        const committed = new Map(unchanged);
        for (const entry of newEntries) {
          committed.set(entry.workspaceCwd, entry);
        }
        entries = committed;
        return { changed: true, workers: entrySnapshots() };
      })().finally(() => {
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
      for (const entry of entries.values()) {
        entry.supervisor.killAllSync();
      }
    },
    snapshots: entrySnapshots,
    primarySnapshot() {
      const primary = [...entries.values()].find((entry) => entry.primary);
      return primary?.supervisor.snapshot() ?? { ...DISABLED_SNAPSHOT };
    },
    async enqueueWebhookTask(task) {
      const entry = routeEntry(task.channelName);
      if (!entry) {
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
