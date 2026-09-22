// Force strict mode and setup for ESM
"use strict";
import {
  CLIENT_MCP_OVER_WS_CONFIG_FLAG
} from "./chunk-RN6A53UJ.js";
import {
  SessionNotFoundError
} from "./chunk-YXHY6BKS.js";
import {
  ChannelWorkerStartupError
} from "./chunk-JH7CXRVS.js";
import {
  ChannelWebhookEnqueueError
} from "./chunk-STUJ7IMZ.js";
import {
  ChannelDeliveryError
} from "./chunk-RKFGE7JH.js";
import {
  CHANNEL_LOOP_MCP_SERVER_NAME
} from "./chunk-PZRXWQUA.js";
import {
  MAX_CHANNEL_CONTROL_WORKSPACES
} from "./chunk-CJ3DHN5I.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-worker-group.ts
init_esbuild_shims();

// packages/cli/src/serve/channel-control-capacity.ts
init_esbuild_shims();
var ChannelControlWorkspaceLimitError = class extends Error {
  static {
    __name(this, "ChannelControlWorkspaceLimitError");
  }
  code = "channel_control_workspace_limit_reached";
  constructor() {
    super(
      `Channel control supports at most ${MAX_CHANNEL_CONTROL_WORKSPACES} workspace owners; a transition also counts owners retained for recovery. Narrow the channel selection or reduce the number of channel-owning workspaces; for a runtime transition at capacity, successfully stop the channels on an existing owner before enabling a new one.`
    );
    this.name = "ChannelControlWorkspaceLimitError";
  }
};
function assertChannelControlWorkspaceCapacity(workspaceCwds) {
  if (new Set(workspaceCwds).size > MAX_CHANNEL_CONTROL_WORKSPACES) {
    throw new ChannelControlWorkspaceLimitError();
  }
}
__name(assertChannelControlWorkspaceCapacity, "assertChannelControlWorkspaceCapacity");

