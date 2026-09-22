// Force strict mode and setup for ESM
"use strict";
import {
  appEvents
} from "./chunk-PL2V2PQ2.js";
import {
  CUSTOM_SANDBOX_IMAGE_ENV_VAR,
  HOST_UPDATE_RELAUNCH_ENV_VAR,
  SKIP_UPDATE_CHECK_ENV_VAR,
  requestUpdateOnExit
} from "./chunk-A4L3TDKL.js";
import {
  loadUndici
} from "./chunk-TXASDT2M.js";
import {
  IdeClient
} from "./chunk-MRTRBONQ.js";
import {
  getAllProviderBaseUrls
} from "./chunk-TLS6QN2S.js";
import {
  detectRuntime,
  getOrCreateSharedDispatcher,
  preloadRuntimeFetchModule,
  redactProxyCredentials
} from "./chunk-SBP43AO6.js";
import {
  initializeTelemetry
} from "./chunk-B3XJFEEH.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  recordStartupEvent
} from "./chunk-QILD6R27.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/startup/startup-prefetch.ts
init_esbuild_shims();

// packages/cli/src/utils/apiPreconnect.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("PRECONNECT");
var preconnectFired = false;
var preconnectInFlight;
var DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com",
  "qwen-oauth": "https://coding.dashscope.aliyuncs.com",
  anthropic: "https://api.anthropic.com",
  dashscope: "https://dashscope.aliyuncs.com"
};
var ALL_DEFAULT_URLS = [
  ...Object.values(DEFAULT_BASE_URLS),
  ...getAllProviderBaseUrls()
];
function shouldSkipPreconnect() {
  if (process.env["NODE_EXTRA_CA_CERTS"]) {
    debugLogger.debug("Skipping preconnect: custom CA certificate configured");
    return true;
  }
  return false;
}
__name(shouldSkipPreconnect, "shouldSkipPreconnect");
function isInSandboxMode() {
  return process.env["SANDBOX"] !== void 0;
}
__name(isInSandboxMode, "isInSandboxMode");
function isDefaultBaseUrl(baseUrl) {
  const normalizedInput = baseUrl.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return ALL_DEFAULT_URLS.some((defaultUrl) => {
    const normalizedDefault = defaultUrl.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return normalizedInput === normalizedDefault || normalizedInput.startsWith(normalizedDefault + "/");
  });
}
__name(isDefaultBaseUrl, "isDefaultBaseUrl");
function getPreconnectTargetUrl(authType, resolvedBaseUrl) {
  if (resolvedBaseUrl && /^https?:\/\//i.test(resolvedBaseUrl)) {
    if (isDefaultBaseUrl(resolvedBaseUrl)) {
      return resolvedBaseUrl;
    }
    debugLogger.debug(
      "Skipping preconnect: resolved baseUrl is not a default URL"
    );
    return void 0;
  }
  if (authType && DEFAULT_BASE_URLS[authType]) {
    return DEFAULT_BASE_URLS[authType];
  }
  return void 0;
}
__name(getPreconnectTargetUrl, "getPreconnectTargetUrl");
function preconnectApi(authType, options = {}) {
  if (preconnectFired) {
    return;
  }
  if (process.env["QWEN_CODE_DISABLE_PRECONNECT"] === "1") {
    debugLogger.debug("Preconnect disabled by environment variable");
    preconnectFired = true;
    return;
  }
  if (isInSandboxMode()) {
    debugLogger.debug("Skipping preconnect: sandbox mode detected");
    preconnectFired = true;
    return;
  }
  if (shouldSkipPreconnect()) {
    preconnectFired = true;
    return;
  }
  if (detectRuntime() !== "node") {
    debugLogger.debug("Skipping preconnect: unsupported runtime");
    preconnectFired = true;
    return;
  }
  if (!options.proxy) {
    debugLogger.debug("Skipping preconnect dispatcher: no proxy configured");
    return;
  }
  const proxy = options.proxy;
  const targetUrl = getPreconnectTargetUrl(authType, options.resolvedBaseUrl);
  if (!targetUrl) {
    debugLogger.debug("No target URL for preconnect");
    return;
  }
  preconnectFired = true;
  debugLogger.debug(`Preconnecting to: ${targetUrl}`);
  preconnectInFlight = (async () => {
    await preloadRuntimeFetchModule();
    const dispatcher = getOrCreateSharedDispatcher(proxy);
    const { fetch: undiciFetch } = await loadUndici();
    await undiciFetch(targetUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5e3),
      headers: {
        "User-Agent": "QwenCode-Preconnect/1.0"
      },
      dispatcher
    });
    debugLogger.debug("Preconnect completed");
  })().catch((error) => {
    const redactedError = redactProxyCredentials(String(error));
    debugLogger.debug(`Preconnect failed (ignored): ${redactedError}`);
  });
}
__name(preconnectApi, "preconnectApi");

