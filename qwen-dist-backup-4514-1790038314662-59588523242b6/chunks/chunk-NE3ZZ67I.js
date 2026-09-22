// Force strict mode and setup for ESM
"use strict";
import {
  performStandaloneUpdate
} from "./chunk-2O4XE2EO.js";
import {
  updateEventEmitter
} from "./chunk-YAF2MQZ6.js";
import {
  require_semver
} from "./chunk-2AUM35J5.js";
import {
  getHomebrewLatestVersion,
  getInstallationInfo,
  resolveUpdateCommand
} from "./chunk-4JFRCIMW.js";
import {
  t
} from "./chunk-POMFSBEC.js";
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

// packages/cli/src/ui/handleAutoUpdate.ts
init_esbuild_shims();
var import_semver = __toESM(require_semver(), 1);

// packages/cli/src/utils/spawnWrapper.ts
init_esbuild_shims();
import { spawn } from "node:child_process";
var spawnWrapper = spawn;

// packages/cli/src/ui/handleAutoUpdate.ts
import os from "node:os";
var debugLogger = createDebugLogger("AUTO_UPDATE");
var UPDATE_SUCCESS_MESSAGE = "Update successful! The new version will be used on your next run.";
var UPDATE_FAILED_MESSAGE = "Automatic update failed. Please try updating manually.";
async function handleAutoUpdate(info, settings, projectRoot, spawnFn = spawnWrapper) {
  if (!info) {
    return;
  }
  const isAutoUpdateEnabled = settings.merged.general?.enableAutoUpdate !== false;
  const installationInfo = getInstallationInfo(
    projectRoot,
    isAutoUpdateEnabled
  );
  if (installationInfo.packageManager === "homebrew" /* HOMEBREW */) {
    const installedVersion = import_semver.default.coerce(info.update.current)?.version;
    const brewLatestVersion = import_semver.default.coerce(
      await getHomebrewLatestVersion() ?? void 0
    )?.version;
    if (installedVersion && brewLatestVersion && !import_semver.default.gt(brewLatestVersion, installedVersion)) {
      return;
    }
  }
  let combinedMessage = info.message;
  if (installationInfo.updateMessage) {
    combinedMessage += `
${t(installationInfo.updateMessage)}`;
  }
  updateEventEmitter.emit("update-received", {
    message: combinedMessage
  });
  if (installationInfo.isStandalone && installationInfo.standaloneDir && isAutoUpdateEnabled) {
    performStandaloneUpdate(installationInfo.standaloneDir, info.update.latest).then((result) => {
      const message = result === "deferred" ? t(
        "Update downloaded. It will be applied after you exit this session."
      ) : t(
        "Update successful! The new version will be used on your next run."
      );
      updateEventEmitter.emit("update-success", { message });
    }).catch((err) => {
      updateEventEmitter.emit("update-failed", {
        message: t(
          "Automatic update failed: {{error}}. Re-run the installer to update manually.",
          { error: err.message }
        )
      });
    });
    return;
  }
  if (!installationInfo.updateCommand || !isAutoUpdateEnabled) {
    return;
  }
  const updateCommand = resolveUpdateCommand(
    installationInfo.updateCommand,
    info.update.latest
  );
  const platform = os.platform();
  const isWindows = platform === "win32";
  const isManagedNpmUpdate = installationInfo.packageManager === "npm" /* NPM */;
  const command = isManagedNpmUpdate ? process.execPath : isWindows ? "cmd.exe" : "bash";
  const commandArgs = isManagedNpmUpdate ? [process.argv[1]] : isWindows ? ["/c", updateCommand] : ["-c", updateCommand];
  const updateProcess = spawnFn(command, commandArgs, {
    ...isManagedNpmUpdate ? {
      detached: true,
      env: {
        ...process.env,
        QWEN_CODE_MANAGED_NPM_UPDATE_VERSION: info.update.latest
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    } : { stdio: ["pipe", "ignore", "pipe"] }
  });
  let errorOutput = "";
  updateProcess.stderr?.on("data", (data) => {
    errorOutput += data.toString();
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = /* @__PURE__ */ __name((error) => {
      if (settled) return;
      settled = true;
      try {
        if (error) throw error;
        updateEventEmitter.emit("update-success", {
          message: t(UPDATE_SUCCESS_MESSAGE)
        });
        resolve(true);
      } catch (error2) {
        debugLogger.warn("Automatic update failed:", error2);
        updateEventEmitter.emit("update-failed", {
          message: t(UPDATE_FAILED_MESSAGE)
        });
        resolve(false);
      }
    }, "finish");
    updateProcess.once("close", (code) => {
      finish(
        code === 0 ? void 0 : new Error(
          `Command failed: ${updateCommand}; stderr: ${errorOutput.trim()}`
        )
      );
    });
    updateProcess.once("error", (error) => {
      finish(error);
    });
  });
}
__name(handleAutoUpdate, "handleAutoUpdate");
function setUpdateHandler(addItem, setUpdateInfo, isIdleRef = { current: true }) {
  let successfullyInstalled = false;
  const pendingNotifications = [];
  const addItemOrDefer = /* @__PURE__ */ __name((item) => {
    if (isIdleRef.current) {
      addItem(item, Date.now());
    } else {
      pendingNotifications.push(item);
    }
  }, "addItemOrDefer");
  const handleUpdateReceived = /* @__PURE__ */ __name((info) => {
    setUpdateInfo(info);
    const savedMessage = info.message;
    setTimeout(() => {
      if (!successfullyInstalled) {
        addItemOrDefer({
          type: "info" /* INFO */,
          text: savedMessage
        });
      }
      setUpdateInfo(null);
    }, 6e4);
  }, "handleUpdateReceived");
  const handleUpdateFailed = /* @__PURE__ */ __name((data) => {
    setUpdateInfo(null);
    addItemOrDefer({
      // Background update-check failures are emitted with severity 'warning'
      // (#7049); actual update installation failures stay errors.
      type: data?.severity === "warning" ? "warning" /* WARNING */ : "error" /* ERROR */,
      text: data?.message ?? t(UPDATE_FAILED_MESSAGE)
    });
  }, "handleUpdateFailed");
  const handleUpdateSuccess = /* @__PURE__ */ __name((data) => {
    successfullyInstalled = true;
    setUpdateInfo(null);
    addItemOrDefer({
      type: "info" /* INFO */,
      text: data?.message ?? t(UPDATE_SUCCESS_MESSAGE)
    });
  }, "handleUpdateSuccess");
  const handleUpdateInfo = /* @__PURE__ */ __name((data) => {
    addItemOrDefer({
      type: "info" /* INFO */,
      text: data.message
    });
  }, "handleUpdateInfo");
  updateEventEmitter.on("update-received", handleUpdateReceived);
  updateEventEmitter.on("update-failed", handleUpdateFailed);
  updateEventEmitter.on("update-success", handleUpdateSuccess);
  updateEventEmitter.on("update-info", handleUpdateInfo);
  const cleanup = /* @__PURE__ */ __name(() => {
    updateEventEmitter.off("update-received", handleUpdateReceived);
    updateEventEmitter.off("update-failed", handleUpdateFailed);
    updateEventEmitter.off("update-success", handleUpdateSuccess);
    updateEventEmitter.off("update-info", handleUpdateInfo);
    pendingNotifications.length = 0;
  }, "cleanup");
  const flush = /* @__PURE__ */ __name(() => {
    while (pendingNotifications.length > 0) {
      const item = pendingNotifications.shift();
      addItem(item, Date.now());
    }
  }, "flush");
  return { cleanup, flush };
}
__name(setUpdateHandler, "setUpdateHandler");

export {
  handleAutoUpdate,
  setUpdateHandler
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
