// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/storage-paths-lite.ts
init_esbuild_shims();
import * as os from "node:os";
import * as path from "node:path";
var SETTINGS_DIRECTORY_NAME = ".qwen";
function resolveConfigPathLite(dir, cwd) {
  let resolved = dir;
  if (resolved === "~" || resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    const relativeSegments = resolved === "~" ? [] : resolved.slice(2).split(/[/\\]+/).filter(Boolean);
    resolved = path.join(os.homedir(), ...relativeSegments);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(cwd || process.cwd(), resolved);
  }
  return resolved;
}
__name(resolveConfigPathLite, "resolveConfigPathLite");
function getGlobalQwenDirLite() {
  const envDir = process.env["QWEN_HOME"];
  if (envDir) {
    return resolveConfigPathLite(envDir);
  }
  const homeDir = os.homedir();
  if (!homeDir) {
    return path.join(os.tmpdir(), SETTINGS_DIRECTORY_NAME);
  }
  return path.join(homeDir, SETTINGS_DIRECTORY_NAME);
}
__name(getGlobalQwenDirLite, "getGlobalQwenDirLite");
function getSystemSettingsPath() {
  if (process.env["QWEN_CODE_SYSTEM_SETTINGS_PATH"]) {
    return process.env["QWEN_CODE_SYSTEM_SETTINGS_PATH"];
  }
  if (os.platform() === "darwin") {
    return "/Library/Application Support/QwenCode/settings.json";
  }
  if (os.platform() === "win32") {
    return "C:\\ProgramData\\qwen-code\\settings.json";
  }
  return "/etc/qwen-code/settings.json";
}
__name(getSystemSettingsPath, "getSystemSettingsPath");
function getSystemDefaultsPath() {
  if (process.env["QWEN_CODE_SYSTEM_DEFAULTS_PATH"]) {
    return process.env["QWEN_CODE_SYSTEM_DEFAULTS_PATH"];
  }
  return path.join(
    path.dirname(getSystemSettingsPath()),
    "system-defaults.json"
  );
}
__name(getSystemDefaultsPath, "getSystemDefaultsPath");

export {
  SETTINGS_DIRECTORY_NAME,
  resolveConfigPathLite,
  getGlobalQwenDirLite,
  getSystemSettingsPath,
  getSystemDefaultsPath
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
