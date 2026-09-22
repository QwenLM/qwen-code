// Force strict mode and setup for ESM
"use strict";
import {
  multiSessionCompatibilityError
} from "./chunk-2AU6C4PD.js";
import {
  UNSAFE_OBJECT_KEYS,
  getPlugin
} from "./chunk-6GGSIMJR.js";
import {
  CHANNEL_OUTPUT_MODE_FIELD,
  parseChannelOutputMode
} from "./chunk-PZRXWQUA.js";
import {
  loadSettings,
  saveSettings
} from "./chunk-DRYBBTI5.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-settings-store.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
var ChannelSettingsError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ChannelSettingsError";
  }
  static {
    __name(this, "ChannelSettingsError");
  }
};
function revisionOf(channels, startupNames) {
  return createHash("sha256").update(JSON.stringify({ channels, startupNames })).digest("hex");
}
__name(revisionOf, "revisionOf");
function applySecretUpdate(current, update) {
  validateSecretUpdate(update);
  if (update.operation === "preserve") return current;
  if (update.operation === "clear") return void 0;
  if (typeof update.value !== "string" || update.value.length === 0) {
    throw invalidSecret("Secret replacements must be non-empty strings.");
  }
  return update.value;
}
__name(applySecretUpdate, "applySecretUpdate");
function invalidSecret(message) {
  return new ChannelSettingsError("channel_settings_invalid_secret", message);
}
__name(invalidSecret, "invalidSecret");
function invalidConfig(message) {
  return new ChannelSettingsError("channel_settings_invalid_config", message);
}
__name(invalidConfig, "invalidConfig");
function assertSafeChannelName(name) {
  if (UNSAFE_OBJECT_KEYS.has(name)) {
    throw new ChannelSettingsError(
      "channel_settings_invalid_name",
      `Channel name ${JSON.stringify(name)} is not allowed.`
    );
  }
}
__name(assertSafeChannelName, "assertSafeChannelName");
function assertUpsertChannelName(name) {
  assertSafeChannelName(name);
  if (isAllStartupName(name)) {
    throw new ChannelSettingsError(
      "channel_settings_invalid_name",
      `Channel name ${JSON.stringify(name)} is reserved for startup selection.`
    );
  }
}
__name(assertUpsertChannelName, "assertUpsertChannelName");
function isAllStartupName(name) {
  return name.trim() === "all";
}
__name(isAllStartupName, "isAllStartupName");
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function isEnvironmentReference(value) {
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
__name(isEnvironmentReference, "isEnvironmentReference");
function assertStringRecord(key, value, allowedKeys) {
  if (!isRecord(value)) {
    throw invalidConfig(`Channel field "${key}" must be an object.`);
  }
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    if (!allowedKeys.has(nestedKey) || typeof nestedValue !== "string") {
      throw invalidConfig(`Channel field "${key}.${nestedKey}" is invalid.`);
    }
  }
}
__name(assertStringRecord, "assertStringRecord");
function assertSharedField(key, value, previous) {
  if (key === "multiSession") {
    if (typeof value !== "boolean") {
      throw invalidConfig(`Channel field "${key}" must be a boolean.`);
    }
    return true;
  }
  const enumValues = {
    senderPolicy: /* @__PURE__ */ new Set(["allowlist", "pairing", "open"]),
    dmPolicy: /* @__PURE__ */ new Set(["open", "disabled"]),
    groupPolicy: /* @__PURE__ */ new Set(["disabled", "allowlist", "pairing", "open"]),
    sessionScope: /* @__PURE__ */ new Set(["user", "thread", "chat_thread", "single"]),
    dispatchMode: /* @__PURE__ */ new Set(["steer", "followup", "collect"])
  };
  if (Object.hasOwn(enumValues, key)) {
    if (typeof value !== "string" || !enumValues[key].has(value)) {
      throw invalidConfig(`Channel field "${key}" has an invalid value.`);
    }
    return true;
  }
  if (["model", "cwd", "approvalMode", "instructions"].includes(key)) {
    if (typeof value !== "string") {
      throw invalidConfig(`Channel field "${key}" must be a string.`);
    }
    return true;
  }
  if (key === "allowedUsers") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw invalidConfig(`Channel field "${key}" must be a string array.`);
    }
    return true;
  }
  if (key === "groups") {
    if (!isRecord(value)) {
      if (containsUnsafeObjectKey(value) || !isDeepStrictEqual(previous, value)) {
        throw invalidConfig(`Channel field "${key}" must be an object.`);
      }
      return true;
    }
    const previousGroups = isRecord(previous) ? previous : {};
    for (const [groupId, groupConfig] of Object.entries(value)) {
      if (UNSAFE_OBJECT_KEYS.has(groupId) || !isRecord(groupConfig)) {
        throw invalidConfig(`Channel field "${key}.${groupId}" is invalid.`);
      }
      const previousGroup = isRecord(previousGroups[groupId]) ? previousGroups[groupId] : {};
      for (const [nestedKey, nestedValue] of Object.entries(groupConfig)) {
        const known = [
          "requireMention",
          "dispatchMode",
          "groupHistoryLimit"
        ].includes(nestedKey);
        const valid = nestedKey === "requireMention" && typeof nestedValue === "boolean" || nestedKey === "dispatchMode" && typeof nestedValue === "string" && ["collect", "steer", "followup"].includes(nestedValue) || nestedKey === "groupHistoryLimit" && typeof nestedValue === "number" && Number.isFinite(nestedValue);
        if (known && !valid && !(Object.hasOwn(previousGroup, nestedKey) && isDeepStrictEqual(previousGroup[nestedKey], nestedValue) && !containsUnsafeObjectKey(nestedValue))) {
          throw invalidConfig(
            `Channel field "${key}.${groupId}.${nestedKey}" is invalid.`
          );
        }
        if (!known) {
          assertPreservedUnknownField(
            `${key}.${groupId}`,
            nestedKey,
            nestedValue,
            previousGroup
          );
        }
      }
    }
    return true;
  }
  if (key === "groupHistoryLimit") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalidConfig(`Channel field "${key}" must be a number.`);
    }
    return true;
  }
  if (key === "identity") {
    assertStringRecord(
      key,
      value,
      /* @__PURE__ */ new Set(["id", "displayName", "description"])
    );
    return true;
  }
  if (key === "memoryScope") {
    if (!isRecord(value)) {
      throw invalidConfig(`Channel field "${key}" must be an object.`);
    }
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      const valid = nestedKey === "namespace" && typeof nestedValue === "string" || nestedKey === "mode" && nestedValue === "metadata-only";
      if (!valid) {
        throw invalidConfig(`Channel field "${key}.${nestedKey}" is invalid.`);
      }
    }
    return true;
  }
  return false;
}
__name(assertSharedField, "assertSharedField");
function containsUnsafeObjectKey(value) {
  if (Array.isArray(value)) {
    return value.some((item) => containsUnsafeObjectKey(item));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) => UNSAFE_OBJECT_KEYS.has(key) || containsUnsafeObjectKey(nested)
  );
}
__name(containsUnsafeObjectKey, "containsUnsafeObjectKey");
function assertDescriptorValue(field, value, path = field.key, previous) {
  if (field.kind === "object") {
    if (isDeepStrictEqual(previous, value) && !containsUnsafeObjectKey(value)) {
      return;
    }
    if (!isRecord(value)) {
      throw invalidConfig(`Channel field "${path}" has an invalid value.`);
    }
    const previousRecord = isRecord(previous) ? previous : {};
    const properties = new Map(
      field.properties.map((property) => [property.key, property])
    );
    for (const [key, nestedValue] of Object.entries(value)) {
      const property = properties.get(key);
      if (!property) {
        assertPreservedUnknownField(path, key, nestedValue, previousRecord);
        continue;
      }
      assertDescriptorValue(
        property,
        nestedValue,
        `${path}.${key}`,
        Object.hasOwn(previousRecord, key) ? previousRecord[key] : void 0
      );
    }
    assertRequiredFields(field.properties, value, path);
    return;
  }
  const invalidEnvironment = typeof value === "string" && isEnvironmentReference(value) && !field.envResolvable;
  if (invalidEnvironment) {
    throw invalidConfig(
      `Channel field "${path}" does not support environment references.`
    );
  }
  const valid = (field.kind === "string" || field.kind === "secret") && typeof value === "string" && value.length > 0 || field.kind === "boolean" && typeof value === "boolean" || field.kind === "number" && typeof value === "number" && Number.isFinite(value) && (field.exclusiveMinimum === void 0 || value > field.exclusiveMinimum) || field.kind === "enum" && typeof value === "string" && field.options?.some((option) => option.value === value) === true || field.kind === "string-list" && Array.isArray(value) && value.every((item) => typeof item === "string") || field.kind === "record" && isRecord(value) && Object.values(value).every((v) => typeof v === "string") && !containsUnsafeObjectKey(value);
  if (!valid) {
    throw invalidConfig(`Channel field "${path}" has an invalid value.`);
  }
}
__name(assertDescriptorValue, "assertDescriptorValue");
function assertRequiredFields(fields, values, path) {
  for (const field of fields) {
    if (!field.required) continue;
    const value = Object.hasOwn(values, field.key) ? values[field.key] : void 0;
    if (value === void 0 || value === null || value === "") {
      const fieldPath = path ? `${path}.${field.key}` : field.key;
      throw invalidConfig(`Channel field "${fieldPath}" is required.`);
    }
  }
}
__name(assertRequiredFields, "assertRequiredFields");
function assertPreservedUnknownField(path, key, value, previous) {
  const fieldPath = path ? `${path}.${key}` : key;
  if (UNSAFE_OBJECT_KEYS.has(key)) {
    throw invalidConfig(`Channel field "${fieldPath}" is not manageable.`);
  }
  if (containsUnsafeObjectKey(value)) {
    throw invalidConfig(
      `Channel field "${fieldPath}" cannot use a reserved key.`
    );
  }
  if (Object.hasOwn(previous, key) && isDeepStrictEqual(previous[key], value)) {
    return;
  }
  throw invalidConfig(`Channel field "${fieldPath}" is not manageable.`);
}
__name(assertPreservedUnknownField, "assertPreservedUnknownField");
function assertManagedConfig(config, previous, fields) {
  const descriptorFields = new Map(fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(config)) {
    if (key === "type") continue;
    const field = descriptorFields.get(key);
    if (field) {
      assertDescriptorValue(
        field,
        value,
        field.key,
        Object.hasOwn(previous, key) ? previous[key] : void 0
      );
      continue;
    }
    if (assertSharedField(
      key,
      value,
      Object.hasOwn(previous, key) ? previous[key] : void 0
    )) {
      continue;
    }
    assertPreservedUnknownField(void 0, key, value, previous);
  }
  assertRequiredFields(fields, config);
}
__name(assertManagedConfig, "assertManagedConfig");
function validateSecretUpdate(update) {
  if (!isRecord(update)) {
    throw invalidSecret("Secret updates must be objects.");
  }
  const operation = update["operation"];
  const keys = Object.keys(update).sort();
  const valid = (operation === "preserve" || operation === "clear") && keys.length === 1 && keys[0] === "operation" || operation === "replace" && keys.length === 2 && keys[0] === "operation" && keys[1] === "value" && typeof update["value"] === "string" && update["value"].length > 0;
  if (!valid) {
    throw invalidSecret("Secret updates contain an invalid operation.");
  }
}
__name(validateSecretUpdate, "validateSecretUpdate");
function assertValidChannelSecretUpdates(updates) {
  if (!isRecord(updates)) {
    throw invalidSecret("Secret updates must be objects.");
  }
  for (const [key, update] of Object.entries(updates)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      throw invalidSecret(`Secret update ${JSON.stringify(key)} is invalid.`);
    }
    validateSecretUpdate(update);
  }
}
__name(assertValidChannelSecretUpdates, "assertValidChannelSecretUpdates");
function workspaceValues(workspaceCwd) {
  const settings = loadSettings(workspaceCwd, { skipLoadEnvironment: true }).workspace.settings;
  const rawChannels = isRecord(settings.channels) ? settings.channels : {};
  const channels = {};
  for (const [name, config] of Object.entries(rawChannels)) {
    if (isRecord(config)) channels[name] = config;
  }
  const startupNames = Array.isArray(settings.serve?.channels) ? settings.serve.channels.filter(
    (name) => typeof name === "string"
  ) : [];
  return { channels, startupNames };
}
__name(workspaceValues, "workspaceValues");
var WorkspaceChannelSettingsStore = class {
  constructor(workspaceCwd) {
    this.workspaceCwd = workspaceCwd;
  }
  static {
    __name(this, "WorkspaceChannelSettingsStore");
  }
  snapshot() {
    const { channels, startupNames } = workspaceValues(this.workspaceCwd);
    return {
      revision: revisionOf(channels, startupNames),
      channels: { ...channels },
      startupNames: [...startupNames]
    };
  }
  async upsert(name, options) {
    assertUpsertChannelName(name);
    const secretUpdates = options.secrets === void 0 ? {} : options.secrets;
    assertValidChannelSecretUpdates(secretUpdates);
    const plugin = await getPlugin(options.config.type);
    if (!plugin?.management) {
      throw new ChannelSettingsError(
        "channel_settings_unmanageable",
        `Channel type "${options.config.type}" does not provide safe management metadata.`
      );
    }
    const secretKeys = new Set(
      plugin.management.fields.filter((field) => field.kind === "secret").map((field) => field.key)
    );
    for (const key of Object.keys(secretUpdates)) {
      if (!secretKeys.has(key)) {
        throw invalidSecret(
          `Channel type "${options.config.type}" does not declare "${key}" as a secret.`
        );
      }
    }
    for (const key of secretKeys) {
      if (Object.hasOwn(options.config, key)) {
        throw invalidSecret(
          `Secret "${key}" must use an explicit preserve, replace, or clear operation.`
        );
      }
    }
    const current = this.assertRevision(options.expectedRevision);
    const storedPrevious = current.channels[name] ?? {};
    const previous = storedPrevious["type"] === options.config.type ? storedPrevious : {};
    const nextConfig = { ...options.config };
    for (const key of secretKeys) {
      const update = secretUpdates[key] ?? { operation: "preserve" };
      const value = applySecretUpdate(previous[key], update);
      if (value !== void 0) nextConfig[key] = value;
    }
    try {
      parseChannelOutputMode(
        name,
        nextConfig["outputMode"],
        plugin.supportsOutputMode === true
      );
    } catch (error) {
      throw invalidConfig(
        error instanceof Error ? error.message : String(error)
      );
    }
    assertManagedConfig(
      nextConfig,
      previous,
      plugin.supportsOutputMode === true ? [...plugin.management.fields, CHANNEL_OUTPUT_MODE_FIELD] : plugin.management.fields
    );
    const multiSessionError = multiSessionCompatibilityError(name, {
      multiSession: nextConfig["multiSession"] === true,
      sessionScope: nextConfig["sessionScope"] ?? plugin.defaultSessionScope ?? "user",
      groupHistoryLimit: nextConfig["groupHistoryLimit"],
      groups: isRecord(nextConfig["groups"]) ? nextConfig["groups"] : {},
      webhooks: nextConfig["webhooks"]
    });
    if (multiSessionError) throw invalidConfig(multiSessionError);
    let crossFieldError;
    try {
      crossFieldError = plugin.management.validateConfig?.(nextConfig);
      if (crossFieldError instanceof Promise) {
        void crossFieldError.catch(() => {
        });
      }
    } catch (error) {
      throw invalidConfig(
        `Channel validateConfig failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (crossFieldError !== void 0) {
      throw invalidConfig(
        typeof crossFieldError === "string" ? crossFieldError : "Channel validateConfig must return a string error message."
      );
    }
    const channels = { ...current.channels, [name]: nextConfig };
    const workspaceFile = loadSettings(this.workspaceCwd, {
      skipLoadEnvironment: true
    }).workspace;
    saveSettings(workspaceFile, { channels }, ["channels"], {
      throwOnWriteFailure: true
    });
    return this.snapshot();
  }
  async remove(name, options) {
    assertSafeChannelName(name);
    const current = this.assertRevision(options.expectedRevision);
    const channels = { ...current.channels };
    delete channels[name];
    const hasAllSentinel = current.startupNames.some(isAllStartupName);
    const startupNames = hasAllSentinel ? Object.keys(channels).some(
      (channelName) => !isAllStartupName(channelName)
    ) ? ["all"] : [] : current.startupNames.filter((startupName) => startupName !== name);
    const workspaceFile = loadSettings(this.workspaceCwd, {
      skipLoadEnvironment: true
    }).workspace;
    saveSettings(
      workspaceFile,
      { channels, serve: { channels: startupNames } },
      ["channels"],
      { throwOnWriteFailure: true }
    );
    return this.snapshot();
  }
  async setStartupNames(names, options) {
    for (const name of names) {
      assertSafeChannelName(name);
    }
    this.assertRevision(options.expectedRevision);
    const workspaceFile = loadSettings(this.workspaceCwd, {
      skipLoadEnvironment: true
    }).workspace;
    saveSettings(
      workspaceFile,
      { serve: { channels: [...names] } },
      ["serve", "channels"],
      { throwOnWriteFailure: true }
    );
    return this.snapshot();
  }
  assertRevision(expectedRevision) {
    const current = this.snapshot();
    if (current.revision !== expectedRevision) {
      throw new ChannelSettingsError(
        "channel_settings_conflict",
        "Channel settings changed; reload before trying again."
      );
    }
    return current;
  }
};

export {
  ChannelSettingsError,
  assertValidChannelSecretUpdates,
  WorkspaceChannelSettingsStore
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
