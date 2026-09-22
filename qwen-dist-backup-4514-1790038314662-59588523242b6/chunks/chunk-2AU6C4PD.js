// Force strict mode and setup for ESM
"use strict";
import {
  getPlugin,
  supportedTypes
} from "./chunk-6GGSIMJR.js";
import {
  resolveChannelCwd
} from "./chunk-LFKXIOGC.js";
import {
  parseChannelOutputMode
} from "./chunk-PZRXWQUA.js";
import {
  isInternalSecretEnvVar
} from "./chunk-65I7S4Z3.js";
import {
  APPROVAL_MODES
} from "./chunk-JX6XHPTX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/channel/config-utils.ts
init_esbuild_shims();
var ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
var CHANNEL_APPROVAL_MODES = new Set(APPROVAL_MODES);
function assertNotInternalSecret(envName, reference) {
  if (isInternalSecretEnvVar(envName)) {
    throw new Error(
      `Environment variable ${envName} is a Qwen-internal secret and is never resolved into channel configuration (referenced as ${reference})`
    );
  }
}
__name(assertNotInternalSecret, "assertNotInternalSecret");
function resolveEnvVars(value, env = process.env) {
  if (value.startsWith("$$")) {
    return value.substring(1);
  }
  if (value.startsWith("$")) {
    const envName = value.substring(1);
    assertNotInternalSecret(envName, value);
    const envValue = env[envName];
    if (envValue === void 0) {
      throw new Error(
        `Environment variable ${envName} is not set (referenced as ${value})`
      );
    }
    if (envValue === "") {
      throw new Error(
        `Environment variable ${envName} is empty (referenced as ${value})`
      );
    }
    return envValue;
  }
  return value;
}
__name(resolveEnvVars, "resolveEnvVars");
function resolveOptionalStringField(channelName, rawConfig, field, envResolution) {
  const value = rawConfig[field];
  if (value === void 0 || value === null || value === "") {
    return void 0;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Channel "${channelName}" field "${field}" must be a string.`
    );
  }
  return resolveConfigEnvVar(value, envResolution);
}
__name(resolveOptionalStringField, "resolveOptionalStringField");
var KNOWN_CREDENTIAL_FIELDS = /* @__PURE__ */ new Set(["token", "clientId", "clientSecret"]);
function multiSessionCompatibilityError(name, config) {
  if (!config.multiSession) return void 0;
  if (config.sessionScope !== "user") {
    return `Channel "${name}" requires sessionScope "user" when multiSession is enabled.`;
  }
  if (typeof config.groupHistoryLimit === "number" && config.groupHistoryLimit !== 0) {
    return `Channel "${name}" cannot use groupHistoryLimit when multiSession is enabled.`;
  }
  for (const [groupId, group] of Object.entries(config.groups ?? {})) {
    const groupHistoryLimit = group !== null && typeof group === "object" && !Array.isArray(group) ? group["groupHistoryLimit"] : void 0;
    if (typeof groupHistoryLimit === "number" && groupHistoryLimit !== 0) {
      return `Channel "${name}" group "${groupId}" cannot use groupHistoryLimit when multiSession is enabled.`;
    }
  }
  if (config.webhooks !== void 0 && config.webhooks !== null) {
    return `Channel "${name}" cannot use webhooks when multiSession is enabled.`;
  }
  return void 0;
}
__name(multiSessionCompatibilityError, "multiSessionCompatibilityError");
function resolveConfigEnvVar(value, mode) {
  if (mode === false) return value;
  if (value.startsWith("$$")) return value.substring(1);
  if (mode === "available" && value.startsWith("$")) {
    const envName = value.substring(1);
    assertNotInternalSecret(envName, value);
    const envValue = process.env[envName];
    if (envValue === void 0) {
      throw new Error(
        `Environment variable ${envName} is not set (referenced as ${value}). Set the variable or remove the $ prefix to use a literal value.`
      );
    }
    if (envValue === "") {
      throw new Error(
        `Environment variable ${envName} is empty (referenced as ${value})`
      );
    }
    return envValue;
  }
  return resolveEnvVars(value);
}
__name(resolveConfigEnvVar, "resolveConfigEnvVar");
function parseObjectStringFields(channelName, rawConfig, key, fields) {
  const value = rawConfig[key];
  if (value === void 0 || value === null) {
    return void 0;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Channel "${channelName}" field "${key}" must be an object.`
    );
  }
  const record = value;
  const result = {};
  for (const field of fields) {
    const fieldValue = record[field];
    if (fieldValue === void 0 || fieldValue === null || fieldValue === "") {
      continue;
    }
    if (typeof fieldValue !== "string") {
      throw new Error(
        `Channel "${channelName}" field "${key}.${field}" must be a string.`
      );
    }
    result[field] = fieldValue;
  }
  return Object.keys(result).length > 0 ? result : void 0;
}
__name(parseObjectStringFields, "parseObjectStringFields");
function parseMemoryScopeConfig(channelName, rawConfig) {
  const parsed = parseObjectStringFields(
    channelName,
    rawConfig,
    "memoryScope",
    ["namespace", "mode"]
  );
  if (parsed?.["mode"] !== void 0 && parsed["mode"] !== "metadata-only") {
    throw new Error(
      `Channel "${channelName}" field "memoryScope.mode" must be "metadata-only".`
    );
  }
  return parsed;
}
__name(parseMemoryScopeConfig, "parseMemoryScopeConfig");
function requireStringField(channelName, path, value) {
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `Channel "${channelName}" field "${path}" must be a string.`
    );
  }
  return value;
}
__name(requireStringField, "requireStringField");
function optionalBooleanField(channelName, path, value) {
  if (value === void 0) {
    return void 0;
  }
  if (typeof value !== "boolean") {
    throw new Error(
      `Channel "${channelName}" field "${path}" must be a boolean.`
    );
  }
  return value;
}
__name(optionalBooleanField, "optionalBooleanField");
function requireObjectField(channelName, path, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Channel "${channelName}" field "${path}" must be an object.`
    );
  }
  return value;
}
__name(requireObjectField, "requireObjectField");
function parseWebhookTarget(channelName, path, raw) {
  const record = requireObjectField(channelName, path, raw);
  const target = {
    chatId: requireStringField(channelName, `${path}.chatId`, record["chatId"]),
    senderId: requireStringField(
      channelName,
      `${path}.senderId`,
      record["senderId"]
    )
  };
  if (record["threadId"] !== void 0) {
    target.threadId = requireStringField(
      channelName,
      `${path}.threadId`,
      record["threadId"]
    );
  }
  const isGroup = optionalBooleanField(
    channelName,
    `${path}.isGroup`,
    record["isGroup"]
  );
  if (isGroup !== void 0) {
    target.isGroup = isGroup;
  }
  return target;
}
__name(parseWebhookTarget, "parseWebhookTarget");
function parseWebhookSource(channelName, path, raw, env) {
  const record = requireObjectField(channelName, path, raw);
  const rawTargets = requireObjectField(
    channelName,
    `${path}.targets`,
    record["targets"]
  );
  const targets = {};
  for (const [targetRef, targetConfig] of Object.entries(rawTargets)) {
    targets[targetRef] = parseWebhookTarget(
      channelName,
      `${path}.targets.${targetRef}`,
      targetConfig
    );
  }
  const hasSecret = record["secret"] !== void 0 && record["secret"] !== null;
  const hasSecretEnv = record["secretEnv"] !== void 0 && record["secretEnv"] !== null;
  if (hasSecret === hasSecretEnv) {
    throw new Error(
      `Channel "${channelName}" field "${path}" must define exactly one of "secret" or "secretEnv".`
    );
  }
  const secret = hasSecret ? resolveEnvVars(
    requireStringField(channelName, `${path}.secret`, record["secret"]),
    env
  ) : resolveWebhookSecretEnv(
    channelName,
    path,
    requireStringField(
      channelName,
      `${path}.secretEnv`,
      record["secretEnv"]
    ),
    env
  );
  if (secret.length === 0) {
    throw new Error(
      `Channel "${channelName}" field "${path}" webhook secret must be non-empty.`
    );
  }
  return { secret, targets };
}
__name(parseWebhookSource, "parseWebhookSource");
function resolveWebhookSecretEnv(channelName, path, secretEnv, env) {
  const envName = secretEnv.startsWith("$") ? secretEnv.substring(1) : secretEnv;
  if (!ENV_VAR_NAME_PATTERN.test(envName)) {
    throw new Error(
      `Channel "${channelName}" field "${path}.secretEnv" must be an environment variable name or $-prefixed reference.`
    );
  }
  assertNotInternalSecret(envName, `${path}.secretEnv`);
  const envValue = env[envName];
  if (envValue === void 0) {
    throw new Error(
      `Channel "${channelName}" field "${path}.secretEnv" references an unset environment variable.`
    );
  }
  if (envValue === "") {
    throw new Error(
      `Channel "${channelName}" field "${path}.secretEnv" references an empty environment variable.`
    );
  }
  return envValue;
}
__name(resolveWebhookSecretEnv, "resolveWebhookSecretEnv");
function parseWebhookConfig(channelName, rawConfig, env = process.env) {
  const raw = rawConfig["webhooks"];
  if (raw === void 0 || raw === null) {
    return void 0;
  }
  const record = requireObjectField(channelName, "webhooks", raw);
  const rawSources = requireObjectField(
    channelName,
    "webhooks.sources",
    record["sources"]
  );
  const sources = {};
  for (const [source, sourceConfig] of Object.entries(rawSources)) {
    sources[source] = parseWebhookSource(
      channelName,
      `webhooks.sources.${source}`,
      sourceConfig,
      env
    );
  }
  return { sources };
}
__name(parseWebhookConfig, "parseWebhookConfig");
function parseApprovalModeConfig(channelName, rawConfig) {
  const approvalMode = rawConfig["approvalMode"];
  if (approvalMode === void 0 || approvalMode === null) {
    return void 0;
  }
  if (typeof approvalMode !== "string" || !CHANNEL_APPROVAL_MODES.has(approvalMode)) {
    throw new Error(
      `Channel "${channelName}" field "approvalMode" must be one of: ${[
        ...CHANNEL_APPROVAL_MODES
      ].join(", ")}.`
    );
  }
  return approvalMode;
}
__name(parseApprovalModeConfig, "parseApprovalModeConfig");
function parseChannelWebhookConfig(channelName, rawConfig, env = process.env) {
  return parseWebhookConfig(channelName, rawConfig, env);
}
__name(parseChannelWebhookConfig, "parseChannelWebhookConfig");
function parseChannelWebhookConfigLenient(channelName, rawConfig, onSourceError, env = process.env) {
  const raw = rawConfig["webhooks"];
  if (raw === void 0 || raw === null) {
    return void 0;
  }
  const record = requireObjectField(channelName, "webhooks", raw);
  const rawSources = requireObjectField(
    channelName,
    "webhooks.sources",
    record["sources"]
  );
  const sources = {};
  for (const [source, sourceConfig] of Object.entries(rawSources)) {
    try {
      sources[source] = parseWebhookSource(
        channelName,
        `webhooks.sources.${source}`,
        sourceConfig,
        env
      );
    } catch (error) {
      onSourceError?.(source, error);
    }
  }
  return { sources };
}
__name(parseChannelWebhookConfigLenient, "parseChannelWebhookConfigLenient");
async function parseChannelConfig(name, rawConfig, defaultCwd = process.cwd(), options = {}) {
  if (!rawConfig["type"]) {
    throw new Error(`Channel "${name}" is missing required field "type".`);
  }
  const channelType = rawConfig["type"];
  const plugin = await getPlugin(channelType);
  if (!plugin) {
    const types = await supportedTypes();
    throw new Error(
      `Channel type "${channelType}" is not supported. Available: ${types.join(", ")}`
    );
  }
  const resolvedRawConfig = { ...rawConfig };
  const outputMode = parseChannelOutputMode(
    name,
    rawConfig["outputMode"],
    plugin.supportsOutputMode === true
  );
  const envResolution = options.resolveEnvVars ?? true;
  const resolvedPluginFields = /* @__PURE__ */ new Set();
  for (const field of plugin.requiredConfigFields ?? []) {
    const value = rawConfig[field];
    if (value === void 0 || value === null || value === "") {
      throw new Error(
        `Channel "${name}" (${channelType}) requires "${field}".`
      );
    }
    if (typeof value === "string" && !KNOWN_CREDENTIAL_FIELDS.has(field)) {
      resolvedRawConfig[field] = resolveConfigEnvVar(value, envResolution);
      resolvedPluginFields.add(field);
    }
  }
  for (const field of plugin.envResolvableConfigFields ?? []) {
    if (resolvedPluginFields.has(field)) continue;
    const value = rawConfig[field];
    if (typeof value === "string" && value !== "") {
      resolvedRawConfig[field] = resolveConfigEnvVar(value, envResolution);
    }
  }
  const token = resolveOptionalStringField(name, rawConfig, "token", envResolution) ?? "";
  const clientId = resolveOptionalStringField(
    name,
    rawConfig,
    "clientId",
    envResolution
  );
  const clientSecret = resolveOptionalStringField(
    name,
    rawConfig,
    "clientSecret",
    envResolution
  );
  const configuredSessionScope = rawConfig["sessionScope"] || plugin.defaultSessionScope || "user";
  const multiSession = optionalBooleanField(
    name,
    "multiSession",
    rawConfig["multiSession"]
  );
  const groups = rawConfig["groups"] || {};
  const webhooks = parseWebhookConfig(name, rawConfig);
  const multiSessionError = multiSessionCompatibilityError(name, {
    multiSession,
    sessionScope: configuredSessionScope,
    groupHistoryLimit: rawConfig["groupHistoryLimit"],
    groups,
    webhooks
  });
  if (multiSessionError) throw new Error(multiSessionError);
  return {
    ...resolvedRawConfig,
    type: channelType,
    token,
    clientId,
    clientSecret,
    senderPolicy: rawConfig["senderPolicy"] || "allowlist",
    allowedUsers: rawConfig["allowedUsers"] || [],
    sessionScope: configuredSessionScope,
    multiSession,
    cwd: resolveChannelCwd(rawConfig["cwd"], defaultCwd),
    approvalMode: parseApprovalModeConfig(name, rawConfig),
    instructions: rawConfig["instructions"],
    identity: parseObjectStringFields(name, rawConfig, "identity", [
      "id",
      "displayName",
      "description"
    ]),
    memoryScope: parseMemoryScopeConfig(name, rawConfig),
    model: rawConfig["model"],
    outputMode,
    groupPolicy: rawConfig["groupPolicy"] || "disabled",
    dmPolicy: rawConfig["dmPolicy"] || "open",
    groups,
    webhooks
  };
}
__name(parseChannelConfig, "parseChannelConfig");

export {
  resolveEnvVars,
  multiSessionCompatibilityError,
  parseChannelWebhookConfig,
  parseChannelWebhookConfigLenient,
  parseChannelConfig
};
