// Force strict mode and setup for ESM
"use strict";
import {
  getPlugin
} from "./chunk-6GGSIMJR.js";
import {
  resolveChannelCwd
} from "./chunk-LFKXIOGC.js";
import {
  canonicalizeWorkspace
} from "./chunk-6PLDPT2C.js";
import {
  normalizeWorkerDiagnostic
} from "./chunk-L3SNMEDW.js";
import {
  isAllChannelSelectionName
} from "./chunk-GDWE23OR.js";
import {
  redactLogCredentials
} from "./chunk-M5GB774H.js";
import {
  PairingStore,
  sanitizeLogText
} from "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-management-service.ts
init_esbuild_shims();
var ChannelManagementError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ChannelManagementError";
  }
  static {
    __name(this, "ChannelManagementError");
  }
};
function diagnostic(error) {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeLogText(
    redactLogCredentials(normalizeWorkerDiagnostic(message)),
    512
  );
}
__name(diagnostic, "diagnostic");
function usesEnvironment(value) {
  return typeof value === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
__name(usesEnvironment, "usesEnvironment");
function createChannelManagementService(opts) {
  const diagnostics = /* @__PURE__ */ new Map();
  let mutationTail = Promise.resolve();
  const inMutationLane = /* @__PURE__ */ __name((mutation) => {
    const result = mutationTail.then(mutation, mutation);
    mutationTail = result.then(
      () => void 0,
      () => void 0
    );
    return result;
  }, "inMutationLane");
  const assertExpectedRevision = /* @__PURE__ */ __name((snapshot, expectedRevision) => {
    if (snapshot.revision !== expectedRevision) {
      throw new ChannelManagementError(
        "channel_settings_conflict",
        "Channel settings changed; reload before trying again."
      );
    }
  }, "assertExpectedRevision");
  const workerFor = /* @__PURE__ */ __name((name) => {
    const matches = opts.manager.state().workers.filter(
      (worker) => worker.adapters?.some((adapter) => adapter.name === name) || worker.requestedChannels?.includes(name) || worker.channels.includes(name)
    );
    return matches;
  }, "workerFor");
  const workspaceCommittedNames = /* @__PURE__ */ __name(() => opts.manager.committedChannelNames().filter(
    (name) => workerFor(name).some((w) => w.workspaceCwd === opts.workspaceCwd)
  ), "workspaceCommittedNames");
  const assertOwnedRuntime = /* @__PURE__ */ __name((name) => {
    if (!workspaceCommittedNames().includes(name)) return;
    const workers = workerFor(name).filter(
      (worker) => worker.workspaceCwd === opts.workspaceCwd
    );
    if (workers.length !== 1) {
      throw new ChannelManagementError(
        "channel_runtime_owner_mismatch",
        `Channel "${name}" does not have one confirmed runtime owner in this workspace.`
      );
    }
  }, "assertOwnedRuntime");
  const runtimeFor = /* @__PURE__ */ __name((name) => {
    const retainedError = diagnostics.get(name);
    if (retainedError) return { state: "error", lastError: retainedError };
    if (!workspaceCommittedNames().includes(name)) {
      return { state: "stopped" };
    }
    const state = opts.manager.state();
    const workers = workerFor(name).filter(
      (worker2) => worker2.workspaceCwd === opts.workspaceCwd
    );
    if (workers.length !== 1) {
      return {
        state: "error",
        lastError: "Channel runtime owner is unknown or ambiguous."
      };
    }
    const worker = workers[0];
    const adapter = worker.adapters?.find((item) => item.name === name);
    if (adapter?.state === "connected") return { state: "connected" };
    if (adapter?.state === "error") {
      return {
        state: "error",
        ...adapter.error ? { lastError: diagnostic(adapter.error) } : {}
      };
    }
    if (adapter?.state === "starting" || state.transition === "starting" || state.transition === "reconciling") {
      return { state: "starting" };
    }
    if (worker.state === "running") return { state: "partial" };
    return {
      state: "error",
      ...worker.error ? { lastError: diagnostic(worker.error) } : {}
    };
  }, "runtimeFor");
  const instanceFrom = /* @__PURE__ */ __name(async (name, rawConfig, startupNames) => {
    const type = typeof rawConfig["type"] === "string" ? rawConfig["type"] : "";
    const plugin = type ? await getPlugin(type) : void 0;
    if (!plugin?.management) {
      return {
        name,
        config: type ? { type } : {},
        secrets: {},
        startsWithServe: startupNames.some(isAllChannelSelectionName) || startupNames.includes(name),
        runtime: runtimeFor(name)
      };
    }
    const secretKeys = new Set(
      plugin.management.fields.filter((field) => field.kind === "secret").map((field) => field.key)
    );
    const config = {};
    const secrets = {};
    for (const [key, value] of Object.entries(rawConfig)) {
      if (!secretKeys.has(key)) {
        config[key] = value;
        continue;
      }
      secrets[key] = {
        present: value !== void 0,
        ...value !== void 0 ? { source: usesEnvironment(value) ? "environment" : "literal" } : {}
      };
    }
    for (const key of secretKeys) {
      secrets[key] ??= { present: false };
    }
    return {
      name,
      config,
      secrets,
      startsWithServe: startupNames.some(isAllChannelSelectionName) || startupNames.includes(name),
      runtime: runtimeFor(name)
    };
  }, "instanceFrom");
  const listFrom = /* @__PURE__ */ __name(async (persisted) => {
    const entries = await Promise.all(
      Object.entries(persisted.channels).map(
        async ([name, config]) => [
          name,
          await instanceFrom(name, config, persisted.startupNames)
        ]
      )
    );
    return {
      revision: persisted.revision,
      instances: Object.fromEntries(entries)
    };
  }, "listFrom");
  const resultFor = /* @__PURE__ */ __name(async (name, persisted = opts.store.snapshot()) => {
    const snapshot = await listFrom(persisted);
    const instance = Object.hasOwn(snapshot.instances, name) ? snapshot.instances[name] : {
      name,
      config: {},
      secrets: {},
      startsWithServe: false,
      runtime: runtimeFor(name)
    };
    return { snapshot, instance };
  }, "resultFor");
  const stopChannel = /* @__PURE__ */ __name((name) => opts.manager.setChannelEnabled(
    { name, workspaceCwd: opts.workspaceCwd },
    false
  ), "stopChannel");
  const assertManageableInstanceName = /* @__PURE__ */ __name((name) => {
    if (isAllChannelSelectionName(name)) {
      throw new ChannelManagementError(
        "invalid_channel_instance_name",
        'Channel instance name "all" is reserved for startup selection.'
      );
    }
  }, "assertManageableInstanceName");
  const assertWorkspaceConfig = /* @__PURE__ */ __name((config) => {
    const rawCwd = config["cwd"];
    if (typeof rawCwd !== "string") return;
    const workspaceCwd = canonicalizeWorkspace(opts.workspaceCwd);
    const channelCwd = canonicalizeWorkspace(
      resolveChannelCwd(rawCwd, workspaceCwd)
    );
    if (channelCwd !== workspaceCwd) {
      throw new ChannelManagementError(
        "channel_workspace_mismatch",
        "Channel workspace must match the selected workspace."
      );
    }
  }, "assertWorkspaceConfig");
  const pairingStoreFor = /* @__PURE__ */ __name((name) => {
    assertManageableInstanceName(name);
    const channels = opts.store.snapshot().channels;
    if (!Object.hasOwn(channels, name)) {
      throw new ChannelManagementError(
        "channel_instance_not_found",
        `Channel "${name}" is not configured in this workspace.`
      );
    }
    const config = channels[name];
    assertWorkspaceConfig(config);
    if (config["senderPolicy"] !== "pairing" && config["groupPolicy"] !== "pairing") {
      throw new ChannelManagementError(
        "channel_pairing_not_enabled",
        `Channel "${name}" does not use pairing mode.`
      );
    }
    return new PairingStore(name, opts.workspaceCwd);
  }, "pairingStoreFor");
  const service = {
    async list() {
      return listFrom(opts.store.snapshot());
    },
    async upsert(name, request) {
      assertManageableInstanceName(name);
      assertWorkspaceConfig(request.config);
      const active = workspaceCommittedNames().includes(name);
      if (active) assertOwnedRuntime(name);
      const persisted = await opts.store.upsert(name, request);
      diagnostics.delete(name);
      if (active) {
        try {
          await opts.manager.reloadWorkspace(opts.workspaceCwd, name);
        } catch (error) {
          diagnostics.set(name, diagnostic(error));
          try {
            await stopChannel(name);
          } catch {
          }
        }
      }
      return resultFor(name, persisted);
    },
    async remove(name, request) {
      assertManageableInstanceName(name);
      const current = opts.store.snapshot();
      if (!Object.hasOwn(current.channels, name)) {
        throw new ChannelManagementError(
          "channel_instance_not_found",
          `Channel "${name}" is not configured in this workspace.`
        );
      }
      assertWorkspaceConfig(current.channels[name]);
      assertExpectedRevision(current, request.expectedRevision);
      if (workspaceCommittedNames().includes(name)) {
        assertOwnedRuntime(name);
        await stopChannel(name);
      }
      const persisted = await opts.store.remove(name, request);
      diagnostics.delete(name);
      return resultFor(name, persisted);
    },
    async setStartup(name, request) {
      assertManageableInstanceName(name);
      const current = opts.store.snapshot();
      if (!Object.hasOwn(current.channels, name)) {
        throw new ChannelManagementError(
          "channel_instance_not_found",
          `Channel "${name}" is not configured in this workspace.`
        );
      }
      assertWorkspaceConfig(current.channels[name]);
      const startsAll = current.startupNames.some(isAllChannelSelectionName);
      if (startsAll && request.enabled) {
        assertExpectedRevision(current, request.expectedRevision);
        return resultFor(name, current);
      }
      const startupNames = startsAll ? Object.keys(current.channels).filter(
        (item) => !isAllChannelSelectionName(item) && item !== name
      ) : request.enabled ? current.startupNames.includes(name) ? current.startupNames : [...current.startupNames, name] : current.startupNames.filter((item) => item !== name);
      const persisted = await opts.store.setStartupNames(startupNames, {
        expectedRevision: request.expectedRevision
      });
      return resultFor(name, persisted);
    },
    async start(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!Object.hasOwn(persisted.channels, name)) {
        throw new ChannelManagementError(
          "channel_instance_not_found",
          `Channel "${name}" is not configured in this workspace.`
        );
      }
      assertWorkspaceConfig(persisted.channels[name]);
      await opts.manager.setChannelEnabled(
        { name, workspaceCwd: opts.workspaceCwd },
        true
      );
      diagnostics.delete(name);
      return resultFor(name, persisted);
    },
    async stop(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!Object.hasOwn(persisted.channels, name)) {
        throw new ChannelManagementError(
          "channel_instance_not_found",
          `Channel "${name}" is not configured in this workspace.`
        );
      }
      assertWorkspaceConfig(persisted.channels[name]);
      await opts.manager.setChannelEnabled(
        { name, workspaceCwd: opts.workspaceCwd },
        false
      );
      diagnostics.delete(name);
      return resultFor(name, persisted);
    },
    async restart(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!Object.hasOwn(persisted.channels, name)) {
        throw new ChannelManagementError(
          "channel_instance_not_found",
          `Channel "${name}" is not configured in this workspace.`
        );
      }
      assertWorkspaceConfig(persisted.channels[name]);
      if (!workspaceCommittedNames().includes(name)) {
        throw new ChannelManagementError(
          "channel_worker_not_enabled",
          `Channel "${name}" is not running.`
        );
      }
      assertOwnedRuntime(name);
      try {
        await opts.manager.reloadWorkspace(opts.workspaceCwd, name);
        diagnostics.delete(name);
      } catch (error) {
        diagnostics.set(name, diagnostic(error));
        throw error;
      }
      return resultFor(name, persisted);
    },
    async pairingRequests(name) {
      return { requests: pairingStoreFor(name).listPending() };
    },
    async approvePairing(name, code) {
      const store = pairingStoreFor(name);
      const approved = store.approve(code);
      if (!approved) {
        throw new ChannelManagementError(
          "channel_pairing_request_not_found",
          "Pairing request was not found or has expired."
        );
      }
      return { approved, requests: store.listPending() };
    },
    async pairingApprovals(name) {
      const store = pairingStoreFor(name);
      return {
        senderIds: store.getAllowlist(),
        groupIds: store.getGroupAllowlist()
      };
    },
    async revokePairingApproval(name, subject) {
      const store = pairingStoreFor(name);
      const revoked = subject.type === "group" ? store.revokeGroup(subject.id) : store.revoke(subject.id);
      if (!revoked) {
        throw new ChannelManagementError(
          "channel_pairing_approval_not_found",
          "Pairing approval was not found."
        );
      }
      return {
        revoked: subject.id,
        senderIds: store.getAllowlist(),
        groupIds: store.getGroupAllowlist()
      };
    }
  };
  return {
    list: /* @__PURE__ */ __name(() => service.list(), "list"),
    upsert: /* @__PURE__ */ __name((name, request) => inMutationLane(() => service.upsert(name, request)), "upsert"),
    remove: /* @__PURE__ */ __name((name, request) => inMutationLane(() => service.remove(name, request)), "remove"),
    setStartup: /* @__PURE__ */ __name((name, request) => inMutationLane(() => service.setStartup(name, request)), "setStartup"),
    start: /* @__PURE__ */ __name((name) => inMutationLane(() => service.start(name)), "start"),
    stop: /* @__PURE__ */ __name((name) => inMutationLane(() => service.stop(name)), "stop"),
    restart: /* @__PURE__ */ __name((name) => inMutationLane(() => service.restart(name)), "restart"),
    pairingRequests: /* @__PURE__ */ __name((name) => service.pairingRequests(name), "pairingRequests"),
    approvePairing: /* @__PURE__ */ __name((name, code) => inMutationLane(() => service.approvePairing(name, code)), "approvePairing"),
    pairingApprovals: /* @__PURE__ */ __name((name) => service.pairingApprovals(name), "pairingApprovals"),
    revokePairingApproval: /* @__PURE__ */ __name((name, subject) => inMutationLane(() => service.revokePairingApproval(name, subject)), "revokePairingApproval")
  };
}
__name(createChannelManagementService, "createChannelManagementService");
export {
  ChannelManagementError,
  createChannelManagementService
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