// packages/cli/src/serve/channel-worker-group.ts
var ChannelWorkerReconcileError = class extends Error {
  static {
    __name(this, "ChannelWorkerReconcileError");
  }
  rolledBack;
  rollbackError;
  stopFailed;
  startupFailures;
  startupFailuresTruncated;
  constructor(message, options) {
    super(message);
    this.name = "ChannelWorkerReconcileError";
    this.rolledBack = options.rolledBack;
    this.rollbackError = options.rollbackError;
    this.stopFailed = options.stopFailed === true;
    this.startupFailures = options.startupFailures?.map((failure) => ({
      ...failure
    }));
    this.startupFailuresTruncated = options.startupFailuresTruncated;
  }
};
var DISABLED_SNAPSHOT = {
  enabled: false,
  state: "disabled",
  channels: []
};
function selectionsEqual(left, right) {
  if (left.mode !== right.mode) return false;
  if (left.mode === "all") return true;
  if (right.mode === "all" || left.names.length !== right.names.length) {
    return false;
  }
  return left.names.every((name, index) => name === right.names[index]);
}
__name(selectionsEqual, "selectionsEqual");
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(errorMessage, "errorMessage");
function startupFailureDetails(error) {
  if (!(error instanceof ChannelWorkerStartupError)) return {};
  return {
    startupFailures: error.startupFailures,
    ...error.startupFailuresTruncated ? { startupFailuresTruncated: true } : {}
  };
}
__name(startupFailureDetails, "startupFailureDetails");
function createChannelWorkerGroup(opts) {
  assertChannelControlWorkspaceCapacity(
    opts.groups.map((group2) => group2.workspaceCwd)
  );
  let generation = 0;
  let entries = /* @__PURE__ */ new Map();
  const groupsByWorkspace = new Map(
    opts.groups.map((group2) => [group2.workspaceCwd, group2])
  );
  const pendingEntries = /* @__PURE__ */ new Set();
  const pendingGenerations = /* @__PURE__ */ new Map();
  const drainingWorkspaces = /* @__PURE__ */ new Set();
  const removalPromises = /* @__PURE__ */ new Map();
  let reconciling;
  let stopping = false;
  let groupStarted = false;
  const withMeta = /* @__PURE__ */ __name((entry, snapshot) => ({
    ...snapshot,
    ...snapshot.startupFailures ? {
      startupFailures: snapshot.startupFailures.map((failure) => ({
        ...failure
      }))
    } : {},
    workspaceId: entry.workspaceId,
    workspaceCwd: entry.workspaceCwd,
    primary: entry.primary
  }), "withMeta");
  const createEntry = /* @__PURE__ */ __name((group2) => {
    const runtime = opts.registry.getByWorkspaceCwd(group2.workspaceCwd);
    if (!runtime) {
      throw new Error(
        `Channel worker group references unregistered workspace "${group2.workspaceCwd}".`
      );
    }
    if (!runtime.trusted) {
      throw Object.assign(
        new Error(
          `Channel worker group workspace "${runtime.workspaceCwd}" is not trusted.`
        ),
        { code: "untrusted_workspace" }
      );
    }
    const entryGeneration = ++generation;
    const withRuntimeMeta = /* @__PURE__ */ __name((snapshot) => ({
      ...snapshot,
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
      primary: runtime.primary
    }), "withRuntimeMeta");
    const supervisor = opts.createSupervisor({
      cliEntryPath: opts.shared.cliEntryPath,
      daemonUrl: opts.shared.daemonUrl,
      ...opts.shared.daemonToken ? { daemonToken: opts.shared.daemonToken } : {},
      ...opts.shared.workerTlsCaCertPath ? { tlsCaCertPath: opts.shared.workerTlsCaCertPath } : {},
      workspace: runtime.workspaceCwd,
      selection: group2.selection,
      // Multi-workspace runtimes expose a per-workspace env overlay; a
      // parent-process runtime leaves it undefined so the supervisor inherits
      // process.env exactly as before.
      ...runtime.env.effectiveEnv ? { workerBaseEnv: runtime.env.effectiveEnv } : {},
      ...opts.shared.restartPolicy ? { restartPolicy: opts.shared.restartPolicy } : {},
      ...opts.shared.startupTimeoutMs !== void 0 ? { startupTimeoutMs: opts.shared.startupTimeoutMs } : {},
      ...opts.shared.heartbeatTimeoutMs !== void 0 ? { heartbeatTimeoutMs: opts.shared.heartbeatTimeoutMs } : {},
      registerChannelLoopMcp: /* @__PURE__ */ __name(async ({ sessionId, ownerId, sendMessage }) => {
        runtime.clientMcpSenderRegistry.setSession(
          CHANNEL_LOOP_MCP_SERVER_NAME,
          sessionId,
          sendMessage,
          ownerId
        );
        try {
          const config = {
            type: "sdk",
            [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: true
          };
          const result = await runtime.bridge.addSessionRuntimeMcpServer(
            sessionId,
            CHANNEL_LOOP_MCP_SERVER_NAME,
            config,
            ownerId
          );
          if (result.skipped) {
            throw new Error(
              `runtime MCP add skipped: ${result.reason ?? "unknown"}`
            );
          }
          if (result.shadowedSettings) {
            throw new Error(
              `channel loop MCP server conflicts with a configured MCP server`
            );
          }
          if (!runtime.clientMcpSenderRegistry.ownsSession(
            CHANNEL_LOOP_MCP_SERVER_NAME,
            sessionId,
            ownerId
          )) {
            throw new Error("Channel loop MCP registration was superseded.");
          }
        } catch (error) {
          if (runtime.clientMcpSenderRegistry.deleteSession(
            CHANNEL_LOOP_MCP_SERVER_NAME,
            sessionId,
            ownerId
          )) {
            await runtime.bridge.removeSessionRuntimeMcpServer(
              sessionId,
              CHANNEL_LOOP_MCP_SERVER_NAME,
              ownerId
            ).catch(() => {
            });
          }
          throw error;
        }
      }, "registerChannelLoopMcp"),
      unregisterChannelLoopMcp: /* @__PURE__ */ __name(async (sessionId, ownerId) => {
        if (!runtime.clientMcpSenderRegistry.deleteSession(
          CHANNEL_LOOP_MCP_SERVER_NAME,
          sessionId,
          ownerId
        )) {
          return;
        }
        try {
          await runtime.bridge.removeSessionRuntimeMcpServer(
            sessionId,
            CHANNEL_LOOP_MCP_SERVER_NAME,
            ownerId
          );
        } catch (error) {
          if (!(error instanceof SessionNotFoundError)) throw error;
        }
      }, "unregisterChannelLoopMcp"),
      ...opts.onReady ? {
        onReady: /* @__PURE__ */ __name((snapshot) => {
          if (entries.get(runtime.workspaceCwd)?.generation === entryGeneration) {
            opts.onReady(withRuntimeMeta(snapshot));
          } else if (pendingGenerations.get(runtime.workspaceCwd) !== entryGeneration) {
            opts.onLog?.({
              stream: "stderr",
              line: `Ignored stale channel worker ready (generation=${entryGeneration}).`,
              workspaceCwd: runtime.workspaceCwd
            });
          }
        }, "onReady")
      } : {},
      ...opts.onExit ? {
        onExit: /* @__PURE__ */ __name((snapshot) => {
          if (entries.get(runtime.workspaceCwd)?.generation === entryGeneration) {
            opts.onExit(withRuntimeMeta(snapshot));
          } else if (pendingGenerations.get(runtime.workspaceCwd) !== entryGeneration) {
            opts.onLog?.({
              stream: "stderr",
              line: `Ignored stale channel worker exit (generation=${entryGeneration}).`,
              workspaceCwd: runtime.workspaceCwd
            });
          }
        }, "onExit")
      } : {},
      ...opts.onLog ? {
        onLog: /* @__PURE__ */ __name((logEntry) => opts.onLog({
          ...logEntry,
          workspaceCwd: runtime.workspaceCwd
        }), "onLog")
      } : {}
    });
    return {
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
      primary: runtime.primary,
      selection: group2.selection,
      generation: entryGeneration,
      supervisor
    };
  }, "createEntry");
  for (const group2 of opts.groups) {
    const entry = createEntry(group2);
    entries.set(entry.workspaceCwd, entry);
  }
  const entrySnapshots = /* @__PURE__ */ __name(() => [...entries.values()].map(
    (entry) => withMeta(entry, entry.supervisor.snapshot())
  ), "entrySnapshots");
  const stopEntry = /* @__PURE__ */ __name((entry) => {
    if (!entry.stopPromise) {
      const stopPromise = entry.supervisor.stop().finally(() => opts.onStateChange?.());
      entry.stopPromise = stopPromise;
      void stopPromise.then(
        () => {
          if (entry.stopPromise === stopPromise) entry.stopPromise = void 0;
        },
        () => {
          if (entry.stopPromise === stopPromise) entry.stopPromise = void 0;
        }
      );
    }
    return entry.stopPromise;
  }, "stopEntry");
  const stopEntriesBestEffort = /* @__PURE__ */ __name(async (entriesToStop) => {
    await Promise.allSettled(entriesToStop.map((entry) => stopEntry(entry)));
  }, "stopEntriesBestEffort");
  const stopAllEntries = /* @__PURE__ */ __name(async (entriesToStop) => {
    const results = await Promise.allSettled(
      entriesToStop.map((entry) => stopEntry(entry))
    );
    const failure = results.find(
      (result) => result.status === "rejected"
    );
    if (failure) throw failure.reason;
  }, "stopAllEntries");
  const stopEntriesForRollback = /* @__PURE__ */ __name(async (entriesToStop) => {
    let firstError;
    const failedEntries = [];
    for (const entry of entriesToStop) {
      try {
        await stopEntry(entry);
      } catch (error) {
        firstError ??= errorMessage(error);
        failedEntries.push(entry);
      }
    }
    return {
      ...firstError ? { error: firstError } : {},
      failedEntries
    };
  }, "stopEntriesForRollback");
  const restoreEntries = /* @__PURE__ */ __name(async (entriesToRestore) => {
    let firstError;
    for (const entry of entriesToRestore) {
      try {
        await entry.supervisor.start();
      } catch (error) {
        firstError ??= errorMessage(error);
      }
    }
    return firstError ? { rolledBack: false, rollbackError: firstError } : { rolledBack: true };
  }, "restoreEntries");
  const routeEntry = /* @__PURE__ */ __name((channelName, workspaceCwd) => {
    if (workspaceCwd !== void 0) {
      const entry = entries.get(workspaceCwd);
      if (entry && (entry.selection.mode === "all" || entry.selection.names.includes(channelName))) {
        return entry;
      }
      return void 0;
    }
    for (const entry of entries.values()) {
      if (entry.selection.mode === "all" || entry.selection.names.includes(channelName)) {
        return entry;
      }
    }
    return void 0;
  }, "routeEntry");
  const detachEntry = /* @__PURE__ */ __name((entry) => {
    if (entries.get(entry.workspaceCwd)?.generation === entry.generation) {
      entries.delete(entry.workspaceCwd);
    }
    pendingEntries.delete(entry);
    if (pendingGenerations.get(entry.workspaceCwd) === entry.generation) {
      pendingGenerations.delete(entry.workspaceCwd);
    }
  }, "detachEntry");
  const group = {
    async start() {
      stopping = false;
      const started = [];
      try {
        for (const entry of entries.values()) {
          if (drainingWorkspaces.has(entry.workspaceCwd)) {
            throw new Error("Workspace drained during channel worker startup.");
          }
          if (stopping) {
            throw new Error("Channel worker group stopped during startup.");
          }
          started.push(entry);
          await entry.supervisor.start();
          if (stopping) {
            throw new Error("Channel worker group stopped during startup.");
          }
          if (entries.get(entry.workspaceCwd)?.generation !== entry.generation || drainingWorkspaces.has(entry.workspaceCwd)) {
            throw new Error("Workspace drained during channel worker startup.");
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
      await reconciling?.catch(() => {
      });
      await stopAllEntries([...entries.values()]);
    },
    reconcile(targetGroups, reconcileOptions) {
      if (stopping) {
        return Promise.reject(
          new ChannelWorkerReconcileError(
            "Channel worker group has not completed stopping.",
            { rolledBack: true, stopFailed: true }
          )
        );
      }
      if (drainingWorkspaces.size > 0) {
        return Promise.reject(
          new ChannelWorkerReconcileError(
            "Channel worker configuration cannot change while a workspace is draining.",
            { rolledBack: true }
          )
        );
      }
      if (reconciling) return reconciling;
      reconciling = (async () => {
        const targets = new Map(
          targetGroups.map((target) => [target.workspaceCwd, target])
        );
        if (reconcileOptions?.forceWorkspaceCwd) {
          for (const workspaceCwd of targets.keys()) {
            if (workspaceCwd !== reconcileOptions.forceWorkspaceCwd) {
              targets.delete(workspaceCwd);
            }
          }
        }
        assertChannelControlWorkspaceCapacity([
          ...entries.keys(),
          ...groupsByWorkspace.keys(),
          ...Array.from(pendingEntries, (entry) => entry.workspaceCwd),
          ...targets.keys()
        ]);
        const unchanged = /* @__PURE__ */ new Map();
        const oldAffected = [];
        const newEntries = [];
        for (const [workspaceCwd, entry] of entries) {
          const target = targets.get(workspaceCwd);
          const healthy = entry.supervisor.snapshot().state === "running";
          const forceWorkspace = reconcileOptions?.forceWorkspaceCwd === workspaceCwd;
          const preserveOtherWorkspace = reconcileOptions?.forceWorkspaceCwd !== void 0 && !forceWorkspace;
          if (preserveOtherWorkspace) {
            unchanged.set(workspaceCwd, entry);
            targets.delete(workspaceCwd);
            continue;
          }
          if (target && !reconcileOptions?.force && !forceWorkspace && healthy && selectionsEqual(entry.selection, target.selection)) {
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
        const stoppedOld = [];
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
            stopFailed: true
          });
        }
        const startedNew = [];
        try {
          for (const entry of newEntries) {
            if (drainingWorkspaces.has(entry.workspaceCwd)) {
              throw new Error(
                "Workspace drained during channel worker reconcile."
              );
            }
            if (stopping) {
              throw new Error("Channel worker group stopped during reconcile.");
            }
            startedNew.push(entry);
            await entry.supervisor.start();
            if (stopping) {
              throw new Error("Channel worker group stopped during reconcile.");
            }
            if (drainingWorkspaces.has(entry.workspaceCwd)) {
              throw new Error(
                "Workspace drained during channel worker reconcile."
              );
            }
          }
          if (drainingWorkspaces.size > 0) {
            throw new Error(
              "Workspace drained during channel worker reconcile."
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
              ...startupDetails
            });
          }
          if (stopping) {
            throw new ChannelWorkerReconcileError(errorMessage(error), {
              rolledBack: false,
              ...startupDetails
            });
          }
          const rollback = await restoreEntries(stoppedOld);
          throw new ChannelWorkerReconcileError(errorMessage(error), {
            ...rollback,
            ...startupDetails
          });
        }
        const committed = new Map(unchanged);
        for (const entry of newEntries) {
          committed.set(entry.workspaceCwd, entry);
        }
        entries = committed;
        const targetWorkspaceCwds = new Set(committed.keys());
        for (const workspaceCwd of groupsByWorkspace.keys()) {
          if (!targetWorkspaceCwds.has(workspaceCwd)) {
            groupsByWorkspace.delete(workspaceCwd);
          }
        }
        for (const entry of committed.values()) {
          groupsByWorkspace.set(entry.workspaceCwd, {
            workspaceCwd: entry.workspaceCwd,
            selection: entry.selection
          });
        }
        return { changed: true, workers: entrySnapshots() };
      })().finally(() => {
        pendingEntries.clear();
        pendingGenerations.clear();
        reconciling = void 0;
      });
      return reconciling;
    },
    isHealthy() {
      return entries.size > 0 && [...entries.values()].every(
        (entry) => entry.supervisor.snapshot().state === "running"
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
      return snapshot.state === "starting" || snapshot.state === "running" || snapshot.nextRestartAt !== void 0 ? 1 : 0;
    },
    removeWorkspace(workspaceCwd, options) {
      const existing = removalPromises.get(workspaceCwd);
      if (existing) {
        return options?.permanent ? existing.finally(() => groupsByWorkspace.delete(workspaceCwd)) : existing;
      }
      drainingWorkspaces.add(workspaceCwd);
      const removal = (async () => {
        try {
          await reconciling?.catch(() => {
          });
          const entry = entries.get(workspaceCwd);
          if (!entry) return;
          let killError;
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
          if (options?.permanent) groupsByWorkspace.delete(workspaceCwd);
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
        }
      );
      return removal;
    },
    async restoreWorkspace(workspaceCwd) {
      if (entries.has(workspaceCwd)) return;
      const target = groupsByWorkspace.get(workspaceCwd);
      if (!target) return;
      assertChannelControlWorkspaceCapacity([
        ...entries.keys(),
        ...groupsByWorkspace.keys(),
        ...Array.from(pendingEntries, (entry2) => entry2.workspaceCwd),
        target.workspaceCwd
      ]);
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
            }
          });
          detachEntry(entry);
        }
      } catch (err) {
        await stopEntry(entry).catch(() => {
          try {
            entry.supervisor.killAllSync();
          } catch {
          }
        });
        detachEntry(entry);
        throw err;
      }
    },
    async deliverChannelMessage(request, workspaceCwd) {
      const entry = routeEntry(request.channelName, workspaceCwd);
      const deliver = entry?.supervisor.deliverChannelMessage;
      if (entry && drainingWorkspaces.has(entry.workspaceCwd)) {
        throw new ChannelDeliveryError(
          "channel_worker_unavailable",
          `Channel worker for channel "${request.channelName}" is unavailable while its workspace is draining.`
        );
      }
      if (!entry || !deliver) {
        const hint = workspaceCwd ? `No channel worker for the selected workspace owns channel "${request.channelName}".` : `No channel worker owns channel "${request.channelName}".`;
        throw new ChannelDeliveryError("channel_worker_unavailable", hint);
      }
      return deliver.call(entry.supervisor, request);
    },
    async enqueueWebhookTask(task) {
      const entry = routeEntry(task.channelName);
      if (entry && drainingWorkspaces.has(entry.workspaceCwd)) {
        throw new ChannelWebhookEnqueueError(
          "channel_worker_unavailable",
          `Channel worker for channel "${task.channelName}" is unavailable while its workspace is draining.`
        );
      }
      if (!entry) {
        throw new ChannelWebhookEnqueueError(
          "channel_worker_unavailable",
          `No channel worker owns channel "${task.channelName}".`
        );
      }
      return entry.supervisor.enqueueWebhookTask(task);
    }
  };
  return group;
}
__name(createChannelWorkerGroup, "createChannelWorkerGroup");

export {
  ChannelControlWorkspaceLimitError,
  assertChannelControlWorkspaceCapacity,
  ChannelWorkerReconcileError,
  createChannelWorkerGroup
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
