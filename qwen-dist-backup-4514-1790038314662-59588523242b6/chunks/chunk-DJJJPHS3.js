// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_EXCLUDED_ENV_VARS,
  HOME_ENV_BOOTSTRAP_KEYS,
  PROJECT_ENV_HARDCODED_EXCLUSIONS,
  captureEnvironmentBeforeLoad,
  isHardcodedProjectEnvExclusion,
  isLoaderEnvKey,
  isPrivateProvenanceEnvKey,
  publishPendingCompileCache,
  reportRejectedLoaderKeys,
  resetEnvironmentSnapshotForTesting,
  resetLoaderKeyRejectionReportingForTesting
} from "./chunk-4VYTH6OF.js";
import {
  isWorkspaceTrusted
} from "./chunk-36RKQ7ZS.js";
import {
  require_main
} from "./chunk-65I7S4Z3.js";
import {
  QWEN_DIR,
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/environment.ts
init_esbuild_shims();
var dotenv = __toESM(require_main(), 1);
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
var SETTINGS_DIRECTORY_NAME = QWEN_DIR;
var RELOAD_EXCLUDED_KEYS = /* @__PURE__ */ new Set([
  ...PROJECT_ENV_HARDCODED_EXCLUSIONS,
  // The daemon auth token: the full loader never takes it from
  // settings.env, and a mid-session .env edit must not rotate it. (The
  // serve fast path consults only the hardcoded tier, so its documented
  // workspace-settings.env token feature is unaffected.)
  "QWEN_SERVER_TOKEN",
  // Loader-class keys are rejected by the isLoaderEnvKey guard before this
  // Set is consulted, so they are not spread here. These three keep their
  // pre-denylist reload-only exclusion: too compatibility-heavy for the
  // inherited-env scrub (mainstream toolchain/app conventions), but a
  // mid-session .env edit must still not apply them.
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "PATH",
  "HOME"
]);
var RELOAD_EXCLUDED_KEYS_CASEFOLDED = new Set(
  [...RELOAD_EXCLUDED_KEYS].map((key) => key.toLowerCase())
);
function isReloadExcludedKey(key) {
  return RELOAD_EXCLUDED_KEYS_CASEFOLDED.has(key.toLowerCase()) || // The hardcoded tier's pattern-matched keys (numbered
  // GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs) must freeze on reload
  // together with their literal sibling GIT_CONFIG_COUNT — one mechanism,
  // one gate. The literal hardcoded exclusions are already spread into
  // RELOAD_EXCLUDED_KEYS, so this adds exactly the pattern coverage.
  isHardcodedProjectEnvExclusion(key);
}
__name(isReloadExcludedKey, "isReloadExcludedKey");
var dotEnvSourcedKeys = /* @__PURE__ */ new Set();
var settingsEnvSourcedKeys = /* @__PURE__ */ new Set();
var lastReloadSnapshot = /* @__PURE__ */ new Map();
var lastReloadSnapshotSeeded = false;
function getUserLevelEnvPaths() {
  const homeDir = os.homedir();
  const globalQwenDir = Storage.getGlobalQwenDir();
  const paths = /* @__PURE__ */ new Set([
    path.normalize(path.join(homeDir, ".env")),
    path.normalize(path.join(globalQwenDir, ".env"))
  ]);
  const legacyQwenEnv = path.normalize(path.join(homeDir, QWEN_DIR, ".env"));
  paths.add(legacyQwenEnv);
  return paths;
}
__name(getUserLevelEnvPaths, "getUserLevelEnvPaths");
var homeEnvBootstrapped = false;
function preResolveHomeEnvOverrides() {
  if (homeEnvBootstrapped) {
    return;
  }
  homeEnvBootstrapped = true;
  if (HOME_ENV_BOOTSTRAP_KEYS.every((key) => process.env[key])) {
    return;
  }
  const initialQwenHome = process.env["QWEN_HOME"];
  const initialQwenDir = Storage.getGlobalQwenDir();
  const candidates = [path.join(initialQwenDir, ".env")];
  if (!initialQwenHome) {
    candidates.push(path.join(path.dirname(initialQwenDir), ".env"));
  }
  for (const candidate of candidates) {
    readHomeEnvInto(candidate);
  }
  const discoveredQwenHome = process.env["QWEN_HOME"];
  if (discoveredQwenHome && discoveredQwenHome !== initialQwenHome) {
    const discoveredDir = Storage.getGlobalQwenDir();
    if (discoveredDir !== initialQwenDir) {
      readHomeEnvInto(path.join(discoveredDir, ".env"));
    }
  }
}
__name(preResolveHomeEnvOverrides, "preResolveHomeEnvOverrides");
function readHomeEnvInto(file) {
  if (!fs.existsSync(file)) {
    return;
  }
  try {
    const parsed = dotenv.parse(fs.readFileSync(file, "utf-8"));
    for (const key of HOME_ENV_BOOTSTRAP_KEYS) {
      if (parsed[key] && !Object.hasOwn(process.env, key)) {
        process.env[key] = parsed[key];
      }
    }
  } catch (_e) {
  }
}
__name(readHomeEnvInto, "readHomeEnvInto");
function resetHomeEnvBootstrapForTesting() {
  homeEnvBootstrapped = false;
}
__name(resetHomeEnvBootstrapForTesting, "resetHomeEnvBootstrapForTesting");
function resetEnvironmentTrackingForTesting() {
  resetLoaderKeyRejectionReportingForTesting();
  resetEnvironmentSnapshotForTesting();
  dotEnvSourcedKeys.clear();
  settingsEnvSourcedKeys.clear();
  lastReloadSnapshot.clear();
  lastReloadSnapshotSeeded = false;
}
__name(resetEnvironmentTrackingForTesting, "resetEnvironmentTrackingForTesting");
function isFileSourcedEnvKey(key) {
  if (dotEnvSourcedKeys.has(key) || settingsEnvSourcedKeys.has(key)) {
    return true;
  }
  if (process.platform !== "win32") return false;
  const lower = key.toLowerCase();
  for (const tracked of dotEnvSourcedKeys) {
    if (tracked.toLowerCase() === lower) return true;
  }
  for (const tracked of settingsEnvSourcedKeys) {
    if (tracked.toLowerCase() === lower) return true;
  }
  return false;
}
__name(isFileSourcedEnvKey, "isFileSourcedEnvKey");
function getHomeEnvFallbackVars(onReadError) {
  const globalQwenDir = Storage.getGlobalQwenDir();
  const candidates = [path.join(globalQwenDir, ".env")];
  if (!process.env["QWEN_HOME"]) {
    candidates.push(path.join(path.dirname(globalQwenDir), ".env"));
  }
  const result = {};
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = dotenv.parse(fs.readFileSync(candidate, "utf-8"));
      for (const key in parsed) {
        if (Object.hasOwn(parsed, key) && !Object.hasOwn(process.env, key)) {
          result[key] ??= parsed[key];
        }
      }
    } catch (e) {
      onReadError?.(
        `Failed to read home .env candidate ${candidate}: ${getErrorMessage(e)}`
      );
    }
  }
  return result;
}
__name(getHomeEnvFallbackVars, "getHomeEnvFallbackVars");
function findEnvFiles(settings, startDir, userLevelPaths = getUserLevelEnvPaths(), workspaceTrusted) {
  const homeDir = os.homedir();
  let realStartDir = path.resolve(startDir);
  try {
    realStartDir = fs.realpathSync(realStartDir);
  } catch {
  }
  const globalQwenDir = Storage.getGlobalQwenDir();
  const legacyQwenDir = path.normalize(path.join(homeDir, QWEN_DIR));
  const hasCustomConfigDir = path.normalize(globalQwenDir) !== legacyQwenDir;
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  const canUseEnvFile = /* @__PURE__ */ __name((filePath) => {
    const normalized = path.normalize(filePath);
    if (userLevelPaths.has(normalized)) return true;
    const dirPath = path.dirname(normalized);
    const workspaceDir = path.basename(dirPath) === SETTINGS_DIRECTORY_NAME ? path.dirname(dirPath) : dirPath;
    const trusted = workspaceTrusted !== void 0 && workspaceDir === realStartDir ? workspaceTrusted : isWorkspaceTrusted(settings, void 0, workspaceDir).isTrusted;
    return trusted !== false;
  }, "canUseEnvFile");
  const pushCandidate = /* @__PURE__ */ __name((filePath) => {
    const normalized = path.normalize(filePath);
    if (!seen.has(normalized) && fs.existsSync(filePath) && canUseEnvFile(filePath)) {
      seen.add(normalized);
      found.push(filePath);
      return true;
    }
    return false;
  }, "pushCandidate");
  const pushHomeCandidates = /* @__PURE__ */ __name(() => {
    const candidates = [path.join(globalQwenDir, ".env")];
    if (hasCustomConfigDir) {
      candidates.push(path.join(legacyQwenDir, ".env"));
    }
    candidates.push(path.join(homeDir, ".env"));
    for (const candidate of candidates) {
      pushCandidate(candidate);
    }
  }, "pushHomeCandidates");
  if (path.resolve(startDir) === path.resolve(homeDir)) {
    pushHomeCandidates();
    return found;
  }
  let currentDir = realStartDir;
  let visitedHomeDir = false;
  while (true) {
    if (currentDir === homeDir) {
      visitedHomeDir = true;
      pushHomeCandidates();
      return found;
    } else {
      const geminiEnvPath = path.join(currentDir, QWEN_DIR, ".env");
      if (pushCandidate(geminiEnvPath)) {
        pushHomeCandidates();
        return found;
      }
      const envPath = path.join(currentDir, ".env");
      if (pushCandidate(envPath)) {
        pushHomeCandidates();
        return found;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      if (!visitedHomeDir) {
        pushHomeCandidates();
      }
      return found;
    }
    currentDir = parentDir;
  }
}
__name(findEnvFiles, "findEnvFiles");
function setUpCloudShellEnvironment(envFilePath) {
  if (envFilePath && fs.existsSync(envFilePath)) {
    const envFileContent = fs.readFileSync(envFilePath);
    const parsedEnv = dotenv.parse(envFileContent);
    if (parsedEnv["GOOGLE_CLOUD_PROJECT"]) {
      process.env["GOOGLE_CLOUD_PROJECT"] = parsedEnv["GOOGLE_CLOUD_PROJECT"];
    } else {
      process.env["GOOGLE_CLOUD_PROJECT"] = "cloudshell-gca";
    }
  } else {
    process.env["GOOGLE_CLOUD_PROJECT"] = "cloudshell-gca";
  }
}
__name(setUpCloudShellEnvironment, "setUpCloudShellEnvironment");
function setUpCloudShellEnvironmentInEnv(env, envFiles) {
  for (const envFile of envFiles) {
    if (envFile.parsedEnv["GOOGLE_CLOUD_PROJECT"]) {
      env["GOOGLE_CLOUD_PROJECT"] = envFile.parsedEnv["GOOGLE_CLOUD_PROJECT"];
      return;
    }
  }
  env["GOOGLE_CLOUD_PROJECT"] = "cloudshell-gca";
}
__name(setUpCloudShellEnvironmentInEnv, "setUpCloudShellEnvironmentInEnv");
function parseEnvFiles(envFilePaths, userLevelPaths) {
  const files = [];
  const readFailures = [];
  for (const envFilePath of envFilePaths) {
    try {
      const envFileContent = fs.readFileSync(envFilePath, "utf-8");
      const parsedEnv = dotenv.parse(envFileContent);
      const normalizedEnvFilePath = path.normalize(envFilePath);
      const isHomeScopedEnvFile = userLevelPaths.has(normalizedEnvFilePath);
      const isQwenScopedEnvFile = isHomeScopedEnvFile || path.basename(path.dirname(normalizedEnvFilePath)) === QWEN_DIR;
      files.push({
        path: envFilePath,
        parsedEnv,
        isHomeScopedEnvFile,
        isQwenScopedEnvFile
      });
    } catch (err) {
      readFailures.push({
        path: envFilePath,
        error: getErrorMessage(err)
      });
    }
  }
  return { files, readFailed: readFailures.length > 0, readFailures };
}
__name(parseEnvFiles, "parseEnvFiles");
function canApplyParsedEnvKey(envFile, key, excludedVars, options = {}) {
  if (!Object.hasOwn(envFile.parsedEnv, key)) return false;
  if (isLoaderEnvKey(key)) return false;
  if (isPrivateProvenanceEnvKey(key)) return false;
  if (options.reload && isReloadExcludedKey(key)) return false;
  if (!envFile.isHomeScopedEnvFile && isHardcodedProjectEnvExclusion(key)) {
    return false;
  }
  return envFile.isQwenScopedEnvFile || !excludedVars.includes(key);
}
__name(canApplyParsedEnvKey, "canApplyParsedEnvKey");
function isEffectivelyUnset(env, key) {
  const existingValue = env[key];
  return !Object.hasOwn(env, key) || existingValue === "";
}
__name(isEffectivelyUnset, "isEffectivelyUnset");
function setRuntimeEnvIfUnset(env, key, value) {
  if (isEffectivelyUnset(env, key)) {
    env[key] = value;
  }
}
__name(setRuntimeEnvIfUnset, "setRuntimeEnvIfUnset");
function buildRuntimeEnvironment(settings, startDir = process.cwd(), baseEnv = process.env, workspaceTrusted) {
  const userLevelPaths = getUserLevelEnvPaths();
  const envFilePaths = findEnvFiles(
    settings,
    startDir,
    userLevelPaths,
    workspaceTrusted
  );
  const parsedEnvFiles = parseEnvFiles(envFilePaths, userLevelPaths);
  const effectiveEnv = { ...baseEnv };
  if (baseEnv["CLOUD_SHELL"] === "true") {
    setUpCloudShellEnvironmentInEnv(effectiveEnv, parsedEnvFiles.files);
  }
  for (const envFile of parsedEnvFiles.files) {
    const excludedVars = settings?.advanced?.excludedEnvVars || DEFAULT_EXCLUDED_ENV_VARS;
    for (const key in envFile.parsedEnv) {
      if (!canApplyParsedEnvKey(envFile, key, excludedVars, { reload: true })) {
        continue;
      }
      setRuntimeEnvIfUnset(effectiveEnv, key, envFile.parsedEnv[key]);
    }
    reportRejectedLoaderKeys(
      `.env file ${envFile.path}`,
      Object.keys(envFile.parsedEnv)
    );
  }
  if (settings.env) {
    const excludedVars = settings?.advanced?.excludedEnvVars || DEFAULT_EXCLUDED_ENV_VARS;
    for (const [key, value] of Object.entries(settings.env)) {
      if (isLoaderEnvKey(key)) continue;
      if (isReloadExcludedKey(key)) continue;
      if (isHardcodedProjectEnvExclusion(key)) continue;
      if (excludedVars.includes(key)) continue;
      if (typeof value !== "string") continue;
      setRuntimeEnvIfUnset(effectiveEnv, key, value);
    }
    reportRejectedLoaderKeys(
      `settings.env (${startDir})`,
      Object.keys(settings.env)
    );
  }
  const overlayKeys = Object.keys(effectiveEnv).filter((key) => effectiveEnv[key] !== baseEnv[key]).sort();
  return {
    effectiveEnv: Object.freeze({ ...effectiveEnv }),
    overlayKeys: Object.freeze(overlayKeys),
    envFilePaths: Object.freeze([...envFilePaths]),
    envFileReadFailed: parsedEnvFiles.readFailed,
    envFileReadFailures: Object.freeze([...parsedEnvFiles.readFailures])
  };
}
__name(buildRuntimeEnvironment, "buildRuntimeEnvironment");
function loadEnvironment(settings, startDir = process.cwd()) {
  captureEnvironmentBeforeLoad();
  const userLevelPaths = getUserLevelEnvPaths();
  const envFilePaths = findEnvFiles(settings, startDir, userLevelPaths);
  const parsedEnvFiles = parseEnvFiles(envFilePaths, userLevelPaths);
  if (process.env["CLOUD_SHELL"] === "true") {
    setUpCloudShellEnvironmentInEnv(process.env, parsedEnvFiles.files);
  }
  for (const envFile of parsedEnvFiles.files) {
    const excludedVars = settings?.advanced?.excludedEnvVars || DEFAULT_EXCLUDED_ENV_VARS;
    for (const key in envFile.parsedEnv) {
      if (!canApplyParsedEnvKey(envFile, key, excludedVars)) continue;
      const existingValue = process.env[key];
      const isEffectivelyUnset2 = !Object.hasOwn(process.env, key) || existingValue === "";
      if (isEffectivelyUnset2) {
        process.env[key] = envFile.parsedEnv[key];
        dotEnvSourcedKeys.add(key);
      }
      if (!lastReloadSnapshotSeeded && !lastReloadSnapshot.has(key)) {
        lastReloadSnapshot.set(key, envFile.parsedEnv[key]);
      }
    }
    reportRejectedLoaderKeys(
      `.env file ${envFile.path}`,
      Object.keys(envFile.parsedEnv)
    );
  }
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (isLoaderEnvKey(key)) {
        continue;
      }
      if (isReloadExcludedKey(key)) {
        continue;
      }
      if (isHardcodedProjectEnvExclusion(key)) {
        continue;
      }
      const existingValue = process.env[key];
      const isEffectivelyUnset2 = !Object.hasOwn(process.env, key) || existingValue === "";
      if (isEffectivelyUnset2 && typeof value === "string") {
        process.env[key] = value;
        settingsEnvSourcedKeys.add(key);
      }
      if (!lastReloadSnapshotSeeded && typeof value === "string" && !lastReloadSnapshot.has(key)) {
        lastReloadSnapshot.set(key, value);
      }
    }
    reportRejectedLoaderKeys(
      `settings.env (${startDir})`,
      Object.keys(settings.env)
    );
  }
  lastReloadSnapshotSeeded = true;
  publishPendingCompileCache();
}
__name(loadEnvironment, "loadEnvironment");
function reloadEnvironment(settings, workspaceCwd, workspaceTrusted, options = {}) {
  const userLevelPaths = getUserLevelEnvPaths();
  const envFilePaths = findEnvFiles(
    settings,
    workspaceCwd,
    userLevelPaths,
    workspaceTrusted
  );
  const parsedEnvFiles = parseEnvFiles(envFilePaths, userLevelPaths);
  if (parsedEnvFiles.readFailed && options.failClosedOnEnvFileReadError) {
    return {
      updatedKeys: [],
      removedKeys: [],
      envFileReadFailed: true
    };
  }
  if (process.env["CLOUD_SHELL"] === "true") {
    setUpCloudShellEnvironmentInEnv(process.env, parsedEnvFiles.files);
  }
  const dotEnvReadFailed = parsedEnvFiles.readFailed;
  const newDotEnvKeys = /* @__PURE__ */ new Map();
  const newSettingsEnvKeys = /* @__PURE__ */ new Map();
  for (const envFile of parsedEnvFiles.files) {
    const excludedVars = settings?.advanced?.excludedEnvVars || DEFAULT_EXCLUDED_ENV_VARS;
    for (const key in envFile.parsedEnv) {
      if (!canApplyParsedEnvKey(envFile, key, excludedVars, { reload: true })) {
        continue;
      }
      if (!newDotEnvKeys.has(key)) {
        newDotEnvKeys.set(key, envFile.parsedEnv[key]);
      }
    }
    reportRejectedLoaderKeys(
      `.env file ${envFile.path}`,
      Object.keys(envFile.parsedEnv)
    );
  }
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (isLoaderEnvKey(key)) continue;
      if (isReloadExcludedKey(key)) continue;
      if (isHardcodedProjectEnvExclusion(key)) continue;
      if (typeof value !== "string") continue;
      const dotEnvValue = newDotEnvKeys.get(key);
      if (dotEnvValue !== void 0 && dotEnvValue !== "") continue;
      if (dotEnvReadFailed && lastReloadSnapshot.has(key)) continue;
      newSettingsEnvKeys.set(key, value);
    }
    reportRejectedLoaderKeys(
      `settings.env (${workspaceCwd})`,
      Object.keys(settings.env)
    );
  }
  const allNewKeys = /* @__PURE__ */ new Set([
    ...newDotEnvKeys.keys(),
    ...newSettingsEnvKeys.keys()
  ]);
  const updatedKeys = [];
  const removedKeys = [];
  if (!dotEnvReadFailed) {
    const previouslyKnown = /* @__PURE__ */ new Set([
      ...lastReloadSnapshot.keys(),
      ...dotEnvSourcedKeys,
      ...settingsEnvSourcedKeys
    ]);
    for (const key of previouslyKnown) {
      if (!allNewKeys.has(key) && !isReloadExcludedKey(key)) {
        delete process.env[key];
        removedKeys.push(key);
      }
    }
  }
  for (const [key, value] of newDotEnvKeys) {
    if (value === "" && newSettingsEnvKeys.has(key)) continue;
    if (process.env[key] !== value) {
      updatedKeys.push(key);
    }
    process.env[key] = value;
  }
  for (const [key, value] of newSettingsEnvKeys) {
    if (process.env[key] !== value) {
      updatedKeys.push(key);
    }
    process.env[key] = value;
  }
  if (!dotEnvReadFailed) {
    dotEnvSourcedKeys.clear();
    for (const key of newDotEnvKeys.keys()) {
      dotEnvSourcedKeys.add(key);
    }
    lastReloadSnapshot.clear();
    for (const [key, value] of newDotEnvKeys) {
      lastReloadSnapshot.set(key, value);
    }
    for (const [key, value] of newSettingsEnvKeys) {
      lastReloadSnapshot.set(key, value);
    }
  }
  settingsEnvSourcedKeys.clear();
  for (const key of newSettingsEnvKeys.keys()) {
    settingsEnvSourcedKeys.add(key);
  }
  return {
    updatedKeys,
    removedKeys,
    ...dotEnvReadFailed ? { envFileReadFailed: true } : {}
  };
}
__name(reloadEnvironment, "reloadEnvironment");

export {
  SETTINGS_DIRECTORY_NAME,
  preResolveHomeEnvOverrides,
  resetHomeEnvBootstrapForTesting,
  resetEnvironmentTrackingForTesting,
  isFileSourcedEnvKey,
  getHomeEnvFallbackVars,
  findEnvFiles,
  setUpCloudShellEnvironment,
  buildRuntimeEnvironment,
  loadEnvironment,
  reloadEnvironment
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
