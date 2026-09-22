// Force strict mode and setup for ESM
"use strict";
import {
  isInternalWorkspaceRuntime
} from "./chunk-NYWWQ437.js";
import {
  SessionNotFoundError
} from "./chunk-YXHY6BKS.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/workspace-registry.ts
init_esbuild_shims();
var WorkspaceGenerationClosedError = class extends Error {
  static {
    __name(this, "WorkspaceGenerationClosedError");
  }
  code = "workspace_generation_closed";
  constructor(message = "Workspace runtime generation is no longer active.") {
    super(message);
    this.name = "WorkspaceGenerationClosedError";
  }
};
function createWorkspaceGenerationGuard() {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    assertOpen() {
      if (closed) throw new WorkspaceGenerationClosedError();
    },
    close() {
      closed = true;
    }
  };
}
__name(createWorkspaceGenerationGuard, "createWorkspaceGenerationGuard");
function createWorkspaceSessionOwnerIndex() {
  const bySessionId = /* @__PURE__ */ new Map();
  const unavailableWorkspaces = /* @__PURE__ */ new Set();
  const register = /* @__PURE__ */ __name((sessionId, workspaceCwd) => {
    let owners = bySessionId.get(sessionId);
    if (!owners) {
      owners = /* @__PURE__ */ new Set();
      bySessionId.set(sessionId, owners);
    }
    owners.add(workspaceCwd);
  }, "register");
  const remove = /* @__PURE__ */ __name((sessionId, workspaceCwd) => {
    if (workspaceCwd === void 0) {
      const owners2 = bySessionId.get(sessionId);
      if (!owners2) return;
      for (const owner of owners2) {
        if (!unavailableWorkspaces.has(owner)) owners2.delete(owner);
      }
      if (owners2.size === 0) bySessionId.delete(sessionId);
      return;
    }
    if (unavailableWorkspaces.has(workspaceCwd)) return;
    const owners = bySessionId.get(sessionId);
    if (!owners) return;
    owners.delete(workspaceCwd);
    if (owners.size === 0) {
      bySessionId.delete(sessionId);
    }
  }, "remove");
  return {
    register,
    remove,
    getWorkspaceCwds: /* @__PURE__ */ __name((sessionId) => [...bySessionId.get(sessionId) ?? []], "getWorkspaceCwds"),
    markWorkspaceUnavailable: /* @__PURE__ */ __name((workspaceCwd) => {
      unavailableWorkspaces.add(workspaceCwd);
    }, "markWorkspaceUnavailable"),
    isWorkspaceUnavailable: /* @__PURE__ */ __name((workspaceCwd) => unavailableWorkspaces.has(workspaceCwd), "isWorkspaceUnavailable"),
    removeWorkspace: /* @__PURE__ */ __name((workspaceCwd) => {
      if (unavailableWorkspaces.has(workspaceCwd)) return;
      for (const [sessionId, owners] of bySessionId) {
        owners.delete(workspaceCwd);
        if (owners.size === 0) bySessionId.delete(sessionId);
      }
    }, "removeWorkspace"),
    handleBridgeSessionLifecycle: /* @__PURE__ */ __name((event) => {
      if (event.type === "registered") {
        register(event.sessionId, event.workspaceCwd);
      } else {
        remove(event.sessionId, event.workspaceCwd);
      }
    }, "handleBridgeSessionLifecycle")
  };
}
__name(createWorkspaceSessionOwnerIndex, "createWorkspaceSessionOwnerIndex");
function createWorkspaceRegistry(inputRuntimes, options = {}) {
  if (inputRuntimes.length === 0) {
    throw new Error(
      "WorkspaceRegistry requires at least one workspace runtime."
    );
  }
  const primaryRuntimes = inputRuntimes.filter((runtime) => runtime.primary);
  if (primaryRuntimes.length !== 1) {
    throw new Error(
      "WorkspaceRegistry requires exactly one primary workspace runtime."
    );
  }
  const byCwd = /* @__PURE__ */ new Map();
  const byId = /* @__PURE__ */ new Map();
  const createEntry = /* @__PURE__ */ __name((runtime, generationId) => ({
    workspaceId: runtime.workspaceId,
    workspaceCwd: runtime.workspaceCwd,
    ...runtime.displayName !== void 0 ? { displayName: runtime.displayName } : {},
    primary: runtime.primary,
    removable: runtime.removable === true,
    internal: isInternalWorkspaceRuntime(runtime),
    registrationIds: Object.freeze([...runtime.registrationIds ?? []]),
    lastGenerationId: generationId,
    state: "active",
    current: {
      generationId,
      policyRevision: "boot",
      runtime,
      guard: runtime.generationGuard ?? createWorkspaceGenerationGuard()
    },
    configuredRevision: "boot",
    appliedRevision: "boot"
  }), "createEntry");
  const entries = [];
  for (const runtime of inputRuntimes) {
    if (byCwd.has(runtime.workspaceCwd)) {
      throw new Error(
        `Duplicate workspace runtime cwd ${JSON.stringify(
          runtime.workspaceCwd
        )}.`
      );
    }
    const entry = createEntry(runtime, 1);
    byCwd.set(runtime.workspaceCwd, entry);
    if (byId.has(runtime.workspaceId)) {
      throw new Error(
        `Duplicate workspace runtime id ${JSON.stringify(
          runtime.workspaceId
        )}.`
      );
    }
    byId.set(runtime.workspaceId, entry);
    entries.push(entry);
  }
  const primaryEntry = entries.find((entry) => entry.primary);
  const entryForRuntime = /* @__PURE__ */ __name((runtime) => {
    const entry = byId.get(runtime.workspaceId);
    return entry?.current?.runtime === runtime ? entry : void 0;
  }, "entryForRuntime");
  const activeRuntime = /* @__PURE__ */ __name((entry) => entry?.state === "active" ? entry.current?.runtime : void 0, "activeRuntime");
  const requirePrimaryRuntime = /* @__PURE__ */ __name(() => {
    const runtime = primaryEntry.state === "active" ? primaryEntry.current?.runtime : void 0;
    if (!runtime) {
      throw new WorkspaceGenerationClosedError(
        "Primary workspace runtime is unavailable."
      );
    }
    return runtime;
  }, "requirePrimaryRuntime");
  const sessionOwnerIndex = options.sessionOwnerIndex;
  const scanLiveOwners = /* @__PURE__ */ __name((sessionId) => {
    const matches = [];
    for (const entry of entries) {
      const runtime = activeRuntime(entry);
      if (!runtime) continue;
      try {
        runtime.bridge.getSessionSummary(sessionId);
        matches.push(runtime);
      } catch (err) {
        if (err instanceof SessionNotFoundError) continue;
        throw err;
      }
    }
    for (const match of matches) {
      sessionOwnerIndex?.register(sessionId, match.workspaceCwd);
    }
    if (matches.length === 0) return { kind: "not_found" };
    if (matches.length === 1) {
      return { kind: "found", runtime: matches[0] };
    }
    return { kind: "ambiguous", runtimes: matches };
  }, "scanLiveOwners");
  return {
    get primary() {
      return requirePrimaryRuntime();
    },
    primaryEntry,
    // Return a frozen snapshot: `runtimes` is mutable internally (see `add`),
    // but callers must not be able to push/splice into the registry's state.
    list: /* @__PURE__ */ __name(() => Object.freeze(
      entries.flatMap((entry) => {
        const runtime = activeRuntime(entry);
        return runtime && !entry.internal ? [runtime] : [];
      })
    ), "list"),
    listEntries: /* @__PURE__ */ __name(() => Object.freeze(
      entries.filter((entry) => entry.state !== "removed" && !entry.internal)
    ), "listEntries"),
    listAll: /* @__PURE__ */ __name(() => Object.freeze(
      entries.flatMap((entry) => {
        const runtime = activeRuntime(entry);
        return runtime ? [runtime] : [];
      })
    ), "listAll"),
    listAllEntries: /* @__PURE__ */ __name(() => Object.freeze(
      entries.filter((entry) => entry.state !== "removed")
    ), "listAllEntries"),
    listManaged: /* @__PURE__ */ __name(() => Object.freeze(
      entries.flatMap(
        (entry) => entry.current?.runtime ? [entry.current.runtime] : []
      )
    ), "listManaged"),
    getEntryByWorkspaceCwd: /* @__PURE__ */ __name((workspaceCwd) => {
      const entry = byCwd.get(workspaceCwd);
      return entry?.internal ? void 0 : entry;
    }, "getEntryByWorkspaceCwd"),
    getEntryByWorkspaceId: /* @__PURE__ */ __name((workspaceId) => {
      const entry = byId.get(workspaceId);
      return entry?.internal ? void 0 : entry;
    }, "getEntryByWorkspaceId"),
    getManagedEntryByWorkspaceCwd: /* @__PURE__ */ __name((workspaceCwd) => byCwd.get(workspaceCwd), "getManagedEntryByWorkspaceCwd"),
    getManagedEntryByWorkspaceId: /* @__PURE__ */ __name((workspaceId) => byId.get(workspaceId), "getManagedEntryByWorkspaceId"),
    beginReplacement: /* @__PURE__ */ __name((entry, configuredRevision) => {
      if (entry.state === "blocked") {
        entry.configuredRevision = configuredRevision;
        entry.state = "transitioning";
        entry.current?.guard.close();
        if (!entry.internal) {
          sessionOwnerIndex?.removeWorkspace(entry.workspaceCwd);
        }
        delete entry.applyError;
        return true;
      }
      if (entry.state !== "active" || !entry.current) return false;
      entry.configuredRevision = configuredRevision;
      entry.state = "transitioning";
      entry.current.guard.close();
      if (!entry.internal) {
        sessionOwnerIndex?.removeWorkspace(entry.workspaceCwd);
      }
      delete entry.applyError;
      return true;
    }, "beginReplacement"),
    activateReplacement: /* @__PURE__ */ __name((entry, runtime, policyRevision) => {
      if (entry.state !== "transitioning") {
        throw new Error(
          "Replacement runtime can only activate a transitioning entry."
        );
      }
      if (runtime.workspaceId !== entry.workspaceId || runtime.workspaceCwd !== entry.workspaceCwd || runtime.primary !== entry.primary || isInternalWorkspaceRuntime(runtime) !== entry.internal) {
        throw new Error("Replacement runtime identity does not match entry.");
      }
      if (entry.displayName === void 0) {
        delete runtime.displayName;
      } else {
        runtime.displayName = entry.displayName;
      }
      runtime.registrationIds = [...entry.registrationIds];
      const generationId = entry.lastGenerationId + 1;
      const generation = {
        generationId,
        policyRevision,
        runtime,
        guard: runtime.generationGuard ?? createWorkspaceGenerationGuard()
      };
      entry.lastGenerationId = generationId;
      entry.current = generation;
      entry.configuredRevision = policyRevision;
      entry.appliedRevision = policyRevision;
      entry.state = "active";
      delete entry.applyError;
      return generation;
    }, "activateReplacement"),
    advancePolicyRevision: /* @__PURE__ */ __name((entry, policyRevision) => {
      entry.configuredRevision = policyRevision;
      entry.appliedRevision = policyRevision;
      if (entry.current) {
        entry.current = { ...entry.current, policyRevision };
      }
      delete entry.applyError;
    }, "advancePolicyRevision"),
    blockReplacement: /* @__PURE__ */ __name((entry, error) => {
      entry.current?.guard.close();
      entry.state = "blocked";
      entry.appliedRevision = null;
      entry.applyError = error;
    }, "blockReplacement"),
    getByWorkspaceCwd: /* @__PURE__ */ __name((workspaceCwd) => {
      const entry = byCwd.get(workspaceCwd);
      return entry?.internal ? void 0 : activeRuntime(entry);
    }, "getByWorkspaceCwd"),
    getByWorkspaceId: /* @__PURE__ */ __name((workspaceId) => {
      const entry = byId.get(workspaceId);
      return entry?.internal ? void 0 : activeRuntime(entry);
    }, "getByWorkspaceId"),
    getManagedByWorkspaceCwd: /* @__PURE__ */ __name((workspaceCwd) => byCwd.get(workspaceCwd)?.current?.runtime, "getManagedByWorkspaceCwd"),
    getManagedByWorkspaceId: /* @__PURE__ */ __name((workspaceId) => byId.get(workspaceId)?.current?.runtime, "getManagedByWorkspaceId"),
    syncRuntimeMetadata: /* @__PURE__ */ __name((runtime) => {
      const entry = byCwd.get(runtime.workspaceCwd);
      if (!entry || entry.workspaceId !== runtime.workspaceId) return;
      if (runtime.displayName === void 0) {
        delete entry.displayName;
      } else {
        entry.displayName = runtime.displayName;
      }
      entry.registrationIds = Object.freeze([
        ...runtime.registrationIds ?? []
      ]);
      const current = entry.current?.runtime;
      if (!current || current === runtime) return;
      if (entry.displayName === void 0) {
        delete current.displayName;
      } else {
        current.displayName = entry.displayName;
      }
      current.registrationIds = [...entry.registrationIds];
    }, "syncRuntimeMetadata"),
    resolveWorkspaceCwd: /* @__PURE__ */ __name((workspaceCwd) => workspaceCwd === void 0 ? activeRuntime(primaryEntry) : (() => {
      const entry = byCwd.get(workspaceCwd);
      return entry?.internal ? void 0 : activeRuntime(entry);
    })(), "resolveWorkspaceCwd"),
    add: /* @__PURE__ */ __name((runtime) => {
      if (byCwd.has(runtime.workspaceCwd)) {
        throw new Error(
          `Duplicate workspace runtime cwd ${JSON.stringify(runtime.workspaceCwd)}.`
        );
      }
      if (byId.has(runtime.workspaceId)) {
        throw new Error(
          `Duplicate workspace runtime id ${JSON.stringify(runtime.workspaceId)}.`
        );
      }
      const entry = createEntry(runtime, 1);
      byCwd.set(runtime.workspaceCwd, entry);
      byId.set(runtime.workspaceId, entry);
      entries.push(entry);
    }, "add"),
    beginDrain: /* @__PURE__ */ __name((runtime) => {
      const entry = entryForRuntime(runtime);
      if (!entry || runtime.primary || entry.state !== "active") return false;
      entry.state = "draining";
      return true;
    }, "beginDrain"),
    cancelDrain: /* @__PURE__ */ __name((runtime) => {
      const entry = entryForRuntime(runtime);
      if (entry?.state === "draining" && entry.current?.guard.closed !== true) {
        entry.state = "active";
      }
    }, "cancelDrain"),
    commitDrain: /* @__PURE__ */ __name((runtime) => {
      const entry = entryForRuntime(runtime);
      if (!entry || runtime.primary || entry.state !== "draining") return;
      entry.current?.guard.close();
      if (entry.internal) {
        sessionOwnerIndex?.markWorkspaceUnavailable(runtime.workspaceCwd);
      } else {
        sessionOwnerIndex?.removeWorkspace(runtime.workspaceCwd);
      }
    }, "commitDrain"),
    completeDrain: /* @__PURE__ */ __name((runtime) => {
      const entry = entryForRuntime(runtime);
      if (!entry || runtime.primary || entry.state !== "draining") return;
      entry.current?.guard.close();
      entry.state = "removed";
      byCwd.delete(runtime.workspaceCwd);
      byId.delete(runtime.workspaceId);
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
      if (!entry.internal) {
        sessionOwnerIndex?.removeWorkspace(runtime.workspaceCwd);
      }
    }, "completeDrain"),
    resolveLiveSessionOwner: /* @__PURE__ */ __name((sessionId) => {
      const indexedCwds = sessionOwnerIndex?.getWorkspaceCwds(sessionId) ?? [];
      if (indexedCwds.length > 0) {
        const matches = [];
        let internalUnavailable = false;
        for (const workspaceCwd of indexedCwds) {
          const entry = byCwd.get(workspaceCwd);
          const runtime = entry?.current?.runtime;
          if (!entry || !runtime || entry.state === "removed") {
            if (sessionOwnerIndex?.isWorkspaceUnavailable(workspaceCwd)) {
              internalUnavailable = true;
              continue;
            }
            sessionOwnerIndex?.remove(sessionId, workspaceCwd);
            continue;
          }
          if (entry.state !== "active") {
            internalUnavailable ||= entry.internal;
            continue;
          }
          try {
            runtime.bridge.getSessionSummary(sessionId);
            matches.push(runtime);
          } catch (err) {
            if (err instanceof SessionNotFoundError) {
              sessionOwnerIndex?.remove(sessionId, workspaceCwd);
              continue;
            }
            throw err;
          }
        }
        if (internalUnavailable) return { kind: "unavailable" };
        if (matches.length === 1) {
          return { kind: "found", runtime: matches[0] };
        }
        if (matches.length > 1) {
          return { kind: "ambiguous", runtimes: matches };
        }
      }
      return options.scanUnindexedOwners !== false ? scanLiveOwners(sessionId) : { kind: "not_found" };
    }, "resolveLiveSessionOwner")
  };
}
__name(createWorkspaceRegistry, "createWorkspaceRegistry");
function createSingleWorkspaceRegistry(runtime, options = {}) {
  return createWorkspaceRegistry([runtime], options);
}
__name(createSingleWorkspaceRegistry, "createSingleWorkspaceRegistry");

export {
  WorkspaceGenerationClosedError,
  createWorkspaceGenerationGuard,
  createWorkspaceSessionOwnerIndex,
  createWorkspaceRegistry,
  createSingleWorkspaceRegistry
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
