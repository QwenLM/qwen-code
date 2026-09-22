// Force strict mode and setup for ESM
"use strict";
import {
  GIT_COMMIT_INFO
} from "./chunk-PRMLXEQQ.js";
import {
  getCliVersion
} from "./chunk-GY7FOHQP.js";
import {
  IdeClient
} from "./chunk-MRTRBONQ.js";
import {
  formatMemoryUsage
} from "./chunk-CHEIIBT3.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/systemInfo.ts
init_esbuild_shims();
import process from "node:process";
import os from "node:os";
import { execFile } from "node:child_process";
var debugLogger = createDebugLogger("STATUS");
var VERSION_PROBE_TIMEOUT_MS = 5e3;
function probeVersion(binary) {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--version"],
      { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: "utf-8" },
      (err, stdout) => {
        if (err) {
          resolve("unknown");
          return;
        }
        resolve(typeof stdout === "string" ? stdout.trim() : "unknown");
      }
    );
  });
}
__name(probeVersion, "probeVersion");
async function getNpmVersion() {
  return probeVersion("npm");
}
__name(getNpmVersion, "getNpmVersion");
async function getGitVersion() {
  return probeVersion("git");
}
__name(getGitVersion, "getGitVersion");
async function getIdeClientName(context) {
  if (!context.services.config?.getIdeMode()) {
    return "";
  }
  try {
    const ideClient = await IdeClient.getInstance();
    return ideClient?.getDetectedIdeDisplayName() ?? "";
  } catch {
    return "";
  }
}
__name(getIdeClientName, "getIdeClientName");
function getSandboxEnv(stripPrefix = false) {
  const sandbox = process.env["SANDBOX"];
  if (!sandbox || sandbox === "sandbox-exec") {
    if (sandbox === "sandbox-exec") {
      const profile = process.env["SEATBELT_PROFILE"] || "unknown";
      return `sandbox-exec (${profile})`;
    }
    return "no sandbox";
  }
  if (stripPrefix) {
    return sandbox.replace(/^qwen-(?:code-)?/, "");
  }
  return sandbox;
}
__name(getSandboxEnv, "getSandboxEnv");
async function getSystemInfo(context) {
  const osPlatform = process.platform;
  const osArch = process.arch;
  const osRelease = os.release();
  const nodeVersion = process.version;
  const npmVersion = await getNpmVersion();
  const sandboxEnv = getSandboxEnv();
  const modelVersion = context.services.config?.getModel() || "Unknown";
  const cliVersion = await getCliVersion();
  const selectedAuthType = context.services.config?.getAuthType() || "";
  const ideClient = await getIdeClientName(context);
  const sessionId = context.services.config?.getSessionId() || "unknown";
  const proxy = context.services.config?.getProxy();
  return {
    cliVersion,
    osPlatform,
    osArch,
    osRelease,
    nodeVersion,
    npmVersion,
    sandboxEnv,
    modelVersion,
    selectedAuthType,
    ideClient,
    sessionId,
    proxy
  };
}
__name(getSystemInfo, "getSystemInfo");
async function getExtendedSystemInfo(context) {
  const baseInfo = await getSystemInfo(context);
  const memoryUsage = formatMemoryUsage(process.memoryUsage().rss);
  const sandboxEnv = getSandboxEnv(true);
  const contentGeneratorConfig = baseInfo.selectedAuthType === "openai" /* USE_OPENAI */ || baseInfo.selectedAuthType === "openai-responses" /* USE_OPENAI_RESPONSES */ || baseInfo.selectedAuthType === "anthropic" /* USE_ANTHROPIC */ ? context.services.config?.getContentGeneratorConfig() : void 0;
  const baseUrl = contentGeneratorConfig?.baseUrl;
  const apiKeyEnvKey = contentGeneratorConfig?.apiKeyEnvKey;
  const gitCommit = GIT_COMMIT_INFO && !["N/A"].includes(GIT_COMMIT_INFO) ? GIT_COMMIT_INFO : void 0;
  const fastModel = context.services.settings?.merged?.fastModel || void 0;
  const lspStatus = getLspStatus(context);
  return {
    ...baseInfo,
    sandboxEnv,
    memoryUsage,
    baseUrl,
    apiKeyEnvKey,
    gitCommit,
    fastModel,
    lspStatus
  };
}
__name(getExtendedSystemInfo, "getExtendedSystemInfo");
function getLspStatus(context) {
  try {
    const snapshot = context.services.config?.getLspStatusSnapshot?.();
    if (!snapshot) {
      return void 0;
    }
    if (context.services.config?.getDebugMode?.()) {
      debugLogger.debug("LSP status snapshot for /status:", snapshot);
    }
    return formatLspStatusSnapshot(snapshot);
  } catch (error) {
    if (context.services.config?.getDebugMode?.()) {
      debugLogger.debug(
        "Unable to read LSP status snapshot for /status:",
        error
      );
    }
    return void 0;
  }
}
__name(getLspStatus, "getLspStatus");
function formatLspStatusSnapshot(snapshot) {
  if (!snapshot.enabled) {
    return "disabled";
  }
  if (snapshot.initializationError) {
    return `enabled, initialization failed: ${snapshot.initializationError}`;
  }
  if (snapshot.statusUnavailable) {
    return "enabled, status unavailable";
  }
  if (snapshot.configuredServers === 0) {
    return "enabled, no servers configured";
  }
  const details = [
    snapshot.failedServers > 0 ? `${snapshot.failedServers} failed` : "",
    snapshot.inProgressServers > 0 ? `${snapshot.inProgressServers} starting` : "",
    snapshot.notStartedServers > 0 ? `${snapshot.notStartedServers} not started` : ""
  ].filter(Boolean);
  const detailText = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `enabled, ${snapshot.readyServers}/${snapshot.configuredServers} ready${detailText}`;
}
__name(formatLspStatusSnapshot, "formatLspStatusSnapshot");

export {
  getNpmVersion,
  getGitVersion,
  getExtendedSystemInfo
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