// packages/cli/src/startup/startup-prefetch.ts
var debugLogger2 = createDebugLogger("STARTUP_PREFETCH");
var DEFERRED_IDE_CONNECT_TIMEOUT_MS = 15e3;
var earlyStarted = /* @__PURE__ */ new WeakSet();
var postRenderStarted = /* @__PURE__ */ new WeakSet();
function withTimeout(promise, name, timeoutMs, onTimeout = () => {
}) {
  let timeoutId;
  let timedOut = false;
  const runTimeoutCleanup = /* @__PURE__ */ __name(() => {
    void Promise.resolve().then(onTimeout).catch((err) => {
      debugLogger2.debug(`${name} timeout cleanup failed:`, err);
    });
  }, "runTimeoutCleanup");
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      runTimeoutCleanup();
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutId.unref?.();
  });
  void promise.then(
    () => {
      if (timedOut) {
        runTimeoutCleanup();
      }
    },
    (err) => {
      if (timedOut) {
        debugLogger2.debug(`${name} underlying error after timeout:`, err);
      }
    }
  );
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}
__name(withTimeout, "withTimeout");
function runDeferredTask(name, task) {
  recordStartupEvent("startup_prefetch_started", { name });
  void Promise.resolve().then(task).then(() => {
    recordStartupEvent("startup_prefetch_completed", { name });
  }).catch((err) => {
    recordStartupEvent("startup_prefetch_failed", { name });
    debugLogger2.warn(`${name} failed:`, err);
  });
}
__name(runDeferredTask, "runDeferredTask");
async function disconnectIdeAfterDeferredTimeout() {
  const ideClient = await IdeClient.getInstance();
  await ideClient.disconnect();
}
__name(disconnectIdeAfterDeferredTimeout, "disconnectIdeAfterDeferredTimeout");
function startEarlyStartupPrefetches(config) {
  if (earlyStarted.has(config)) return;
  earlyStarted.add(config);
  try {
    const modelsConfig = config.getModelsConfig();
    const authType = modelsConfig.getCurrentAuthType();
    const resolvedBaseUrl = modelsConfig.getGenerationConfig().baseUrl;
    const proxy = config.getProxy();
    preconnectApi(authType, { resolvedBaseUrl, proxy });
  } catch (error) {
    debugLogger2.debug(
      `Preconnect skipped due to error getting authType: ${error}`
    );
  }
}
__name(startEarlyStartupPrefetches, "startEarlyStartupPrefetches");
function startPostRenderPrefetches(config, settings, options = {}) {
  if (postRenderStarted.has(config)) return;
  postRenderStarted.add(config);
  if (settings.merged.general?.enableAutoUpdate !== false && process.env[SKIP_UPDATE_CHECK_ENV_VAR] !== "true" && !process.env[CUSTOM_SANDBOX_IMAGE_ENV_VAR]) {
    runDeferredTask("update_check", async () => {
      const [
        { checkForUpdatesDetailed, describeUpdateCheckFailure },
        { handleAutoUpdate },
        { getInstallationInfo },
        { updateEventEmitter },
        { t }
      ] = await Promise.all([
        import("./updateCheck-V5SKNDFE.js"),
        import("./handleAutoUpdate-WFHXYGWS.js"),
        import("./installationInfo-VY2CUV7O.js"),
        import("./updateEventEmitter-5MKC7BLQ.js"),
        import("./i18n-KF6BJU2F.js")
      ]);
      const updateCheckSkippedMessage = /* @__PURE__ */ __name((error) => t("Update check skipped ({{reason}}) \u2014 run /update to retry.", {
        reason: describeUpdateCheckFailure(error)
      }), "updateCheckSkippedMessage");
      try {
        const result = await checkForUpdatesDetailed();
        if (result.status === "update") {
          const projectRoot = config.getProjectRoot();
          const hostUpdateRelaunch = process.env[HOST_UPDATE_RELAUNCH_ENV_VAR];
          if (hostUpdateRelaunch === "true") {
            updateEventEmitter.emit("update-info", {
              message: `${result.info.message}
${t(
                "Run /update to install the update on the host."
              )}`
            });
            return;
          }
          if (hostUpdateRelaunch === "false") {
            updateEventEmitter.emit("update-info", {
              message: `${result.info.message}
${t(
                "Update Qwen Code on the host, then restart the sandbox."
              )}`
            });
            return;
          }
          const installationInfo = getInstallationInfo(projectRoot, true);
          if (installationInfo.packageManager === "npm") {
            void handleAutoUpdate(result.info, settings, projectRoot);
            return;
          }
          if (installationInfo.updateCommand || installationInfo.isStandalone && installationInfo.standaloneDir) {
            if (requestUpdateOnExit()) {
              updateEventEmitter.emit("update-info", {
                message: `${result.info.message}
${t(
                  "The update will be installed after you exit this session."
                )}`
              });
            } else {
              updateEventEmitter.emit("update-info", {
                message: `${result.info.message}
${t(
                  "Run /update to install the update."
                )}`
              });
            }
          } else {
            void handleAutoUpdate(result.info, settings, projectRoot);
          }
        } else if (result.status === "error") {
          updateEventEmitter.emit("update-failed", {
            message: updateCheckSkippedMessage(result.error),
            severity: "warning"
          });
        }
      } catch (error) {
        updateEventEmitter.emit("update-failed", {
          message: updateCheckSkippedMessage(error),
          severity: "warning"
        });
        throw error;
      }
    });
  }
  if (options.connectIde && config.getIdeMode()) {
    runDeferredTask("ide_connect", async () => {
      appEvents.emit("startup-ide-connection-status-changed" /* StartupIdeConnectionStatusChanged */, {
        state: "connecting"
      });
      try {
        const { connectIdeForStartup } = await import("./initializer-NLQKAA36.js");
        await withTimeout(
          connectIdeForStartup(config),
          "ide_connect",
          DEFERRED_IDE_CONNECT_TIMEOUT_MS,
          disconnectIdeAfterDeferredTimeout
        );
        appEvents.emit("startup-ide-connection-status-changed" /* StartupIdeConnectionStatusChanged */, {
          state: "connected"
        });
      } catch (err) {
        appEvents.emit("startup-ide-connection-status-changed" /* StartupIdeConnectionStatusChanged */, {
          state: "failed",
          message: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    });
  }
  if (options.initializeTelemetry) {
    runDeferredTask("telemetry_init", () => initializeTelemetry(config));
  }
  if (config.isInteractive()) {
    runDeferredTask("background_housekeeping", async () => {
      const { startBackgroundHousekeeping } = await import("./scheduler-NLRTUHGC.js");
      startBackgroundHousekeeping(config, settings);
    });
  }
}
__name(startPostRenderPrefetches, "startPostRenderPrefetches");

export {
  startEarlyStartupPrefetches,
  startPostRenderPrefetches
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
