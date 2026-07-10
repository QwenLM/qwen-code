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
import type { ChannelWorkspaceGroup } from './channel-workspace-grouping.js';
import type { WorkspaceRegistry } from './workspace-registry.js';

/** A channel worker snapshot annotated with its owning workspace. */
export interface ChannelWorkerGroupSnapshot extends ChannelWorkerSnapshot {
  workspaceId: string;
  workspaceCwd: string;
  primary: boolean;
}

/**
 * Manages one `ChannelWorkerSupervisor` per owning workspace for a
 * multi-workspace `qwen serve --channel`. Single-workspace runs collapse to a
 * single primary supervisor, matching the pre-4b behavior.
 */
export interface ChannelWorkerGroup {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<ChannelWorkerGroupSnapshot[]>;
  killAllSync(): void;
  snapshots(): ChannelWorkerGroupSnapshot[];
  /** Primary workspace snapshot, backing the legacy single-worker fields. */
  primarySnapshot(): ChannelWorkerSnapshot;
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
  supervisor: ChannelWorkerSupervisor;
}

export function createChannelWorkerGroup(
  opts: CreateChannelWorkerGroupOptions,
): ChannelWorkerGroup {
  const entries: ChannelWorkerGroupEntry[] = [];
  for (const group of opts.groups) {
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
    const workspaceId = runtime.workspaceId;
    const workspaceCwd = runtime.workspaceCwd;
    const primary = runtime.primary;
    const withMeta = (
      snapshot: ChannelWorkerSnapshot,
    ): ChannelWorkerGroupSnapshot => ({
      ...snapshot,
      workspaceId,
      workspaceCwd,
      primary,
    });
    const supervisor = opts.createSupervisor({
      cliEntryPath: opts.shared.cliEntryPath,
      daemonUrl: opts.shared.daemonUrl,
      ...(opts.shared.daemonToken
        ? { daemonToken: opts.shared.daemonToken }
        : {}),
      workspace: workspaceCwd,
      selection: group.selection,
      // Multi-workspace runtimes expose a per-workspace env overlay; a
      // parent-process (single-workspace) runtime leaves it undefined so the
      // supervisor falls back to `process.env` exactly as before.
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
        ? { onReady: (snapshot) => opts.onReady!(withMeta(snapshot)) }
        : {}),
      ...(opts.onExit
        ? { onExit: (snapshot) => opts.onExit!(withMeta(snapshot)) }
        : {}),
      ...(opts.onLog
        ? { onLog: (entry) => opts.onLog!({ ...entry, workspaceCwd }) }
        : {}),
    });
    entries.push({ workspaceId, workspaceCwd, primary, supervisor });
  }

  const primaryEntry = entries.find((entry) => entry.primary);
  let restartInFlight: Promise<ChannelWorkerGroupSnapshot[]> | undefined;
  let stopping = false;

  const stopEntries = async (
    entriesToStop: readonly ChannelWorkerGroupEntry[],
  ): Promise<void> => {
    const results = await Promise.allSettled(
      entriesToStop.map((entry) => entry.supervisor.stop()),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  };

  const stopEntriesBestEffort = async (
    entriesToStop: readonly ChannelWorkerGroupEntry[],
  ): Promise<void> => {
    await Promise.allSettled(
      entriesToStop.map((entry) => entry.supervisor.stop()),
    );
  };

  return {
    async start() {
      // Start sequentially: a failing initial launch rejects and fails runtime
      // startup (fail-closed, no half-enabled daemon), matching single-worker
      // behavior. Roll back workers that already reached ready before
      // propagating the startup failure.
      stopping = false;
      const started: ChannelWorkerGroupEntry[] = [];
      try {
        for (const entry of entries) {
          await entry.supervisor.start();
          started.push(entry);
        }
      } catch (err) {
        await stopEntriesBestEffort(started);
        throw err;
      }
    },
    async stop() {
      stopping = true;
      await restartInFlight?.catch(() => {});
      await stopEntries(entries);
    },
    restart() {
      if (stopping) {
        return Promise.reject(new Error('Channel worker group is stopping.'));
      }
      restartInFlight ??= (async () => {
        try {
          for (const entry of entries) {
            if (stopping) {
              throw new Error('Channel worker group is stopping.');
            }
            await entry.supervisor.restart();
          }
          return entries.map((entry) => ({
            ...entry.supervisor.snapshot(),
            workspaceId: entry.workspaceId,
            workspaceCwd: entry.workspaceCwd,
            primary: entry.primary,
          }));
        } catch (err) {
          await stopEntriesBestEffort(entries);
          throw err;
        } finally {
          restartInFlight = undefined;
        }
      })();
      return restartInFlight;
    },
    killAllSync() {
      stopping = true;
      for (const entry of entries) {
        entry.supervisor.killAllSync();
      }
    },
    snapshots() {
      return entries.map((entry) => ({
        ...entry.supervisor.snapshot(),
        workspaceId: entry.workspaceId,
        workspaceCwd: entry.workspaceCwd,
        primary: entry.primary,
      }));
    },
    primarySnapshot() {
      return primaryEntry?.supervisor.snapshot() ?? { ...DISABLED_SNAPSHOT };
    },
  };
}
