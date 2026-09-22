// Force strict mode and setup for ESM
"use strict";
import {
  SERVE_CONTROL_EXT_METHODS,
  STATUS_SCHEMA_VERSION
} from "./chunk-SIUR4U2P.js";
import {
  AcpChildCapacityExceededError,
  WorkspaceDrainingError
} from "./chunk-YXHY6BKS.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/workspace-runtime-coordinator.ts
init_esbuild_shims();
var DEFAULT_ENSURE_TIMEOUT_MS = 6e4;
var ENSURE_KEEP_ALIVE_MS = 10 * 6e4;
var MCP_PREPARE_TIMEOUT_MS = 2 * 6e4;
var MCP_POLL_INTERVAL_MS = 250;
var WorkspaceRuntimeStillStartingError = class extends Error {
  static {
    __name(this, "WorkspaceRuntimeStillStartingError");
  }
  constructor() {
    super("Workspace runtime is still starting");
    this.name = "WorkspaceRuntimeStillStartingError";
  }
};
var WorkspaceRuntimeInitializationError = class extends Error {
  static {
    __name(this, "WorkspaceRuntimeInitializationError");
  }
  constructor(cause) {
    super("Workspace runtime failed to initialize", { cause });
    this.name = "WorkspaceRuntimeInitializationError";
  }
};
function withTimeout(operation, timeoutMs) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new WorkspaceRuntimeStillStartingError()),
        timeoutMs
      );
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
__name(withTimeout, "withTimeout");
function supportsWorkspaceRuntimeLifecycle(bridge) {
  return typeof bridge.getWorkspaceRuntimeLifecycleSnapshot === "function";
}
__name(supportsWorkspaceRuntimeLifecycle, "supportsWorkspaceRuntimeLifecycle");
var WorkspaceRuntimeCoordinator = class {
  constructor(runtime, bridge) {
    this.runtime = runtime;
    this.bridge = bridge;
  }
  static {
    __name(this, "WorkspaceRuntimeCoordinator");
  }
  disposed = false;
  draining = false;
  activeManagementOperations = 0;
  skillsRevision = 0;
  mcpRevision = 0;
  mcpConfigRevision = 0;
  skillsStatus = {
    state: "not_started",
    revision: 0
  };
  mcpStatus = {
    state: "not_started",
    revision: 0
  };
  skillsReconcileDeferred = false;
  skillsRefreshRetryRevision;
  skillsRefreshFailedRevision;
  skillsTail = Promise.resolve();
  skillsQueuedWork = 0;
  mcpReconcileDeferred = false;
  mcpPhysicalTail = Promise.resolve();
  mcpQueuedWork = 0;
  beginDrain() {
    this.draining = true;
  }
  cancelDrain() {
    if (this.disposed) return;
    this.draining = false;
    if (this.skillsReconcileDeferred) {
      this.skillsReconcileDeferred = false;
      this.scheduleSkillsReconciliation();
    }
    if (this.mcpReconcileDeferred) {
      this.mcpReconcileDeferred = false;
      this.scheduleMcpReconciliation();
    }
  }
  hasActiveWork() {
    return this.activeManagementOperations > 0 || this.skillsQueuedWork > 0 || this.mcpQueuedWork > 0 || this.bridge.getWorkspaceRuntimeLifecycleSnapshot().activeWork;
  }
  dispose() {
    this.disposed = true;
    this.draining = true;
  }
  status() {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    const skillsStatus = this.skillsStatus.runtimeEpoch !== void 0 && (!snapshot.runtimeLive || this.skillsStatus.runtimeEpoch !== snapshot.runtimeEpoch) ? {
      state: "stale",
      revision: this.skillsStatus.revision,
      runtimeEpoch: this.skillsStatus.runtimeEpoch
    } : this.skillsStatus;
    const mcpStatus = this.mcpStatus.runtimeEpoch !== void 0 && (!snapshot.runtimeLive || this.mcpStatus.runtimeEpoch !== snapshot.runtimeEpoch) ? {
      state: "stale",
      revision: this.mcpStatus.revision,
      runtimeEpoch: this.mcpStatus.runtimeEpoch
    } : this.mcpStatus;
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd: this.runtime.workspaceCwd,
      state: snapshot.state,
      runtimeLive: snapshot.runtimeLive,
      runtimeEpoch: snapshot.runtimeEpoch,
      capabilities: { mcp: mcpStatus, skills: skillsStatus }
    };
  }
  /**
   * `ensure(timeoutMs)` always keep-alive preheats. `ensure({ ... })` skips
   * that preheat on a live runtime unless `skipKeepAlivePreheat` is false or
   * `keepAliveMs` is set. Boot discovery must pass `keepAliveMs` so the
   * already-warm child stays held through `initializeWorkspaceMcp`.
   */
  async ensure(timeoutMsOrOptions = DEFAULT_ENSURE_TIMEOUT_MS) {
    const options = typeof timeoutMsOrOptions === "number" ? { timeoutMs: timeoutMsOrOptions } : timeoutMsOrOptions;
    const timeoutMs = options.timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS;
    this.assertAcceptingWork();
    const deadline = Date.now() + timeoutMs;
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    const skipKeepAlivePreheat = snapshot.runtimeLive && options.keepAliveMs === void 0 && (options.skipKeepAlivePreheat ?? typeof timeoutMsOrOptions !== "number");
    if (!skipKeepAlivePreheat) {
      try {
        await withTimeout(
          this.bridge.preheat({
            keepAliveMs: options.keepAliveMs ?? ENSURE_KEEP_ALIVE_MS
          }),
          timeoutMs
        );
      } catch (error) {
        this.assertAcceptingWork(error);
        if (error instanceof WorkspaceRuntimeStillStartingError || error instanceof AcpChildCapacityExceededError)
          throw error;
        throw new WorkspaceRuntimeInitializationError(error);
      }
    }
    this.assertAcceptingWork();
    const status = this.status();
    if (!status.runtimeLive) {
      throw new WorkspaceRuntimeInitializationError(
        new Error(
          skipKeepAlivePreheat ? "Runtime is not live after skipping keep-alive preheat" : "ACP preheat completed without a live runtime"
        )
      );
    }
    const skillsReady = status.capabilities?.skills?.state === "ready" && status.capabilities.skills.runtimeEpoch === status.runtimeEpoch;
    const mcpReady = status.capabilities?.mcp?.state === "ready" && status.capabilities.mcp.runtimeEpoch === status.runtimeEpoch;
    if (skillsReady && mcpReady) {
      return status;
    }
    const skillsRevision = this.skillsRevision;
    const mcpRevision = this.mcpRevision;
    const skillsPrep = skillsReady ? Promise.resolve() : this.prepareSkills();
    void skillsPrep.catch((error) => {
      this.recordSkillsError(skillsRevision, status.runtimeEpoch, error);
    });
    const mcpPrep = mcpReady ? Promise.resolve() : this.prepareMcp();
    void mcpPrep.catch((error) => {
      this.recordMcpError(mcpRevision, status.runtimeEpoch, error);
    });
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      try {
        await withTimeout(Promise.all([skillsPrep, mcpPrep]), remainingMs);
      } catch (error) {
        this.assertAcceptingWork(error);
        if (!(error instanceof WorkspaceRuntimeStillStartingError)) {
          throw new WorkspaceRuntimeInitializationError(error);
        }
      }
    }
    const finalStatus = this.status();
    if (!finalStatus.runtimeLive) {
      throw new WorkspaceRuntimeInitializationError(
        new Error("Workspace runtime stopped during Skills/MCP preparation")
      );
    }
    return finalStatus;
  }
  async runManagementOperation(run) {
    this.assertAcceptingWork();
    this.activeManagementOperations += 1;
    try {
      return await run();
    } finally {
      this.activeManagementOperations -= 1;
    }
  }
  reconcileSkillsConfiguration() {
    this.skillsRevision += 1;
    this.skillsRefreshRetryRevision = void 0;
    this.skillsRefreshFailedRevision = void 0;
    return this.scheduleSkillsReconciliation();
  }
  scheduleSkillsReconciliation() {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive || this.draining || this.disposed) {
      this.skillsReconcileDeferred ||= snapshot.runtimeLive && this.draining;
      if (snapshot.state === "starting") {
        this.skillsRefreshRetryRevision = this.skillsRevision;
      }
      this.skillsStatus = {
        state: this.skillsStatus.runtimeEpoch === void 0 ? "not_started" : "stale",
        revision: this.skillsRevision,
        ...this.skillsStatus.runtimeEpoch === void 0 ? {} : { runtimeEpoch: this.skillsStatus.runtimeEpoch }
      };
      return "deferred";
    }
    const revision = this.skillsRevision;
    this.skillsStatus = {
      state: "starting",
      revision,
      runtimeEpoch: snapshot.runtimeEpoch
    };
    void this.queueSkillsWork(async () => {
      if (revision !== this.skillsRevision) return;
      await this.refreshSkillsRevision(revision);
      await this.prepareSkillsRevision(revision);
    }).catch((error) => {
      if (this.draining && !this.disposed) this.skillsReconcileDeferred = true;
      if (!this.draining && !this.disposed && revision === this.skillsRevision) {
        this.skillsRefreshRetryRevision = revision;
      }
      this.recordSkillsError(revision, snapshot.runtimeEpoch, error);
    });
    return "reconciling";
  }
  reconcileMcpConfiguration() {
    this.mcpRevision += 1;
    this.mcpConfigRevision += 1;
    return this.scheduleMcpReconciliation();
  }
  scheduleMcpReconciliation() {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive || this.draining || this.disposed) {
      this.mcpReconcileDeferred ||= snapshot.runtimeLive && this.draining;
      this.mcpStatus = {
        state: this.mcpStatus.runtimeEpoch === void 0 ? "not_started" : "stale",
        revision: this.mcpRevision,
        ...this.mcpStatus.runtimeEpoch === void 0 ? {} : { runtimeEpoch: this.mcpStatus.runtimeEpoch }
      };
      return "deferred";
    }
    this.mcpStatus = {
      state: "starting",
      revision: this.mcpRevision,
      runtimeEpoch: snapshot.runtimeEpoch
    };
    const revision = this.mcpRevision;
    const configRevision = this.mcpConfigRevision;
    void this.queueMcpWork(async () => {
      if (configRevision !== this.mcpConfigRevision) return;
      await this.bridge.reloadWorkspaceMcp();
      await this.prepareMcpRevision(revision);
    }).catch((error) => {
      if (this.draining && !this.disposed) this.mcpReconcileDeferred = true;
      this.recordMcpError(revision, snapshot.runtimeEpoch, error);
    });
    return "reconciling";
  }
  prepareSkills() {
    const revision = this.skillsRevision;
    return this.queueSkillsWork(async () => {
      const status = this.status();
      if (status.capabilities?.skills?.state === "ready" && status.capabilities.skills.runtimeEpoch === status.runtimeEpoch) {
        return;
      }
      if (status.capabilities?.skills?.state === "error" && status.capabilities.skills.revision === revision && status.capabilities.skills.runtimeEpoch === status.runtimeEpoch && this.skillsRefreshFailedRevision === revision) {
        return;
      }
      if (this.skillsRefreshRetryRevision === revision) {
        try {
          await this.refreshSkillsRevision(revision);
        } catch (error) {
          if (this.skillsRefreshRetryRevision === revision) {
            this.skillsRefreshRetryRevision = void 0;
          }
          this.skillsRefreshFailedRevision = revision;
          const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
          this.recordSkillsError(revision, snapshot.runtimeEpoch, error);
          return;
        }
      }
      await this.prepareSkillsRevision(revision);
    });
  }
  async refreshSkillsRevision(revision) {
    const result = await this.bridge.invokeWorkspaceCommand(
      SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh,
      { cwd: this.runtime.workspaceCwd, reason: "all" }
    );
    if ((result.configsFailed ?? 0) > 0) {
      throw new Error("Skills runtime refresh failed");
    }
    if (revision === this.skillsRefreshRetryRevision) {
      this.skillsRefreshRetryRevision = void 0;
    }
  }
  async runMcpRuntimeMutation(run) {
    this.assertAcceptingWork();
    const revision = ++this.mcpRevision;
    const initial = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    this.mcpStatus = {
      state: initial.runtimeLive ? "starting" : "not_started",
      revision,
      ...initial.runtimeLive ? { runtimeEpoch: initial.runtimeEpoch } : {}
    };
    let started = false;
    const operation = this.queueMcpWork(async () => {
      started = true;
      let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      let mutationRejected = false;
      try {
        if (!snapshot.runtimeLive) {
          try {
            await this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS });
          } catch (error) {
            if (error instanceof WorkspaceRuntimeStillStartingError || error instanceof AcpChildCapacityExceededError)
              throw error;
            throw new WorkspaceRuntimeInitializationError(error);
          }
          snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
          if (!snapshot.runtimeLive) {
            throw new WorkspaceRuntimeInitializationError(
              new Error("ACP preheat completed without a live runtime")
            );
          }
        }
        if (revision === this.mcpRevision) {
          this.mcpStatus = {
            state: "starting",
            revision,
            runtimeEpoch: snapshot.runtimeEpoch
          };
        }
        let result;
        try {
          result = await run();
        } catch (error) {
          mutationRejected = true;
          void this.queueMcpWork(() => this.prepareMcpRevision(revision)).catch(
            (prepareError) => {
              this.recordMcpError(
                revision,
                snapshot.runtimeEpoch,
                prepareError
              );
            }
          );
          throw error;
        }
        await this.prepareMcpRevision(revision);
        return result;
      } catch (error) {
        if (!mutationRejected) {
          this.recordMcpError(revision, snapshot.runtimeEpoch, error);
        }
        throw error;
      }
    });
    try {
      return await operation;
    } catch (error) {
      if (!started) {
        if (this.draining && !this.disposed) this.mcpReconcileDeferred = true;
        this.recordMcpError(revision, initial.runtimeEpoch, error);
      }
      throw error;
    }
  }
  prepareMcp() {
    const revision = this.mcpRevision;
    return this.queueMcpWork(() => this.prepareMcpRevision(revision));
  }
  queueSkillsWork(run) {
    this.skillsQueuedWork += 1;
    const operation = this.skillsTail.catch(() => void 0).then(async () => {
      this.assertAcceptingWork();
      return await run();
    }).finally(() => {
      this.skillsQueuedWork -= 1;
    });
    this.skillsTail = operation.then(
      () => void 0,
      () => void 0
    );
    return operation;
  }
  queueMcpWork(run) {
    this.mcpQueuedWork += 1;
    const operation = this.mcpPhysicalTail.catch(() => void 0).then(async () => {
      this.assertAcceptingWork();
      return await run();
    }).finally(() => {
      this.mcpQueuedWork -= 1;
    });
    this.mcpPhysicalTail = operation.then(
      () => void 0,
      () => void 0
    );
    return operation;
  }
  async prepareSkillsRevision(revision) {
    let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive) {
      await withTimeout(
        this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS }),
        DEFAULT_ENSURE_TIMEOUT_MS
      );
      snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    }
    const runtimeEpoch = snapshot.runtimeEpoch;
    if (revision !== this.skillsRevision) return;
    this.skillsStatus = { state: "starting", revision, runtimeEpoch };
    try {
      this.runtime.workspaceService.invalidateWorkspaceSkillsStatus();
      const status = await this.runtime.workspaceService.getWorkspaceSkillsRuntimeStatus({
        route: "workspace runtime Skills preparation",
        workspaceCwd: this.runtime.workspaceCwd
      });
      const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      if (revision !== this.skillsRevision) return;
      if (this.draining || !current.runtimeLive || current.runtimeEpoch !== runtimeEpoch || status.runtimeEpoch !== runtimeEpoch) {
        this.skillsStatus = { state: "stale", revision, runtimeEpoch };
        return;
      }
      if (status.errors?.length) {
        throw new Error(
          status.errors?.[0]?.error ?? "Skills runtime did not return a live snapshot"
        );
      }
      if (!status.initialized) {
        this.skillsStatus = { state: "stale", revision, runtimeEpoch };
        return;
      }
      this.skillsStatus = { state: "ready", revision, runtimeEpoch };
    } catch (error) {
      this.recordSkillsError(revision, runtimeEpoch, error);
    }
  }
  async prepareMcpRevision(revision) {
    const deadline = Date.now() + MCP_PREPARE_TIMEOUT_MS;
    let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive) {
      try {
        await this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS });
      } catch (error) {
        if (error instanceof WorkspaceRuntimeStillStartingError || error instanceof AcpChildCapacityExceededError)
          throw error;
        throw new WorkspaceRuntimeInitializationError(error);
      }
      snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    }
    const epoch = snapshot.runtimeEpoch;
    if (revision !== this.mcpRevision) return;
    this.mcpStatus = { state: "starting", revision, runtimeEpoch: epoch };
    try {
      let status = await this.runtime.workspaceService.getWorkspaceMcpStatus({
        route: "workspace runtime MCP preparation",
        workspaceCwd: this.runtime.workspaceCwd
      });
      let initializationRequested = false;
      while (true) {
        if (revision !== this.mcpRevision) return;
        const current2 = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
        if (this.draining || this.disposed || !current2.runtimeLive || current2.runtimeEpoch !== epoch) {
          if (this.draining && !this.disposed && current2.runtimeLive && current2.runtimeEpoch === epoch) {
            this.mcpReconcileDeferred = true;
          }
          this.mcpStatus = { state: "stale", revision, runtimeEpoch: epoch };
          return;
        }
        const currentEpochStatus = status.runtimeEpoch === epoch && status.source === "live";
        if (currentEpochStatus && status.discoveryState === "not_started" && !initializationRequested) {
          initializationRequested = true;
          await this.bridge.initializeWorkspaceMcp();
        }
        if (currentEpochStatus && status.errors?.length) {
          throw new Error(
            status.errors[0]?.error ?? "MCP discovery failed to initialize"
          );
        }
        if (currentEpochStatus && status.discoveryState === "completed") break;
        if (Date.now() >= deadline) {
          throw new WorkspaceRuntimeStillStartingError();
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, MCP_POLL_INTERVAL_MS);
          timer.unref?.();
        });
        status = await this.runtime.workspaceService.getWorkspaceMcpStatus({
          route: "workspace runtime MCP preparation",
          workspaceCwd: this.runtime.workspaceCwd
        });
      }
      const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      if (revision !== this.mcpRevision) return;
      if (!current.runtimeLive || current.runtimeEpoch !== epoch) {
        this.mcpStatus = { state: "stale", revision, runtimeEpoch: epoch };
        return;
      }
      this.mcpStatus = { state: "ready", revision, runtimeEpoch: epoch };
    } catch (error) {
      this.recordMcpError(revision, epoch, error);
    }
  }
  recordSkillsError(revision, runtimeEpoch, error) {
    const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (revision !== this.skillsRevision) return;
    if (this.draining || !current.runtimeLive || current.runtimeEpoch !== runtimeEpoch) {
      this.skillsStatus = { state: "stale", revision, runtimeEpoch };
      return;
    }
    this.skillsStatus = {
      state: "error",
      revision,
      runtimeEpoch,
      error: {
        code: "skills_prepare_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  recordMcpError(revision, runtimeEpoch, error) {
    const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (revision !== this.mcpRevision) return;
    if (this.draining || !current.runtimeLive || current.runtimeEpoch !== runtimeEpoch) {
      this.mcpStatus = { state: "stale", revision, runtimeEpoch };
      return;
    }
    this.mcpStatus = {
      state: "error",
      revision,
      runtimeEpoch,
      error: {
        code: error instanceof WorkspaceRuntimeStillStartingError ? "mcp_prepare_timed_out" : "mcp_prepare_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  assertAcceptingWork(cause) {
    this.runtime.generationGuard?.assertOpen();
    if (this.disposed || this.draining) {
      throw new WorkspaceDrainingError(this.runtime.workspaceCwd, cause);
    }
  }
};
function getWorkspaceRuntimeCoordinatorIfSupported(runtime) {
  if (!supportsWorkspaceRuntimeLifecycle(runtime.bridge)) return void 0;
  runtime.runtimeCoordinator ??= new WorkspaceRuntimeCoordinator(
    runtime,
    runtime.bridge
  );
  return runtime.runtimeCoordinator;
}
__name(getWorkspaceRuntimeCoordinatorIfSupported, "getWorkspaceRuntimeCoordinatorIfSupported");
function getWorkspaceRuntimeCoordinator(runtime) {
  const coordinator = getWorkspaceRuntimeCoordinatorIfSupported(runtime);
  if (!coordinator) {
    throw new Error("Workspace runtime lifecycle is not supported");
  }
  return coordinator;
}
__name(getWorkspaceRuntimeCoordinator, "getWorkspaceRuntimeCoordinator");

export {
  ENSURE_KEEP_ALIVE_MS,
  WorkspaceRuntimeStillStartingError,
  WorkspaceRuntimeInitializationError,
  supportsWorkspaceRuntimeLifecycle,
  WorkspaceRuntimeCoordinator,
  getWorkspaceRuntimeCoordinatorIfSupported,
  getWorkspaceRuntimeCoordinator
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
