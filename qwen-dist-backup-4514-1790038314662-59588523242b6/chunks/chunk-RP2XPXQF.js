// Force strict mode and setup for ESM
"use strict";
import {
  appEvents
} from "./chunk-PL2V2PQ2.js";
import {
  assembleMcpServers,
  getPendingGatedMcpServers,
  getPromptableMcpServers
} from "./chunk-V7HT4IYM.js";
import {
  getMCPServerStatus
} from "./chunk-KKGSJZWK.js";
import {
  require_fast_deep_equal
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/hot-reload.ts
init_esbuild_shims();
var import_fast_deep_equal = __toESM(require_fast_deep_equal(), 1);
var debugLogger = createDebugLogger("MCP_HOT_RELOAD");
var modelProvidersDebugLogger = createDebugLogger(
  "MODEL_PROVIDERS_HOT_RELOAD"
);
function mcpServersEqual(a, b) {
  return (0, import_fast_deep_equal.default)(a ?? {}, b ?? {});
}
__name(mcpServersEqual, "mcpServersEqual");
function mcpGatingEqual(a, b) {
  const norm = /* @__PURE__ */ __name((xs) => [...xs ?? []].sort(), "norm");
  const allowedEqual = a.allowed === void 0 === (b.allowed === void 0) && (0, import_fast_deep_equal.default)(norm(a.allowed), norm(b.allowed));
  return (0, import_fast_deep_equal.default)(norm(a.excluded), norm(b.excluded)) && allowedEqual && (0, import_fast_deep_equal.default)(norm(a.pending), norm(b.pending));
}
__name(mcpGatingEqual, "mcpGatingEqual");
function recomputeMcpGating(settings, assembled, cwd, bootAllowed, isYolo) {
  const settingsAllowed = settings.merged.mcp?.allowed?.filter(Boolean);
  const excluded = settings.merged.mcp?.excluded?.filter(Boolean);
  let allowed = settingsAllowed;
  if (bootAllowed) {
    allowed = settingsAllowed ? settingsAllowed.filter((n) => bootAllowed.includes(n)) : [...bootAllowed];
  }
  return {
    allowed,
    excluded: excluded && excluded.length > 0 ? excluded : void 0,
    pending: isYolo ? void 0 : getPendingGatedMcpServers(assembled, cwd)
  };
}
__name(recomputeMcpGating, "recomputeMcpGating");
function registerMcpHotReload(watcher, settings, config, topTierMcpServers) {
  debugLogger.debug("registered MCP hot-reload listener on SettingsWatcher");
  return watcher.addChangeListener(async (events) => {
    debugLogger.debug(
      `settings change fired (${events.length} event(s)): ${events.map((e) => `${e.scope}:${e.changeType}`).join(", ")}`
    );
    const cwd = config.getTargetDir();
    const next = config.getBareMode() || config.isSafeMode() ? { ...topTierMcpServers } : assembleMcpServers(
      settings.merged.mcpServers,
      cwd,
      topTierMcpServers
    );
    const isYolo = config.getApprovalMode() === "yolo" /* YOLO */;
    const bootAllowed = config.getCliAllowedMcpServerNames();
    const nextGating = config.getBareMode() || config.isSafeMode() ? { allowed: bootAllowed ? [...bootAllowed] : void 0 } : recomputeMcpGating(settings, next, cwd, bootAllowed, isYolo);
    const prevServers = config.getSettingsMcpServers();
    const prevGating = config.getMcpGating();
    debugLogger.debug(
      `assembled servers: prev=[${Object.keys(prevServers ?? {}).join(
        ", "
      )}] next=[${Object.keys(next).join(", ")}]`
    );
    debugLogger.debug(
      `gating next: excluded=[${(nextGating.excluded ?? []).join(
        ", "
      )}] allowed=[${(nextGating.allowed ?? []).join(
        ", "
      )}] pending=[${(nextGating.pending ?? []).join(", ")}]`
    );
    const serversChanged = !mcpServersEqual(prevServers, next);
    const gatingChanged = !mcpGatingEqual(prevGating, nextGating);
    if (!serversChanged && !gatingChanged) {
      debugLogger.debug(
        "no MCP-relevant change (servers + gating unchanged) \u2014 skipping reconcile"
      );
      return;
    }
    debugLogger.debug(
      `MCP-relevant change detected (serversChanged=${serversChanged} gatingChanged=${gatingChanged}) \u2014 reconciling`
    );
    const promptable = getPromptableMcpServers(next, cwd);
    config.setExcludedMcpServers(nextGating.excluded ?? []);
    config.setAllowedMcpServers(nextGating.allowed);
    config.setPendingMcpServers(nextGating.pending);
    try {
      await config.reinitializeMcpServers(next);
      const finalStatuses = Object.keys(next).map((name) => `${name}=${getMCPServerStatus(name)}`).join(", ");
      debugLogger.debug(
        `reinitializeMcpServers resolved; final statuses=[${finalStatuses}]`
      );
    } catch (err) {
      debugLogger.error(
        `reinitializeMcpServers threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
      );
      appEvents.emit(
        "log-error" /* LogError */,
        "Failed to reload MCP server settings; existing MCP state may be unchanged. Run with --debug for details."
      );
    }
    if (!isYolo && promptable.length > 0) {
      debugLogger.debug(
        `gated servers awaiting approval \u2192 emitting ${"mcp-pending-approval-changed" /* McpPendingApprovalChanged */}: [${promptable.join(
          ", "
        )}]`
      );
      appEvents.emit("mcp-pending-approval-changed" /* McpPendingApprovalChanged */);
    }
  });
}
__name(registerMcpHotReload, "registerMcpHotReload");
function registerModelProvidersHotReload(watcher, settings, config) {
  modelProvidersDebugLogger.debug(
    "registered modelProviders hot-reload listener on SettingsWatcher"
  );
  let refreshAuthRetryPending = false;
  const reconcile = /* @__PURE__ */ __name(async () => {
    const next = settings.merged.modelProviders;
    const providersUnchanged = (0, import_fast_deep_equal.default)(
      config.getModelProvidersConfig() ?? {},
      next ?? {}
    );
    if (providersUnchanged && !refreshAuthRetryPending) {
      return;
    }
    if (!providersUnchanged) {
      modelProvidersDebugLogger.debug(
        "modelProviders changed \u2014 reloading model registry"
      );
      try {
        config.reloadModelProvidersConfig(next);
      } catch (err) {
        modelProvidersDebugLogger.error(
          `reloadModelProvidersConfig threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
        );
        return;
      }
    }
    const authType = config.getAuthType();
    if (!authType) {
      return;
    }
    try {
      await config.refreshAuth(authType, true);
      refreshAuthRetryPending = false;
    } catch (err) {
      const alreadyPending = refreshAuthRetryPending;
      refreshAuthRetryPending = true;
      modelProvidersDebugLogger.error(
        `refreshAuth after modelProviders reload threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
      );
      if (!alreadyPending) {
        appEvents.emit(
          "log-error" /* LogError */,
          `Model provider settings reloaded, but re-authenticating the active model failed: ${err instanceof Error ? err.message : String(err)}. Select a model with /model or restart to apply the change.`
        );
      }
    }
  }, "reconcile");
  void reconcile();
  return watcher.addChangeListener(reconcile);
}
__name(registerModelProvidersHotReload, "registerModelProvidersHotReload");

export {
  recomputeMcpGating,
  registerMcpHotReload,
  registerModelProvidersHotReload
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
