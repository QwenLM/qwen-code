// Force strict mode and setup for ESM
"use strict";
import {
  getUserSettingsPath,
  v1ToV2Migration
} from "./chunk-DRYBBTI5.js";
import {
  getSystemDefaultsPath,
  getSystemSettingsPath
} from "./chunk-IDS7MSUP.js";
import {
  LoadedTrustedFolders,
  TrustLevel,
  getExplicitTrustLevel,
  getTrustedFoldersPath
} from "./chunk-36RKQ7ZS.js";
import {
  require_strip_json_comments
} from "./chunk-NPQ5ZKRP.js";
import {
  arePathsEquivalent
} from "./chunk-MR3PXB6E.js";
import {
  ideContextStore
} from "./chunk-MRTRBONQ.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/daemon-trust-policy.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
var import_strip_json_comments = __toESM(require_strip_json_comments(), 1);
var MAX_TRUSTED_FOLDERS_BYTES = 1024 * 1024;
var MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
function policyError(code, filePath, error) {
  return {
    code,
    path: filePath,
    message: error instanceof Error ? error.message : String(error)
  };
}
__name(policyError, "policyError");
async function readJsonObject(filePath, maxBytes, requireRegularFile, retryMissing = false) {
  const delays = [0, 50, 200];
  let result = {};
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    result = await readJsonObjectOnce(filePath, maxBytes, requireRegularFile);
    if (!result.error && (!result.missing || !retryMissing)) return result;
  }
  return result;
}
__name(readJsonObject, "readJsonObject");
async function readJsonObjectOnce(filePath, maxBytes, requireRegularFile) {
  let stat2;
  try {
    stat2 = await fs.lstat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { value: {}, missing: true };
    }
    return {
      error: policyError("trust_policy_unreadable", filePath, error)
    };
  }
  if (!requireRegularFile && stat2.isSymbolicLink()) {
    try {
      stat2 = await fs.stat(filePath);
    } catch (error) {
      return {
        error: policyError("trust_policy_unreadable", filePath, error)
      };
    }
  }
  if (requireRegularFile && stat2.isSymbolicLink() || !stat2.isFile()) {
    return {
      error: policyError(
        "trust_policy_invalid",
        filePath,
        new Error("Trust policy input must be a regular file.")
      )
    };
  }
  if (stat2.size > maxBytes) {
    return {
      error: policyError(
        "trust_policy_invalid",
        filePath,
        new Error(`Trust policy input exceeds ${maxBytes} bytes.`)
      )
    };
  }
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse((0, import_strip_json_comments.default)(raw));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Trust policy input must contain a JSON object.");
    }
    return { value: parsed };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { value: {}, missing: true };
    }
    return { error: policyError("trust_policy_invalid", filePath, error) };
  }
}
__name(readJsonObjectOnce, "readJsonObjectOnce");
function migrateFolderTrustSettings(value, scope) {
  if (!value || !v1ToV2Migration.shouldMigrate(value)) return value;
  return v1ToV2Migration.migrate(value, scope).settings;
}
__name(migrateFolderTrustSettings, "migrateFolderTrustSettings");
function folderTrustSetting(value, filePath) {
  if (!value || !("security" in value)) return {};
  const security = value?.["security"];
  if (typeof security !== "object" || security === null || Array.isArray(security)) {
    return {
      error: policyError(
        "trust_policy_invalid",
        filePath,
        new Error("`security` must be an object.")
      )
    };
  }
  if (!("folderTrust" in security)) return {};
  const folderTrust = security["folderTrust"];
  if (typeof folderTrust !== "object" || folderTrust === null || Array.isArray(folderTrust)) {
    return {
      error: policyError(
        "trust_policy_invalid",
        filePath,
        new Error("`security.folderTrust` must be an object.")
      )
    };
  }
  if (!("enabled" in folderTrust)) return {};
  const enabled = folderTrust["enabled"];
  if (typeof enabled === "boolean") return { value: enabled };
  return {
    error: policyError(
      "trust_policy_invalid",
      filePath,
      new Error("`security.folderTrust.enabled` must be a boolean.")
    )
  };
}
__name(folderTrustSetting, "folderTrustSetting");
function parseTrustedFolders(value, filePath) {
  const config = {};
  for (const [rulePath, rawLevel] of Object.entries(value ?? {})) {
    if (!Object.values(TrustLevel).includes(rawLevel)) {
      return {
        config: {},
        error: policyError(
          "trust_policy_invalid",
          filePath,
          new Error(`Invalid trust level for ${JSON.stringify(rulePath)}.`)
        )
      };
    }
    config[rulePath] = rawLevel;
  }
  return { config };
}
__name(parseTrustedFolders, "parseTrustedFolders");
function semanticRevision(input) {
  const sortedRules = Object.entries(input.trustedFolders).sort(
    ([a], [b]) => a.localeCompare(b)
  );
  return createHash("sha256").update(
    JSON.stringify({
      folderTrustEnabled: input.folderTrustEnabled,
      ideTrust: input.ideTrust ?? null,
      trustedFolders: sortedRules,
      settingsError: input.settingsError?.code ?? null,
      trustedFoldersError: input.trustedFoldersError?.code ?? null
    })
  ).digest("hex");
}
__name(semanticRevision, "semanticRevision");
async function readDaemonTrustPolicySnapshot() {
  const [user, system, systemDefaults] = await Promise.all([
    readJsonObject(getUserSettingsPath(), MAX_SETTINGS_BYTES, false),
    readJsonObject(getSystemSettingsPath(), MAX_SETTINGS_BYTES, false),
    readJsonObject(getSystemDefaultsPath(), MAX_SETTINGS_BYTES, false)
  ]);
  const systemFolderTrust = folderTrustSetting(
    migrateFolderTrustSettings(system.value, "System"),
    getSystemSettingsPath()
  );
  const userFolderTrust = folderTrustSetting(
    migrateFolderTrustSettings(user.value, "User"),
    getUserSettingsPath()
  );
  const defaultsFolderTrust = folderTrustSetting(
    migrateFolderTrustSettings(systemDefaults.value, "SystemDefaults"),
    getSystemDefaultsPath()
  );
  const settingsError = system.error ?? systemFolderTrust.error ?? user.error ?? userFolderTrust.error ?? systemDefaults.error ?? defaultsFolderTrust.error;
  const folderTrustEnabled = systemFolderTrust.value ?? userFolderTrust.value ?? defaultsFolderTrust.value ?? false;
  const trustedFoldersFile = await readJsonObject(
    getTrustedFoldersPath(),
    MAX_TRUSTED_FOLDERS_BYTES,
    true,
    folderTrustEnabled
  );
  const parsedTrustedFolders = parseTrustedFolders(
    trustedFoldersFile.value,
    getTrustedFoldersPath()
  );
  const trustedFoldersError = trustedFoldersFile.error ?? parsedTrustedFolders.error;
  const ideTrust = ideContextStore.get()?.workspaceState?.isTrusted;
  const revision = semanticRevision({
    folderTrustEnabled,
    ideTrust,
    trustedFolders: parsedTrustedFolders.config,
    ...settingsError ? { settingsError } : {},
    ...trustedFoldersError ? { trustedFoldersError } : {}
  });
  return {
    revision,
    folderTrustEnabled,
    ideTrust,
    trustedFolders: Object.freeze({ ...parsedTrustedFolders.config }),
    ...settingsError ? { settingsError } : {},
    ...trustedFoldersError ? { trustedFoldersError } : {}
  };
}
__name(readDaemonTrustPolicySnapshot, "readDaemonTrustPolicySnapshot");
function explicitTrustLevel(snapshot, workspaceCwd) {
  return getExplicitTrustLevel(snapshot.trustedFolders, workspaceCwd);
}
__name(explicitTrustLevel, "explicitTrustLevel");
function evaluateDaemonWorkspaceTrust(snapshot, workspaceCwd, processCwd = process.cwd()) {
  if (snapshot.settingsError) {
    return {
      state: "error",
      targetTrusted: false,
      source: "none",
      explicitTrustLevel: null,
      error: snapshot.settingsError
    };
  }
  if (!snapshot.folderTrustEnabled) {
    return {
      state: "trusted",
      targetTrusted: true,
      source: "disabled",
      explicitTrustLevel: null
    };
  }
  if (snapshot.ideTrust !== void 0 && arePathsEquivalent(workspaceCwd, processCwd)) {
    return {
      state: snapshot.ideTrust ? "trusted" : "untrusted",
      targetTrusted: snapshot.ideTrust,
      source: "ide",
      explicitTrustLevel: null
    };
  }
  if (snapshot.trustedFoldersError) {
    return {
      state: "error",
      targetTrusted: false,
      source: "none",
      explicitTrustLevel: null,
      error: snapshot.trustedFoldersError
    };
  }
  const folders = new LoadedTrustedFolders(
    {
      path: getTrustedFoldersPath(),
      config: { ...snapshot.trustedFolders }
    },
    []
  );
  const trusted = folders.isPathTrusted(workspaceCwd);
  return {
    state: trusted === true ? "trusted" : trusted === false ? "untrusted" : "unknown",
    targetTrusted: trusted === true,
    source: trusted === void 0 ? "none" : "file",
    explicitTrustLevel: explicitTrustLevel(snapshot, workspaceCwd)
  };
}
__name(evaluateDaemonWorkspaceTrust, "evaluateDaemonWorkspaceTrust");

export {
  readDaemonTrustPolicySnapshot,
  evaluateDaemonWorkspaceTrust
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
