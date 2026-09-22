// Force strict mode and setup for ESM
"use strict";
import {
  require_semver
} from "./chunk-2AUM35J5.js";
import {
  getNpmCliPath
} from "./chunk-4JFRCIMW.js";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  getPackageJson
} from "./chunk-W3N5XAZ6.js";
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

// packages/cli/src/ui/utils/updateCheck.ts
init_esbuild_shims();
var import_semver = __toESM(require_semver(), 1);
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var debugLogger = createDebugLogger("UPDATE_CHECK");
var FETCH_TIMEOUT_MS = 5e3;
var UpdateCheckTimeoutError = class extends Error {
  static {
    __name(this, "UpdateCheckTimeoutError");
  }
  distTag;
  constructor(timeoutMs, distTag) {
    const suffix = distTag ? ` for ${distTag}` : "";
    super(`update check timed out after ${timeoutMs}ms${suffix}`);
    this.name = "UpdateCheckTimeoutError";
    this.distTag = distTag;
  }
};
var NETWORK_ERROR_CODES = [
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETUNREACH"
];
function classifyUpdateCheckError(error) {
  if (error instanceof UpdateCheckTimeoutError) return "timeout";
  if (error instanceof Error) {
    if ("killed" in error && error.killed === true && "signal" in error && error.signal === "SIGTERM") {
      return "timeout";
    }
    const errors = [error];
    if (error.cause instanceof Error) errors.push(error.cause);
    const matchesCode = /* @__PURE__ */ __name((code) => errors.some(
      (error2) => error2.code === code || error2.message.includes(code)
    ), "matchesCode");
    if (NETWORK_ERROR_CODES.some(matchesCode)) return "offline";
  }
  return "registry";
}
__name(classifyUpdateCheckError, "classifyUpdateCheckError");
function describeUpdateCheckFailure(error, timeoutMs = FETCH_TIMEOUT_MS) {
  switch (classifyUpdateCheckError(error)) {
    case "timeout":
      return t("registry did not respond within {{seconds}}s", {
        seconds: String(Math.round(timeoutMs / 1e3))
      });
    case "offline":
      return t("registry unreachable");
    default:
      return t("registry error");
  }
}
__name(describeUpdateCheckFailure, "describeUpdateCheckFailure");
async function fetchInfoWithTimeout(notifier, timeoutMs, distTag) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(notifier.fetchInfo()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new UpdateCheckTimeoutError(timeoutMs, distTag)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
__name(fetchInfoWithTimeout, "fetchInfoWithTimeout");
var execFileAsync = promisify(execFile);
async function runGlobalNpm(args, run = execFileAsync, platform = process.platform, nodePath = process.execPath, resolveNpmCliPath = getNpmCliPath) {
  const { stdout } = await run(
    nodePath,
    [resolveNpmCliPath(nodePath, platform), ...args],
    {
      encoding: "utf8",
      timeout: FETCH_TIMEOUT_MS
    }
  );
  return String(stdout).trim();
}
__name(runGlobalNpm, "runGlobalNpm");
async function fetchGlobalNpmUpdateInfo(packageName, currentVersion, distTag, run = execFileAsync) {
  const output = await runGlobalNpm(
    ["view", packageName, `dist-tags.${distTag}`, "--json", "--global"],
    run
  );
  if (output === "") {
    return {
      latest: currentVersion,
      current: currentVersion,
      type: "latest",
      name: packageName
    };
  }
  const parsed = JSON.parse(output);
  const latest = typeof parsed === "string" ? parsed : Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string" ? parsed[0] : void 0;
  if (latest === void 0) {
    throw new Error(`Invalid npm ${distTag} version response`);
  }
  return {
    latest,
    current: currentVersion,
    type: "latest",
    name: packageName
  };
}
__name(fetchGlobalNpmUpdateInfo, "fetchGlobalNpmUpdateInfo");
function getBestAvailableUpdate(nightly, stable) {
  if (!nightly) return stable || null;
  if (!stable) return nightly || null;
  const nightlyVer = nightly.latest;
  const stableVer = stable.latest;
  if (import_semver.default.coerce(stableVer)?.version === import_semver.default.coerce(nightlyVer)?.version) {
    return nightly;
  }
  return import_semver.default.gt(stableVer, nightlyVer) ? stable : nightly;
}
__name(getBestAvailableUpdate, "getBestAvailableUpdate");
async function checkForUpdatesDetailed(fetchGlobalNpm = fetchGlobalNpmUpdateInfo) {
  let currentVersion;
  try {
    if (process.env["DEV"] === "true") {
      return { status: "skipped", reason: "development mode" };
    }
    const packageJson = await getPackageJson();
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return { status: "skipped", reason: "package metadata unavailable" };
    }
    const { name, version } = packageJson;
    currentVersion = version;
    const isNightly = version.includes("nightly");
    const createNotifier = /* @__PURE__ */ __name((distTag) => ({
      fetchInfo: /* @__PURE__ */ __name(() => fetchGlobalNpm(name, version, distTag), "fetchInfo")
    }), "createNotifier");
    if (isNightly) {
      const [nightlyUpdateInfo, latestUpdateInfo] = await Promise.all([
        fetchInfoWithTimeout(
          createNotifier("nightly"),
          FETCH_TIMEOUT_MS,
          "nightly"
        ),
        fetchInfoWithTimeout(
          createNotifier("latest"),
          FETCH_TIMEOUT_MS,
          "latest"
        )
      ]);
      debugLogger.debug(
        `fetchInfo returned nightly=${JSON.stringify(nightlyUpdateInfo)} latest=${JSON.stringify(latestUpdateInfo)} for current=${version}`
      );
      const bestUpdate = getBestAvailableUpdate(
        nightlyUpdateInfo,
        latestUpdateInfo
      );
      if (bestUpdate && import_semver.default.gt(bestUpdate.latest, version)) {
        return {
          status: "update",
          info: {
            message: t(
              "A new version of Qwen Code is available! {{current}} \u2192 {{latest}}",
              { current: version, latest: bestUpdate.latest }
            ),
            update: { ...bestUpdate, current: version }
          }
        };
      }
    } else {
      const updateInfo = await fetchInfoWithTimeout(
        createNotifier("latest"),
        FETCH_TIMEOUT_MS,
        "latest"
      );
      debugLogger.debug(
        `fetchInfo returned ${JSON.stringify(updateInfo)} for current=${version}`
      );
      if (updateInfo && import_semver.default.gt(updateInfo.latest, version)) {
        return {
          status: "update",
          info: {
            message: t("Qwen Code update available! {{current}} \u2192 {{latest}}", {
              current: version,
              latest: updateInfo.latest
            }),
            update: { ...updateInfo, current: version }
          }
        };
      }
    }
    return { status: "up-to-date", currentVersion: version };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    debugLogger.warn("Failed to check for updates: " + error);
    return { status: "error", error, currentVersion };
  }
}
__name(checkForUpdatesDetailed, "checkForUpdatesDetailed");
async function checkForUpdates(fetchGlobalNpm = fetchGlobalNpmUpdateInfo) {
  const result = await checkForUpdatesDetailed(fetchGlobalNpm);
  return result.status === "update" ? result.info : null;
}
__name(checkForUpdates, "checkForUpdates");

export {
  FETCH_TIMEOUT_MS,
  UpdateCheckTimeoutError,
  classifyUpdateCheckError,
  describeUpdateCheckFailure,
  runGlobalNpm,
  fetchGlobalNpmUpdateInfo,
  checkForUpdatesDetailed,
  checkForUpdates
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
