// Force strict mode and setup for ESM
"use strict";
import {
  V1_INDICATOR_KEYS
} from "./chunk-BW4333PP.js";
import {
  SETTINGS_DIRECTORY_NAME,
  getGlobalQwenDirLite,
  getSystemDefaultsPath,
  getSystemSettingsPath
} from "./chunk-IDS7MSUP.js";
import {
  DEFAULT_EXCLUDED_ENV_VARS,
  HOME_ENV_BOOTSTRAP_KEYS,
  captureEnvironmentBeforeLoad,
  isHardcodedProjectEnvExclusion,
  isLoaderEnvKey,
  isPrivateProvenanceEnvKey,
  publishPendingCompileCache,
  reportRejectedLoaderKeys
} from "./chunk-4VYTH6OF.js";
import {
  buildTrustPrecedenceRules,
  require_strip_json_comments,
  resolveTrustDecision
} from "./chunk-NPQ5ZKRP.js";
import {
  getPathComparisonVariants
} from "./chunk-MR3PXB6E.js";
import {
  require_main,
  resolveEnvVarsInObject
} from "./chunk-65I7S4Z3.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/fast-path-settings.ts
init_esbuild_shims();
var dotenv = __toESM(require_main(), 1);
var import_strip_json_comments = __toESM(require_strip_json_comments(), 1);
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
var V2_SETTINGS_VERSION = 2;
var homeEnvBootstrapped = false;
var cachedTrustedFoldersPath;
var cachedTrustedFolderRules;
function getTrustedFoldersPathFastPath() {
  return process.env["QWEN_CODE_TRUSTED_FOLDERS_PATH"] ?? path.join(getGlobalQwenDirLite(), "trustedFolders.json");
}
__name(getTrustedFoldersPathFastPath, "getTrustedFoldersPathFastPath");
function getUserLevelEnvPathsFastPath() {
  const homeDir = os.homedir();
  const globalQwenDir = getGlobalQwenDirLite();
  return /* @__PURE__ */ new Set([
    path.normalize(path.join(homeDir, ".env")),
    path.normalize(path.join(globalQwenDir, ".env")),
    path.normalize(path.join(homeDir, SETTINGS_DIRECTORY_NAME, ".env"))
  ]);
}
__name(getUserLevelEnvPathsFastPath, "getUserLevelEnvPathsFastPath");
function preResolveServeFastPathHomeEnvOverrides() {
  if (homeEnvBootstrapped) return;
  homeEnvBootstrapped = true;
  if (HOME_ENV_BOOTSTRAP_KEYS.every((key) => process.env[key])) {
    return;
  }
  const initialQwenHome = process.env["QWEN_HOME"];
  const initialQwenDir = getGlobalQwenDirLite();
  readHomeEnvIntoFastPath(path.join(initialQwenDir, ".env"));
  if (!initialQwenHome) {
    readHomeEnvIntoFastPath(path.join(path.dirname(initialQwenDir), ".env"));
  }
  const discoveredQwenHome = process.env["QWEN_HOME"];
  if (discoveredQwenHome && discoveredQwenHome !== initialQwenHome) {
    const discoveredDir = getGlobalQwenDirLite();
    if (discoveredDir !== initialQwenDir) {
      readHomeEnvIntoFastPath(path.join(discoveredDir, ".env"));
    }
  }
}
__name(preResolveServeFastPathHomeEnvOverrides, "preResolveServeFastPathHomeEnvOverrides");
function readHomeEnvIntoFastPath(file) {
  if (!fs.existsSync(file)) return;
  try {
    const parsed = dotenv.parse(fs.readFileSync(file, "utf8"));
    for (const key of HOME_ENV_BOOTSTRAP_KEYS) {
      if (parsed[key] && !Object.hasOwn(process.env, key)) {
        process.env[key] = parsed[key];
      }
    }
  } catch {
  }
}
__name(readHomeEnvIntoFastPath, "readHomeEnvIntoFastPath");
function resetServeFastPathHomeEnvBootstrapForTesting() {
  homeEnvBootstrapped = false;
  cachedTrustedFoldersPath = void 0;
  cachedTrustedFolderRules = void 0;
}
__name(resetServeFastPathHomeEnvBootstrapForTesting, "resetServeFastPathHomeEnvBootstrapForTesting");
function getHomeEnvFallbackVarsFastPath() {
  const globalQwenDir = getGlobalQwenDirLite();
  const candidates = [path.join(globalQwenDir, ".env")];
  if (!process.env["QWEN_HOME"]) {
    candidates.push(path.join(path.dirname(globalQwenDir), ".env"));
  }
  const result = {};
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = dotenv.parse(fs.readFileSync(candidate, "utf8"));
      for (const key in parsed) {
        if (Object.hasOwn(parsed, key) && !Object.hasOwn(process.env, key)) {
          result[key] ??= parsed[key];
        }
      }
    } catch {
    }
  }
  return result;
}
__name(getHomeEnvFallbackVarsFastPath, "getHomeEnvFallbackVarsFastPath");
function findEnvFilesFastPath(settings, startDir, userLevelPaths = getUserLevelEnvPathsFastPath()) {
  const homeDir = os.homedir();
  let realStartDir = path.resolve(startDir);
  try {
    realStartDir = fs.realpathSync(realStartDir);
  } catch {
  }
  const globalQwenDir = getGlobalQwenDirLite();
  const legacyQwenDir = path.normalize(
    path.join(homeDir, SETTINGS_DIRECTORY_NAME)
  );
  const hasCustomConfigDir = path.normalize(globalQwenDir) !== legacyQwenDir;
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  const canUseEnvFile = /* @__PURE__ */ __name((filePath) => {
    const normalized = path.normalize(filePath);
    if (userLevelPaths.has(normalized)) return true;
    const dirPath = path.dirname(normalized);
    const workspaceDir = path.basename(dirPath) === SETTINGS_DIRECTORY_NAME ? path.dirname(dirPath) : dirPath;
    return isWorkspaceTrustedFastPath(settings, workspaceDir) !== false;
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
  let currentDir = realStartDir;
  let visitedHomeDir = false;
  while (true) {
    if (currentDir === homeDir) {
      visitedHomeDir = true;
      pushHomeCandidates();
      return found;
    } else {
      const qwenEnvPath = path.join(
        currentDir,
        SETTINGS_DIRECTORY_NAME,
        ".env"
      );
      if (pushCandidate(qwenEnvPath)) {
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
__name(findEnvFilesFastPath, "findEnvFilesFastPath");
function setUpCloudShellEnvironmentFromFilesFastPath(envFilePaths) {
  for (const envFilePath of envFilePaths) {
    if (!fs.existsSync(envFilePath)) continue;
    const parsedEnv = dotenv.parse(fs.readFileSync(envFilePath));
    if (parsedEnv["GOOGLE_CLOUD_PROJECT"]) {
      process.env["GOOGLE_CLOUD_PROJECT"] = parsedEnv["GOOGLE_CLOUD_PROJECT"];
      return;
    }
  }
  process.env["GOOGLE_CLOUD_PROJECT"] = "cloudshell-gca";
}
__name(setUpCloudShellEnvironmentFromFilesFastPath, "setUpCloudShellEnvironmentFromFilesFastPath");
var serveFastPathRejectedLoaderKeys = [];
function loadServeFastPathEnvironment(settings, startDir = process.cwd()) {
  captureEnvironmentBeforeLoad();
  const userLevelPaths = getUserLevelEnvPathsFastPath();
  const envFilePaths = findEnvFilesFastPath(settings, startDir, userLevelPaths);
  const rejectedLoaderKeys = [];
  if (process.env["CLOUD_SHELL"] === "true") {
    setUpCloudShellEnvironmentFromFilesFastPath(envFilePaths);
  }
  for (const envFilePath of envFilePaths) {
    try {
      const parsedEnv = dotenv.parse(fs.readFileSync(envFilePath, "utf8"));
      const excludedVars = settings.advanced?.excludedEnvVars ?? DEFAULT_EXCLUDED_ENV_VARS;
      const normalizedEnvFilePath = path.normalize(envFilePath);
      const isHomeScopedEnvFile = userLevelPaths.has(normalizedEnvFilePath);
      const isQwenScopedEnvFile = isHomeScopedEnvFile || path.basename(path.dirname(normalizedEnvFilePath)) === SETTINGS_DIRECTORY_NAME;
      for (const key in parsedEnv) {
        if (!Object.hasOwn(parsedEnv, key)) continue;
        if (isLoaderEnvKey(key)) continue;
        if (isPrivateProvenanceEnvKey(key)) continue;
        if (!isHomeScopedEnvFile && isHardcodedProjectEnvExclusion(key)) {
          continue;
        }
        if (!isQwenScopedEnvFile && excludedVars.includes(key)) {
          continue;
        }
        if (!Object.hasOwn(process.env, key)) {
          process.env[key] = parsedEnv[key];
        }
      }
      rejectedLoaderKeys.push(
        ...reportRejectedLoaderKeys(
          // Raw candidate path, matching the source label environment.ts
          // reports — the warn-once dedup is keyed on this string.
          `.env file ${envFilePath}`,
          Object.keys(parsedEnv)
        )
      );
    } catch {
    }
  }
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (isHardcodedProjectEnvExclusion(key)) continue;
      if (isLoaderEnvKey(key)) continue;
      if (!Object.hasOwn(process.env, key) && typeof value === "string") {
        process.env[key] = value;
      }
    }
    rejectedLoaderKeys.push(
      ...reportRejectedLoaderKeys(
        `settings.env (${startDir})`,
        Object.keys(settings.env)
      )
    );
  }
  publishPendingCompileCache();
  serveFastPathRejectedLoaderKeys = [
    .../* @__PURE__ */ new Set([...serveFastPathRejectedLoaderKeys, ...rejectedLoaderKeys])
  ];
}
__name(loadServeFastPathEnvironment, "loadServeFastPathEnvironment");
function consumeServeFastPathRejectedLoaderKeys() {
  const keys = serveFastPathRejectedLoaderKeys;
  serveFastPathRejectedLoaderKeys = [];
  return keys;
}
__name(consumeServeFastPathRejectedLoaderKeys, "consumeServeFastPathRejectedLoaderKeys");
function readTrustedFolderRulesFastPath() {
  const trustedFoldersPath = getTrustedFoldersPathFastPath();
  if (cachedTrustedFolderRules && cachedTrustedFoldersPath === trustedFoldersPath) {
    return cachedTrustedFolderRules;
  }
  if (!fs.existsSync(trustedFoldersPath)) {
    cachedTrustedFoldersPath = trustedFoldersPath;
    cachedTrustedFolderRules = [];
    return cachedTrustedFolderRules;
  }
  let parsed;
  try {
    parsed = JSON.parse(
      (0, import_strip_json_comments.default)(fs.readFileSync(trustedFoldersPath, "utf8"))
    );
  } catch (err) {
    throw new Error(
      `Failed to read serve fast path trusted folders from ${trustedFoldersPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Serve fast path trusted folders file ${trustedFoldersPath} must be a JSON object.`
    );
  }
  const out = {};
  for (const [rulePath, trustLevel] of Object.entries(parsed)) {
    if (typeof trustLevel === "string") {
      out[rulePath] = trustLevel;
    }
  }
  cachedTrustedFoldersPath = trustedFoldersPath;
  cachedTrustedFolderRules = buildTrustedFolderRules(out);
  return cachedTrustedFolderRules;
}
__name(readTrustedFolderRulesFastPath, "readTrustedFolderRulesFastPath");
function buildTrustedFolderRules(trustedFolders) {
  return buildTrustPrecedenceRules(
    Object.entries(trustedFolders).map(([rulePath, trustLevel]) => ({
      path: rulePath,
      trustLevel
    }))
  );
}
__name(buildTrustedFolderRules, "buildTrustedFolderRules");
function isPathTrustedFastPath(location) {
  const rules = readTrustedFolderRulesFastPath();
  return resolveTrustDecision(rules, getPathComparisonVariants(location));
}
__name(isPathTrustedFastPath, "isPathTrustedFastPath");
function isWorkspaceTrustedFastPath(settings, realWorkspaceDir) {
  if (settings.security?.folderTrust?.enabled !== true) {
    return true;
  }
  return isPathTrustedFastPath(realWorkspaceDir);
}
__name(isWorkspaceTrustedFastPath, "isWorkspaceTrustedFastPath");
function readSettingsSummary(filePath, includeServe = false) {
  if (!fs.existsSync(filePath)) return {};
  let parsed;
  try {
    parsed = JSON.parse((0, import_strip_json_comments.default)(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    throw new Error(
      `Failed to read serve fast path settings from ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Serve fast path settings file ${filePath} must be a JSON object.`
    );
  }
  return pickFastPathSettings(parsed, includeServe);
}
__name(readSettingsSummary, "readSettingsSummary");
function shouldUseLegacyFastPathKeys(value) {
  const version = value["$version"];
  if (typeof version === "number" && version >= V2_SETTINGS_VERSION) {
    return false;
  }
  return V1_INDICATOR_KEYS.some((key) => {
    if (!(key in value)) return false;
    const item = value[key];
    return !(typeof item === "object" && item !== null && !Array.isArray(item));
  });
}
__name(shouldUseLegacyFastPathKeys, "shouldUseLegacyFastPathKeys");
function pickFastPathSettings(value, includeServe = false) {
  const out = {};
  const useLegacyKeys = shouldUseLegacyFastPathKeys(value);
  const env = value["env"];
  if (isPlainObject(env)) {
    out.env = pickStringRecord(env);
  }
  const general = value["general"];
  if (isPlainObject(general)) {
    const chatRecording = general["chatRecording"];
    if (chatRecording !== void 0 && typeof chatRecording !== "boolean") {
      throw new Error(
        "Serve fast path settings general.chatRecording must be a boolean."
      );
    }
    if (chatRecording !== void 0) {
      out.general = { chatRecording };
    }
  }
  const advanced = value["advanced"];
  if (isPlainObject(advanced)) {
    const pickedAdvanced = {};
    const excludedEnvVars = advanced["excludedEnvVars"];
    if (excludedEnvVars !== void 0 && !isStringArray(excludedEnvVars)) {
      throw new Error(
        "Serve fast path settings advanced.excludedEnvVars must be a string array."
      );
    }
    if (excludedEnvVars !== void 0) {
      pickedAdvanced.excludedEnvVars = excludedEnvVars;
    }
    const runtimeOutputDir = advanced["runtimeOutputDir"];
    if (runtimeOutputDir !== void 0 && typeof runtimeOutputDir !== "string") {
      throw new Error(
        "Serve fast path settings advanced.runtimeOutputDir must be a string."
      );
    }
    if (runtimeOutputDir !== void 0) {
      pickedAdvanced.runtimeOutputDir = runtimeOutputDir;
    }
    if (Object.keys(pickedAdvanced).length > 0) {
      out.advanced = pickedAdvanced;
    }
  }
  if (useLegacyKeys && out.advanced?.excludedEnvVars === void 0) {
    const legacyExcludedEnvVars = value["excludedProjectEnvVars"];
    if (isStringArray(legacyExcludedEnvVars)) {
      out.advanced = {
        ...out.advanced ?? {},
        excludedEnvVars: legacyExcludedEnvVars
      };
    }
  }
  const security = value["security"];
  if (isPlainObject(security)) {
    const folderTrust = security["folderTrust"];
    if (isPlainObject(folderTrust)) {
      const enabled = folderTrust["enabled"];
      if (enabled !== void 0 && typeof enabled !== "boolean") {
        throw new Error(
          "Serve fast path settings security.folderTrust.enabled must be a boolean."
        );
      }
      if (enabled !== void 0) {
        out.security = { folderTrust: { enabled } };
      }
    }
  }
  if (useLegacyKeys && out.security === void 0 && Object.hasOwn(value, "folderTrust")) {
    const legacyFolderTrust = value["folderTrust"];
    if (legacyFolderTrust !== void 0 && typeof legacyFolderTrust !== "boolean") {
      throw new Error(
        "Serve fast path settings folderTrust must be a boolean."
      );
    }
    if (legacyFolderTrust !== void 0) {
      out.security = { folderTrust: { enabled: legacyFolderTrust } };
    }
  }
  const tools = value["tools"];
  if (isPlainObject(tools)) {
    const pickedTools = {};
    const approvalMode = tools["approvalMode"];
    if (typeof approvalMode === "string") {
      pickedTools.approvalMode = approvalMode;
    }
    const sandbox = tools["sandbox"];
    if (typeof sandbox === "boolean" || typeof sandbox === "string") {
      pickedTools.sandbox = sandbox;
    }
    if (Object.keys(pickedTools).length > 0) {
      out.tools = pickedTools;
    }
  }
  const legacyApprovalMode = value["approvalMode"];
  if (useLegacyKeys && out.tools?.approvalMode === void 0 && typeof legacyApprovalMode === "string") {
    out.tools = {
      ...out.tools ?? {},
      approvalMode: legacyApprovalMode
    };
  }
  const legacySandbox = value["sandbox"];
  if (useLegacyKeys && out.tools?.sandbox === void 0 && (typeof legacySandbox === "boolean" || typeof legacySandbox === "string")) {
    out.tools = {
      ...out.tools ?? {},
      sandbox: legacySandbox
    };
  }
  const context = value["context"];
  if (isPlainObject(context)) {
    const pickedContext = {};
    const fileName = context["fileName"];
    if (typeof fileName === "string" || isStringArray(fileName)) {
      pickedContext.fileName = fileName;
    }
    const fileFiltering = context["fileFiltering"];
    if (isPlainObject(fileFiltering)) {
      const customIgnoreFiles = fileFiltering["customIgnoreFiles"];
      if (isStringArray(customIgnoreFiles)) {
        pickedContext.fileFiltering = { customIgnoreFiles };
      }
    }
    if (Object.keys(pickedContext).length > 0) {
      out.context = pickedContext;
    }
  }
  const legacyContextFileName = value["contextFileName"];
  if (useLegacyKeys && out.context?.fileName === void 0 && (typeof legacyContextFileName === "string" || isStringArray(legacyContextFileName))) {
    out.context = {
      ...out.context ?? {},
      fileName: legacyContextFileName
    };
  }
  const legacyFileFiltering = value["fileFiltering"];
  if (useLegacyKeys && out.context?.fileFiltering === void 0 && isPlainObject(legacyFileFiltering)) {
    const customIgnoreFiles = legacyFileFiltering["customIgnoreFiles"];
    if (isStringArray(customIgnoreFiles)) {
      out.context = {
        ...out.context ?? {},
        fileFiltering: { customIgnoreFiles }
      };
    }
  }
  const policy = value["policy"];
  if (isPlainObject(policy)) {
    const pickedPolicy = {};
    if (Object.hasOwn(policy, "permissionStrategy")) {
      pickedPolicy.permissionStrategy = policy["permissionStrategy"];
    }
    if (Object.hasOwn(policy, "consensusQuorum")) {
      pickedPolicy.consensusQuorum = policy["consensusQuorum"];
    }
    out.policy = pickedPolicy;
  }
  const serve = value["serve"];
  if (includeServe && isPlainObject(serve)) {
    const channels = serve["channels"];
    if (channels !== void 0) {
      out.serve = { channels };
    }
  }
  return out;
}
__name(pickFastPathSettings, "pickFastPathSettings");
function mergeFastPathSettings(...sources) {
  const merged = {};
  for (const source of sources) {
    if (source.env) {
      merged.env = { ...merged.env ?? {}, ...source.env };
    }
    if (source.general) {
      merged.general = { ...merged.general ?? {}, ...source.general };
    }
    if (source.advanced?.excludedEnvVars) {
      merged.advanced = {
        ...merged.advanced ?? {},
        excludedEnvVars: unique([
          ...merged.advanced?.excludedEnvVars ?? [],
          ...source.advanced.excludedEnvVars
        ])
      };
    }
    if (source.advanced?.runtimeOutputDir !== void 0) {
      merged.advanced = {
        ...merged.advanced ?? {},
        runtimeOutputDir: source.advanced.runtimeOutputDir
      };
    }
    if (source.security?.folderTrust) {
      merged.security = {
        ...merged.security ?? {},
        folderTrust: {
          ...merged.security?.folderTrust ?? {},
          ...source.security.folderTrust
        }
      };
    }
    if (source.tools) {
      merged.tools = { ...merged.tools ?? {}, ...source.tools };
    }
    if (source.context) {
      merged.context = {
        ...merged.context ?? {},
        ...source.context,
        ...source.context.fileFiltering ? {
          fileFiltering: {
            ...merged.context?.fileFiltering ?? {},
            ...source.context.fileFiltering
          }
        } : {}
      };
    }
    if (source.policy) {
      merged.policy = { ...merged.policy ?? {}, ...source.policy };
    }
  }
  return merged;
}
__name(mergeFastPathSettings, "mergeFastPathSettings");
function loadServeFastPathSettings(workspaceDir) {
  preResolveServeFastPathHomeEnvOverrides();
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedHomeDir = path.resolve(os.homedir());
  let realWorkspaceDir = resolvedWorkspaceDir;
  try {
    realWorkspaceDir = fs.realpathSync(resolvedWorkspaceDir);
  } catch {
  }
  const system = readSettingsSummary(getSystemSettingsPath());
  const systemDefaults = readSettingsSummary(getSystemDefaultsPath());
  const user = readSettingsSummary(
    path.join(getGlobalQwenDirLite(), "settings.json")
  );
  const initialTrustCheckSettings = mergeFastPathSettings(system, user);
  const trustDecision = isWorkspaceTrustedFastPath(
    initialTrustCheckSettings,
    realWorkspaceDir
  );
  const isTrusted = trustDecision ?? true;
  const startupChannelsTrusted = isWorkspaceTrustedFastPath(
    mergeFastPathSettings(systemDefaults, user, system),
    realWorkspaceDir
  ) === true;
  let realHomeDir = resolvedHomeDir;
  try {
    realHomeDir = fs.realpathSync(resolvedHomeDir);
  } catch {
  }
  const workspaceSettingsPath = path.join(
    realWorkspaceDir,
    SETTINGS_DIRECTORY_NAME,
    "settings.json"
  );
  const workspaceSettingsActive = realWorkspaceDir !== realHomeDir;
  const workspaceFromDisk = workspaceSettingsActive ? readSettingsSummary(workspaceSettingsPath, startupChannelsTrusted) : {};
  const workspace = isTrusted ? workspaceFromDisk : {};
  const merged = mergeFastPathSettings(systemDefaults, user, workspace, system);
  if (startupChannelsTrusted && workspaceFromDisk.serve) {
    merged.serve = {
      channels: workspaceFromDisk.serve.channels
    };
  }
  return resolveEnvVarsInObject(
    merged,
    getHomeEnvFallbackVarsFastPath()
  );
}
__name(loadServeFastPathSettings, "loadServeFastPathSettings");
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isPlainObject, "isPlainObject");
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
__name(isStringArray, "isStringArray");
function pickStringRecord(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
}
__name(pickStringRecord, "pickStringRecord");
function unique(values) {
  return Array.from(new Set(values));
}
__name(unique, "unique");

export {
  preResolveServeFastPathHomeEnvOverrides,
  resetServeFastPathHomeEnvBootstrapForTesting,
  loadServeFastPathEnvironment,
  consumeServeFastPathRejectedLoaderKeys,
  loadServeFastPathSettings
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
