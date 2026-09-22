// Force strict mode and setup for ESM
"use strict";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/update-relaunch.ts
init_esbuild_shims();
var UPDATE_CHECK_FAILED_MESSAGE = "Failed to check for updates ({{reason}}). Please check your network or registry configuration.";
var UPDATE_FAILED_MESSAGE = "Automatic update failed. Please try updating manually.";
async function updateBeforeRelaunch(settings, projectRoot, relaunchOnFailure) {
  let translate = /* @__PURE__ */ __name((message) => message, "translate");
  try {
    const [
      { checkForUpdatesDetailed, describeUpdateCheckFailure },
      { handleAutoUpdate },
      { getInstallationInfo },
      { performStandaloneUpdate },
      { t }
    ] = await Promise.all([
      import("./updateCheck-V5SKNDFE.js"),
      import("./handleAutoUpdate-WFHXYGWS.js"),
      import("./installationInfo-VY2CUV7O.js"),
      import("./standalone-update-7DJX56A6.js"),
      import("./i18n-KF6BJU2F.js")
    ]);
    translate = t;
    const result = await checkForUpdatesDetailed();
    if (result.status === "update") {
      writeStderrLine(result.info.message);
      const installationInfo = getInstallationInfo(projectRoot, true);
      if (installationInfo.isStandalone && installationInfo.standaloneDir) {
        const standaloneResult = await performStandaloneUpdate(
          installationInfo.standaloneDir,
          result.info.update.latest
        );
        writeStderrLine(
          t(
            standaloneResult === "deferred" ? "Update downloaded. It will be applied after you exit this session." : "Update successful! The new version will be used on your next run."
          )
        );
        return standaloneResult !== "deferred";
      }
      if (!installationInfo.updateCommand) {
        writeStderrLine(
          installationInfo.updateMessage ?? t("Manual update required. Please reinstall Qwen Code.")
        );
        return relaunchOnFailure;
      }
      const success = await handleAutoUpdate(
        result.info,
        settings,
        projectRoot
      );
      writeStderrLine(
        t(
          success ? "Update successful! The new version will be used on your next run." : UPDATE_FAILED_MESSAGE
        )
      );
      return success || relaunchOnFailure;
    } else if (result.status === "error") {
      writeStderrLine(
        t(UPDATE_CHECK_FAILED_MESSAGE, {
          reason: describeUpdateCheckFailure(result.error)
        })
      );
    }
  } catch {
    writeStderrLine(translate(UPDATE_FAILED_MESSAGE));
  }
  return relaunchOnFailure;
}
__name(updateBeforeRelaunch, "updateBeforeRelaunch");
export {
  updateBeforeRelaunch
};
/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
