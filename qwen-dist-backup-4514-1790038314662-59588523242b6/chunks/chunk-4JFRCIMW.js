// Force strict mode and setup for ESM
"use strict";
import {
  isGitRepository
} from "./chunk-AUFTA63J.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/installationInfo.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
var PackageManager = /* @__PURE__ */ ((PackageManager2) => {
  PackageManager2["NPM"] = "npm";
  PackageManager2["YARN"] = "yarn";
  PackageManager2["PNPM"] = "pnpm";
  PackageManager2["PNPX"] = "pnpx";
  PackageManager2["BUN"] = "bun";
  PackageManager2["BUNX"] = "bunx";
  PackageManager2["HOMEBREW"] = "homebrew";
  PackageManager2["STANDALONE"] = "standalone";
  PackageManager2["NPX"] = "npx";
  PackageManager2["UNKNOWN"] = "unknown";
  return PackageManager2;
})(PackageManager || {});
function getNpmCliPath(nodePath = process.execPath, platform = process.platform) {
  if (platform === "win32") {
    return path.win32.join(
      path.win32.dirname(nodePath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    );
  }
  const npmCliJs = path.posix.join(
    path.posix.dirname(nodePath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  const adjacentNpm = path.posix.join(path.posix.dirname(nodePath), "npm");
  try {
    const resolved = fs.realpathSync(adjacentNpm);
    if (resolved.endsWith(".js")) return resolved;
    return npmCliJs;
  } catch {
    return npmCliJs;
  }
}
__name(getNpmCliPath, "getNpmCliPath");
var debugLogger = createDebugLogger("INSTALLATION_INFO");
var STANDALONE_UNIX_INSTALLER = "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh";
var STANDALONE_WINDOWS_INSTALLER = "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1";
function getStandaloneInstallerUrl() {
  return process.platform === "win32" ? STANDALONE_WINDOWS_INSTALLER : STANDALONE_UNIX_INSTALLER;
}
__name(getStandaloneInstallerUrl, "getStandaloneInstallerUrl");
function resolveUpdateCommand(updateCommand, latestVersion) {
  const isNightly = latestVersion.includes("nightly");
  return updateCommand.replace(
    "@latest",
    isNightly ? "@nightly" : `@${latestVersion}`
  );
}
__name(resolveUpdateCommand, "resolveUpdateCommand");
function formatUpdateInstructions(installationInfo, latestVersion) {
  const lines = [];
  if (installationInfo.updateMessage && !installationInfo.updateCommand) {
    lines.push(
      ...formatUpdateMessage(installationInfo.updateMessage, latestVersion)
    );
  }
  if (installationInfo.updateCommand) {
    const updateCmd = resolveUpdateCommand(
      installationInfo.updateCommand,
      latestVersion
    );
    lines.push("Run the following to update:", `  ${updateCmd}`);
  } else if (!installationInfo.updateMessage) {
    lines.push("Manual update required. Please reinstall Qwen Code.");
  }
  return lines;
}
__name(formatUpdateInstructions, "formatUpdateInstructions");
function formatUpdateMessage(updateMessage, latestVersion) {
  const message = resolveUpdateCommand(updateMessage, latestVersion);
  const sudoPrefix = "Update requires sudo. Please run: ";
  if (message.startsWith(sudoPrefix)) {
    return [
      "Update requires sudo. Please run:",
      `  ${message.slice(sudoPrefix.length)}`
    ];
  }
  return [message];
}
__name(formatUpdateMessage, "formatUpdateMessage");
var execFileAsync = promisify(childProcess.execFile);
var HOMEBREW_INFO_TIMEOUT_MS = 5e3;
async function getHomebrewLatestVersion(formula = "qwen-code", run = execFileAsync) {
  try {
    const { stdout } = await run(
      "brew",
      ["info", "--json=v2", "--formula", formula],
      { encoding: "utf8", timeout: HOMEBREW_INFO_TIMEOUT_MS }
    );
    const parsed = JSON.parse(String(stdout));
    const stable = parsed.formulae?.[0]?.versions?.stable;
    return typeof stable === "string" && stable.length > 0 ? stable : null;
  } catch (error) {
    debugLogger.warn("Failed to query Homebrew formula version:", error);
    return null;
  }
}
__name(getHomebrewLatestVersion, "getHomebrewLatestVersion");
function getInstallationInfo(projectRoot, isAutoUpdateEnabled) {
  const cliPath = process.argv[1];
  if (!cliPath) {
    return { packageManager: "unknown" /* UNKNOWN */, isGlobal: false };
  }
  try {
    const realPath = fs.realpathSync(cliPath).replace(/\\/g, "/");
    const normalizedProjectRoot = projectRoot?.replace(/\\/g, "/");
    const isGit = isGitRepository(process.cwd());
    if (isGit && normalizedProjectRoot && isSamePathOrInside(realPath, normalizedProjectRoot) && !realPath.includes("/node_modules/")) {
      return {
        packageManager: "unknown" /* UNKNOWN */,
        // Not managed by a package manager in this sense
        isGlobal: false,
        updateMessage: 'Running from a local git clone. Please update with "git pull".'
      };
    }
    if (realPath.includes("/.npm/_npx") || realPath.includes("/npm/_npx")) {
      return {
        packageManager: "npx" /* NPX */,
        isGlobal: false,
        updateMessage: "Running via npx, update not applicable."
      };
    }
    if (realPath.includes("/.pnpm/_pnpx")) {
      return {
        packageManager: "pnpx" /* PNPX */,
        isGlobal: false,
        updateMessage: "Running via pnpx, update not applicable."
      };
    }
    const standaloneInfo = getStandaloneInstallInfo(
      realPath,
      isAutoUpdateEnabled
    );
    if (standaloneInfo) {
      return standaloneInfo;
    }
    if (process.platform === "darwin") {
      try {
        childProcess.execSync('brew list -1 | grep -q "^qwen-code$"', {
          stdio: "ignore"
        });
        return {
          packageManager: "homebrew" /* HOMEBREW */,
          isGlobal: true,
          updateMessage: 'Installed via Homebrew. Please update with "brew upgrade".'
        };
      } catch (_error) {
      }
    }
    if (realPath.includes("/.pnpm/global")) {
      const updateCommand2 = "pnpm add -g @qwen-code/qwen-code@latest";
      return {
        packageManager: "pnpm" /* PNPM */,
        isGlobal: true,
        updateCommand: updateCommand2,
        updateMessage: isAutoUpdateEnabled ? "Installed with pnpm. Attempting to automatically update now..." : `Please run ${updateCommand2} to update`
      };
    }
    if (realPath.includes("/.yarn/global")) {
      const updateCommand2 = "yarn global add @qwen-code/qwen-code@latest";
      return {
        packageManager: "yarn" /* YARN */,
        isGlobal: true,
        updateCommand: updateCommand2,
        updateMessage: isAutoUpdateEnabled ? "Installed with yarn. Attempting to automatically update now..." : `Please run ${updateCommand2} to update`
      };
    }
    if (realPath.includes("/.bun/install/cache")) {
      return {
        packageManager: "bunx" /* BUNX */,
        isGlobal: false,
        updateMessage: "Running via bunx, update not applicable."
      };
    }
    if (realPath.includes("/.bun/bin")) {
      const updateCommand2 = "bun add -g @qwen-code/qwen-code@latest";
      return {
        packageManager: "bun" /* BUN */,
        isGlobal: true,
        updateCommand: updateCommand2,
        updateMessage: isAutoUpdateEnabled ? "Installed with bun. Attempting to automatically update now..." : `Please run ${updateCommand2} to update`
      };
    }
    if (normalizedProjectRoot && isSamePathOrInside(realPath, `${normalizedProjectRoot}/node_modules`)) {
      let pm = "npm" /* NPM */;
      if (fs.existsSync(path.join(projectRoot, "yarn.lock"))) {
        pm = "yarn" /* YARN */;
      } else if (fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) {
        pm = "pnpm" /* PNPM */;
      } else if (fs.existsSync(path.join(projectRoot, "bun.lockb"))) {
        pm = "bun" /* BUN */;
      }
      return {
        packageManager: pm,
        isGlobal: false,
        updateMessage: "Locally installed. Please update via your project's package.json."
      };
    }
    const npmPackageDir = path.dirname(path.dirname(realPath));
    let npmPrefixWritable = false;
    try {
      fs.accessSync(npmPackageDir, fs.constants.W_OK);
      npmPrefixWritable = true;
    } catch {
    }
    if (!npmPrefixWritable) {
      return {
        packageManager: "npm" /* NPM */,
        isGlobal: true,
        updateMessage: "Update requires sudo. Please run: sudo npm install -g @qwen-code/qwen-code@latest"
      };
    }
    const updateCommand = "npm install -g @qwen-code/qwen-code@latest";
    return {
      packageManager: "npm" /* NPM */,
      isGlobal: true,
      updateCommand,
      updateMessage: isAutoUpdateEnabled ? "Installed with npm. Attempting to automatically update now..." : `Please run ${updateCommand} to update`
    };
  } catch (error) {
    debugLogger.error("Failed to detect installation info:", error);
    return { packageManager: "unknown" /* UNKNOWN */, isGlobal: false };
  }
}
__name(getInstallationInfo, "getInstallationInfo");
function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "") || "/";
}
__name(stripTrailingSlashes, "stripTrailingSlashes");
function isSamePathOrInside(candidate, parent) {
  const normalizedCandidate = stripTrailingSlashes(candidate);
  const normalizedParent = stripTrailingSlashes(parent);
  if (normalizedParent === "/") {
    return normalizedCandidate === "/" || normalizedCandidate.startsWith("/");
  }
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}
__name(isSamePathOrInside, "isSamePathOrInside");
function getStandaloneInstallInfo(realPath, isAutoUpdateEnabled) {
  const installDir = standaloneInstallDirForCliPath(realPath);
  if (!installDir || !isStandaloneInstallDir(installDir)) {
    return null;
  }
  const installerUrl = getStandaloneInstallerUrl();
  const updateCommand = process.platform === "win32" ? `powershell -ExecutionPolicy Bypass -c "irm ${installerUrl} | iex"` : `curl -fsSL ${installerUrl} | bash`;
  return {
    packageManager: "standalone" /* STANDALONE */,
    isGlobal: true,
    isStandalone: true,
    standaloneDir: installDir,
    updateMessage: isAutoUpdateEnabled ? "Standalone install detected. Attempting to automatically update now..." : `Standalone install detected. Please rerun the standalone installer to update: ${updateCommand}`
  };
}
__name(getStandaloneInstallInfo, "getStandaloneInstallInfo");
function standaloneInstallDirForCliPath(realPath) {
  const normalized = realPath.replace(/\\/g, "/");
  const suffix = "/lib/cli.js";
  if (!normalized.endsWith(suffix)) {
    return null;
  }
  return realPath.slice(0, -suffix.length);
}
__name(standaloneInstallDirForCliPath, "standaloneInstallDirForCliPath");
function isStandaloneInstallDir(installDir) {
  try {
    const manifestPath = path.join(installDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return false;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.name !== "@qwen-code/qwen-code" || typeof manifest.target !== "string" || !isStandaloneTargetForCurrentPlatform(manifest.target)) {
      return false;
    }
    const qwenBin = process.platform === "win32" ? path.join(installDir, "bin", "qwen.cmd") : path.join(installDir, "bin", "qwen");
    const nodeBin = process.platform === "win32" ? path.join(installDir, "node", "node.exe") : path.join(installDir, "node", "bin", "node");
    return fs.existsSync(qwenBin) && fs.existsSync(nodeBin) && isStandaloneRuntimeFile(qwenBin) && isStandaloneRuntimeFile(nodeBin);
  } catch (err) {
    debugLogger.error("Standalone detection failed:", installDir, err);
    return false;
  }
}
__name(isStandaloneInstallDir, "isStandaloneInstallDir");
function isStandaloneTargetForCurrentPlatform(target) {
  switch (process.platform) {
    case "darwin":
      return /^darwin-(arm64|x64)$/.test(target);
    case "linux":
      return /^linux-(arm64|x64)$/.test(target);
    case "win32":
      return /^win-(arm64|x64)$/.test(target);
    default:
      return false;
  }
}
__name(isStandaloneTargetForCurrentPlatform, "isStandaloneTargetForCurrentPlatform");
function isStandaloneRuntimeFile(filePath) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return false;
  }
  return process.platform === "win32" || (stats.mode & 73) !== 0;
}
__name(isStandaloneRuntimeFile, "isStandaloneRuntimeFile");

export {
  PackageManager,
  getNpmCliPath,
  resolveUpdateCommand,
  formatUpdateInstructions,
  getHomebrewLatestVersion,
  getInstallationInfo
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
