// Force strict mode and setup for ESM
"use strict";
import {
  ChannelControlWorkspaceLimitError,
  ChannelWorkerReconcileError,
  assertChannelControlWorkspaceCapacity
} from "./chunk-OTKRZOVK.js";
import "./chunk-RN6A53UJ.js";
import "./chunk-YXHY6BKS.js";
import "./chunk-6PLDPT2C.js";
import {
  ChannelWorkerStartupError,
  ChannelWorkerStopError
} from "./chunk-JH7CXRVS.js";
import "./chunk-FYJ7W2PI.js";
import "./chunk-Z7B6SRPM.js";
import {
  ChannelWebhookEnqueueError
} from "./chunk-STUJ7IMZ.js";
import "./chunk-L3SNMEDW.js";
import "./chunk-GDWE23OR.js";
import "./chunk-GYTKQYDB.js";
import {
  ChannelDeliveryError
} from "./chunk-RKFGE7JH.js";
import "./chunk-UDG5EZJI.js";
import "./chunk-M5GB774H.js";
import "./chunk-3VUENPWF.js";
import "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import "./chunk-CJ3DHN5I.js";
import "./chunk-LJZSMWOH.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-worker-manager.ts
init_esbuild_shims();
var ChannelWorkerControlError = class extends Error {
  static {
    __name(this, "ChannelWorkerControlError");
  }
  code;
  rolledBack;
  rollbackError;
  startupFailures;
  startupFailuresTruncated;
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ChannelWorkerControlError";
    this.code = code;
    this.rolledBack = details.rolledBack;
    this.rollbackError = details.rollbackError;
    this.startupFailures = details.startupFailures?.map((failure) => ({
      ...failure
    }));
    this.startupFailuresTruncated = details.startupFailuresTruncated;
  }
};
var DISABLED_SNAPSHOT = {
  enabled: false,
  state: "disabled",
  channels: []
};
function cloneSelection(selection) {
  return selection.mode === "all" ? { mode: "all" } : { mode: "names", names: [...selection.names] };
}
__name(cloneSelection, "cloneSelection");
function cloneGroups(groups) {
  return groups.map((group) => ({
    workspaceCwd: group.workspaceCwd,
    selection: cloneSelection(group.selection)
  }));
}
__name(cloneGroups, "cloneGroups");
function selectionsEqual(left, right) {
  if (!left || left.mode !== right.mode) return false;
  if (left.mode === "all") return true;
  if (right.mode === "all" || left.names.length !== right.names.length) {
    return false;
  }
  return left.names.every((name, index) => name === right.names[index]);
}
__name(selectionsEqual, "selectionsEqual");
function isPartial(workers) {
  return workers.some((worker) => {
    if (!worker.requestedChannels) return false;
    const connected = new Set(worker.channels);
    return worker.requestedChannels.some((name) => !connected.has(name));
  });
}
__name(isPartial, "isPartial");
function groupIncludesName(group, name) {
  return group.selection.mode === "all" || group.selection.names.includes(name);
}
__name(groupIncludesName, "groupIncludesName");
function assertRequiredOwner(targetGroups, requiredOwner) {
  const owners = targetGroups.filter(
    (target) => groupIncludesName(target, requiredOwner.name)
  );
  if (owners.length !== 1 || owners[0].workspaceCwd !== requiredOwner.workspaceCwd) {
    throw new ChannelWorkerControlError(
      "channel_runtime_owner_mismatch",
      `Channel "${requiredOwner.name}" does not resolve to workspace "${requiredOwner.workspaceCwd}".`
    );
  }
}
__name(assertRequiredOwner, "assertRequiredOwner");
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(errorMessage, "errorMessage");
function startupFailureDetails(error) {
  if (!(error instanceof ChannelWorkerStartupError || error instanceof ChannelWorkerReconcileError) || !error.startupFailures) {
    return {};
  }
  return {
    startupFailures: error.startupFailures,
    ...error.startupFailuresTruncated ? { startupFailuresTruncated: true } : {}
  };
}
__name(startupFailureDetails, "startupFailureDetails");
function createChannelWorkerManager(opts) {
  let committedSelection;
  let committedGroups = [];
  let pendingSelection;
  let transition = "idle";
  let group;
  let leaseReserved = opts.initialLeaseReserved === true;
  let draining = false;
  let hardKilled = false;
  let lane = Promise.resolve();
  const workspaceDrains = /* @__PURE__ */ new Set();
  const snapshot = /* @__PURE__ */ __name(() => ({
    enabled: committedSelection !== void 0 || group !== void 0 || leaseReserved,
    selection: committedSelection ? cloneSelection(committedSelection) : null,
    ...pendingSelection ? { pendingSelection: cloneSelection(pendingSelection) } : {},
    transition,
    workers: group?.snapshots() ?? []
  }), "snapshot");
  const notify = /* @__PURE__ */ __name(() => {
    opts.onStateChange?.(snapshot());
  }, "notify");
  const enqueue = /* @__PURE__ */ __name((operation) => {
    const result = lane.then(operation, operation);
    lane = result.then(
      () => void 0,
      () => void 0
    );
    return result;
  }, "enqueue");
  const drainingError = /* @__PURE__ */ __name(() => new ChannelWorkerControlError(
    "daemon_draining",
    "Daemon is shutting down."
  ), "drainingError");
  const reserve = /* @__PURE__ */ __name((selection) => {
    if (leaseReserved) return;
    opts.reserveLease(selection);
    leaseReserved = true;
  }, "reserve");
  const release = /* @__PURE__ */ __name(() => {
    if (!leaseReserved) return;
    opts.releaseLease();
    leaseReserved = false;
  }, "release");
  const setTransition = /* @__PURE__ */ __name((next, pending) => {
    transition = next;
    pendingSelection = pending ? cloneSelection(pending) : void 0;
    notify();
  }, "setTransition");
  const commit = /* @__PURE__ */ __name((selection, groups) => {
    committedSelection = selection ? cloneSelection(selection) : void 0;
    committedGroups = cloneGroups(groups);
    transition = "idle";
    pendingSelection = void 0;
    opts.onCommittedSelection?.(committedSelection, groups);
    notify();
  }, "commit");
  const classifyFailure = /* @__PURE__ */ __name((error, fallbackCode) => {
    if (error instanceof ChannelControlWorkspaceLimitError) return error;
    if (error instanceof ChannelWorkerReconcileError) {
      return new ChannelWorkerControlError(
        error.stopFailed ? "channel_worker_stop_failed" : fallbackCode,
        error.message,
        {
          rolledBack: error.rolledBack,
          ...error.rollbackError ? { rollbackError: error.rollbackError } : {},
          ...startupFailureDetails(error)
        }
      );
    }
    return new ChannelWorkerControlError(
      error instanceof ChannelWorkerStopError ? "channel_worker_stop_failed" : fallbackCode,
      errorMessage(error),
      startupFailureDetails(error)
    );
  }, "classifyFailure");
  const applySelection = /* @__PURE__ */ __name(async (selection, initial, resolvedGroups) => {
    if (hardKilled) throw drainingError();
    const enabling = !snapshot().enabled;
    const replacing = committedSelection !== void 0;
    const sameSelection = selectionsEqual(committedSelection, selection);
    if (sameSelection && group?.isHealthy()) {
      return {
        changed: false,
        replaced: false,
        partial: isPartial(group.snapshots()),
        state: snapshot(),
        created: false
      };
    }
    setTransition(replacing ? "reconciling" : "starting", selection);
    let targetGroups;
    try {
      targetGroups = resolvedGroups ?? await opts.resolveGroups(selection, initial ? "initial" : "set");
      if (hardKilled) throw drainingError();
      assertChannelControlWorkspaceCapacity(
        targetGroups.map((target) => target.workspaceCwd)
      );
      reserve(selection);
    } catch (error) {
      setTransition("idle");
      throw error;
    }
    if (!group) {
      let candidate;
      try {
        candidate = opts.createGroup(targetGroups);
      } catch (error) {
        let cleanupError;
        if (!initial) {
          try {
            release();
          } catch (releaseError) {
            cleanupError = releaseError;
          }
        }
        setTransition("idle");
        if (error instanceof ChannelControlWorkspaceLimitError && !cleanupError) {
          throw error;
        }
        throw new ChannelWorkerControlError(
          "channel_worker_start_failed",
          errorMessage(error),
          cleanupError ? { rolledBack: false, rollbackError: errorMessage(cleanupError) } : { rolledBack: !initial }
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
        let cleanupError;
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
          if (!cleanupError) group = void 0;
        }
        setTransition("idle");
        throw new ChannelWorkerControlError(
          "channel_worker_start_failed",
          errorMessage(error),
          cleanupError ? {
            rolledBack: false,
            rollbackError: errorMessage(cleanupError),
            ...startupDetails
          } : { rolledBack: true, ...startupDetails }
        );
      }
      commit(selection, targetGroups);
      return {
        changed: true,
        replaced: false,
        partial: isPartial(candidate.snapshots()),
        state: snapshot(),
        created: enabling
      };
    }
    try {
      const result = await group.reconcile(targetGroups, {
        onRollingBack: /* @__PURE__ */ __name(() => setTransition("rolling_back", selection), "onRollingBack")
      });
      commit(selection, targetGroups);
      return {
        changed: result.changed || !sameSelection,
        replaced: !sameSelection,
        partial: isPartial(result.workers),
        state: snapshot(),
        created: enabling
      };
    } catch (error) {
      setTransition("idle");
      throw classifyFailure(error, "channel_worker_start_failed");
    }
  }, "applySelection");
  const committedChannelNames = /* @__PURE__ */ __name(() => {
    if (!committedSelection) return [];
    if (committedSelection.mode === "names") {
      return [...committedSelection.names];
    }
    const names = /* @__PURE__ */ new Set();
    for (const worker of group?.snapshots() ?? []) {
      for (const name of worker.requestedChannels ?? worker.channels) {
        names.add(name);
      }
    }
    return [...names];
  }, "committedChannelNames");
  const assertCommittedOwner = /* @__PURE__ */ __name((requiredOwner) => {
    const owners = (group?.snapshots() ?? []).filter(
      (worker) => worker.adapters?.some(
        (adapter) => adapter.name === requiredOwner.name
      ) || worker.requestedChannels?.includes(requiredOwner.name) || worker.channels.includes(requiredOwner.name)
    );
    if (owners.length !== 1 || owners[0].workspaceCwd !== requiredOwner.workspaceCwd) {
      throw new ChannelWorkerControlError(
        "channel_runtime_owner_mismatch",
        `Channel "${requiredOwner.name}" does not have one confirmed runtime owner in workspace "${requiredOwner.workspaceCwd}".`
      );
    }
  }, "assertCommittedOwner");
  const stopSelectionNow = /* @__PURE__ */ __name(async () => {
    const hadState = group !== void 0 || leaseReserved;
    if (!hadState) {
      return { changed: false, state: snapshot() };
    }
    setTransition("stopping");
    try {
      if (group) {
        await group.stop();
        group = void 0;
      }
      release();
    } catch (error) {
      setTransition("idle");
      throw classifyFailure(error, "channel_worker_stop_failed");
    }
    commit(void 0, []);
    return { changed: hadState, state: snapshot() };
  }, "stopSelectionNow");
  const manager = {
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
        const targetGroups = await opts.resolveGroups(selection, "set");
        assertRequiredOwner(targetGroups, requiredOwner);
        if (hardKilled) throw drainingError();
        return applySelection(selection, false, targetGroups);
      });
    },
    setChannelEnabled(owner, enabled) {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        const committedNames = committedChannelNames();
        const currentlyEnabled = committedNames.includes(owner.name);
        if (currentlyEnabled) assertCommittedOwner(owner);
        if (enabled) {
          if (currentlyEnabled) {
            return {
              changed: false,
              replaced: false,
              partial: isPartial(group?.snapshots() ?? []),
              state: snapshot(),
              created: false
            };
          }
          const selection = {
            mode: "names",
            names: [...committedNames, owner.name]
          };
          const targetGroups = await opts.resolveGroups(selection, "set");
          assertRequiredOwner(targetGroups, owner);
          if (hardKilled) throw drainingError();
          return applySelection(selection, false, targetGroups);
        }
        if (!currentlyEnabled) {
          return { changed: false, state: snapshot() };
        }
        const names = committedNames.filter((name) => name !== owner.name);
        return names.length === 0 ? stopSelectionNow() : applySelection({ mode: "names", names }, false);
      });
    },
    stopSelection() {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(stopSelectionNow);
    },
    reload() {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        if (!group || !committedSelection) {
          throw new ChannelWorkerControlError(
            "channel_worker_not_enabled",
            "This daemon has no channel worker to reload."
          );
        }
        setTransition("reconciling", committedSelection);
        let targetGroups;
        try {
          targetGroups = await opts.resolveGroups(committedSelection, "reload");
        } catch (error) {
          setTransition("idle");
          throw error;
        }
        if (hardKilled) throw drainingError();
        try {
          await group.reconcile(targetGroups, {
            force: true,
            onRollingBack: /* @__PURE__ */ __name(() => setTransition("rolling_back", committedSelection), "onRollingBack")
          });
        } catch (error) {
          setTransition("idle");
          throw classifyFailure(error, "channel_worker_start_failed");
        }
        commit(committedSelection, targetGroups);
        const snapshots = group.snapshots();
        return snapshots.find((worker) => worker.primary) ?? snapshots[0] ?? { ...DISABLED_SNAPSHOT };
      });
    },
    reloadWorkspace(workspaceCwd, name) {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        if (!group || !committedSelection) {
          throw new ChannelWorkerControlError(
            "channel_worker_not_enabled",
            "This daemon has no channel worker to reload."
          );
        }
        setTransition("reconciling", committedSelection);
        let targetGroups;
        try {
          targetGroups = await opts.resolveGroups(committedSelection, "reload");
          assertRequiredOwner(targetGroups, { name, workspaceCwd });
          if (targetGroups.filter(
            (target) => target.workspaceCwd === workspaceCwd
          ).length !== 1 || committedGroups.filter(
            (target) => target.workspaceCwd === workspaceCwd
          ).length !== 1) {
            throw new ChannelWorkerControlError(
              "channel_runtime_owner_mismatch",
              `Workspace "${workspaceCwd}" does not own a committed channel worker.`
            );
          }
        } catch (error) {
          setTransition("idle");
          throw error;
        }
        if (hardKilled) throw drainingError();
        try {
          await group.reconcile(targetGroups, {
            forceWorkspaceCwd: workspaceCwd,
            onRollingBack: /* @__PURE__ */ __name(() => setTransition("rolling_back", committedSelection), "onRollingBack")
          });
        } catch (error) {
          setTransition("idle");
          throw classifyFailure(error, "channel_worker_start_failed");
        }
        const targetGroup = targetGroups.find(
          (target) => target.workspaceCwd === workspaceCwd
        );
        const nextCommittedGroups = committedGroups.map(
          (committedGroup) => committedGroup.workspaceCwd === workspaceCwd ? targetGroup : committedGroup
        );
        commit(committedSelection, nextCommittedGroups);
        const worker = group.snapshots().find((snapshot2) => snapshot2.workspaceCwd === workspaceCwd);
        if (!worker) {
          throw new ChannelWorkerControlError(
            "channel_runtime_owner_mismatch",
            `Workspace "${workspaceCwd}" has no channel worker after reload.`
          );
        }
        return worker;
      });
    },
    state: snapshot,
    primarySnapshot: /* @__PURE__ */ __name(() => group?.primarySnapshot() ?? { ...DISABLED_SNAPSHOT }, "primarySnapshot"),
    snapshots: /* @__PURE__ */ __name(() => group?.snapshots() ?? [], "snapshots"),
    committedChannelNames,
    enqueueWebhookTask(task) {
      if (!group || draining) {
        return Promise.reject(
          new ChannelWebhookEnqueueError(
            "channel_worker_unavailable",
            draining ? "Daemon is shutting down." : "Channel worker is not running."
          )
        );
      }
      return group.enqueueWebhookTask(task);
    },
    deliverChannelMessage(workspaceCwd, request) {
      if (!group || draining) {
        return Promise.reject(
          new ChannelDeliveryError(
            "channel_worker_unavailable",
            draining ? "Daemon is shutting down." : "Channel worker is not running."
          )
        );
      }
      return group.deliverChannelMessage(request, workspaceCwd);
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
    removeWorkspace(workspaceCwd, options) {
      return enqueue(async () => {
        try {
          let removalError;
          try {
            await group?.removeWorkspace(workspaceCwd, options);
          } catch (error) {
            removalError = error;
          }
          try {
            if (!options?.permanent) {
              notify();
            } else {
              const removedNames = /* @__PURE__ */ new Set();
              const nextGroups = committedGroups.filter((committedGroup) => {
                if (committedGroup.workspaceCwd !== workspaceCwd) return true;
                if (committedGroup.selection.mode === "names") {
                  for (const name of committedGroup.selection.names) {
                    removedNames.add(name);
                  }
                }
                return false;
              });
              if (!committedSelection || committedSelection.mode === "all") {
                commit(committedSelection, nextGroups);
              } else {
                const names = committedSelection.names.filter(
                  (name) => !removedNames.has(name)
                );
                if (names.length > 0) {
                  commit({ mode: "names", names }, nextGroups);
                } else {
                  await stopSelectionNow();
                }
              }
            }
          } catch (error) {
            if (removalError) {
              throw new AggregateError(
                [removalError, error],
                "Failed to remove channel workspace and converge manager state."
              );
            }
            throw error;
          }
          if (removalError) throw removalError;
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
        setTransition("reconciling", committedSelection);
        let targetGroups;
        try {
          targetGroups = await opts.resolveGroups(committedSelection, "reload");
        } catch (error) {
          setTransition("idle");
          throw error;
        }
        if (hardKilled) throw drainingError();
        try {
          await group.reconcile(targetGroups);
        } catch (error) {
          setTransition("idle");
          throw classifyFailure(error, "channel_worker_start_failed");
        }
        commit(committedSelection, targetGroups);
      });
    },
    workerChanged: notify,
    shutdown() {
      draining = true;
      return enqueue(async () => {
        if (group || leaseReserved) setTransition("stopping");
        try {
          if (group) {
            await group.stop();
            group = void 0;
          }
          release();
        } catch (error) {
          setTransition("idle");
          throw classifyFailure(error, "channel_worker_stop_failed");
        }
        commit(void 0, []);
      });
    },
    killAllSync() {
      draining = true;
      hardKilled = true;
      group?.killAllSync();
      pendingSelection = void 0;
      transition = "idle";
      notify();
    }
  };
  return manager;
}
__name(createChannelWorkerManager, "createChannelWorkerManager");
export {
  ChannelWorkerControlError,
  createChannelWorkerManager
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
