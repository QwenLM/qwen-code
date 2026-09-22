// Force strict mode and setup for ESM
"use strict";
import {
  CHANNEL_OUTPUT_MODE_FIELD
} from "./chunk-PZRXWQUA.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/channel/channel-registry.ts
init_esbuild_shims();
var registry = /* @__PURE__ */ new Map();
var builtinsPromise = null;
var UNSAFE_OBJECT_KEYS = /* @__PURE__ */ new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
var FIELD_KINDS = /* @__PURE__ */ new Set([
  "string",
  "secret",
  "boolean",
  "number",
  "enum",
  "string-list",
  "record",
  "object"
]);
var SHARED_ACCESS_FIELDS = [
  {
    key: "senderPolicy",
    label: "Sender Policy",
    kind: "enum",
    required: true,
    default: "pairing",
    description: "Controls who can start direct conversations",
    options: [
      { value: "pairing", label: "Pairing" },
      { value: "allowlist", label: "Allowlist" },
      { value: "open", label: "Open" }
    ]
  },
  {
    key: "allowedUsers",
    label: "Allowed Users",
    kind: "string-list",
    description: "Stable user IDs allowed without pairing"
  },
  {
    key: "groupPolicy",
    label: "Group Policy",
    kind: "enum",
    required: true,
    default: "disabled",
    description: "Controls which group conversations can use this Channel",
    options: [
      { value: "disabled", label: "Disabled" },
      { value: "pairing", label: "Pairing" },
      { value: "allowlist", label: "Allowlist" },
      { value: "open", label: "Open" }
    ]
  }
];
var SESSION_SCOPE_OPTIONS = [
  { value: "user", label: "Per User and Chat" },
  { value: "thread", label: "Per Thread (Legacy)" },
  { value: "chat_thread", label: "Per Chat and Thread" },
  { value: "single", label: "One Shared Session" }
];
function managementFieldsWithSharedControls(fields, defaultSessionScope, supportsOutputMode) {
  const declared = new Set(fields.map((field) => field.key));
  const normalizedFields = fields.map(
    (field) => field.key === "sessionScope" && field.default === void 0 ? { ...field, default: defaultSessionScope } : field
  );
  return [
    ...normalizedFields,
    ...supportsOutputMode ? [CHANNEL_OUTPUT_MODE_FIELD] : [],
    ...SHARED_ACCESS_FIELDS.filter((field) => !declared.has(field.key)),
    ...declared.has("sessionScope") ? [] : [
      {
        key: "sessionScope",
        label: "Session Scope",
        kind: "enum",
        required: true,
        default: defaultSessionScope,
        description: "Controls how conversations share persistent agent sessions",
        options: SESSION_SCOPE_OPTIONS
      }
    ],
    ...declared.has("multiSession") ? [] : [
      {
        key: "multiSession",
        label: "Named Sessions",
        kind: "boolean",
        description: "Retain an owner-scoped catalog of named tasks in daemon-managed mode"
      }
    ],
    ...declared.has("instructions") ? [] : [
      {
        key: "instructions",
        label: "Instructions",
        kind: "string",
        multiline: true,
        description: "Guidance injected into each channel session context; some channels replace their own default guidance when this is set"
      }
    ]
  ];
}
__name(managementFieldsWithSharedControls, "managementFieldsWithSharedControls");
function assertManagementFields(fields, parentPath, nested = false) {
  const seen = /* @__PURE__ */ new Set();
  for (const field of fields) {
    const path = parentPath ? `${parentPath}.${field.key}` : field.key;
    if (typeof field.key !== "string" || field.key.length === 0) {
      throw new Error(
        `Channel field "${path}" must declare a non-empty string key.`
      );
    }
    if (seen.has(field.key)) {
      throw new Error(`Channel field "${path}" is declared more than once.`);
    }
    seen.add(field.key);
    assertManagementField(field, path, nested);
  }
}
__name(assertManagementFields, "assertManagementFields");
function assertManagementField(field, path, nested) {
  if (!FIELD_KINDS.has(field.kind)) {
    throw new Error(
      `Channel field "${path}" declares an unknown kind "${field.kind}".`
    );
  }
  if (UNSAFE_OBJECT_KEYS.has(field.key)) {
    throw new Error(`Channel field "${path}" cannot use a reserved key.`);
  }
  if (!nested && field.key === "type") {
    throw new Error(
      `Channel field "${path}" cannot use the reserved key "type".`
    );
  }
  if (!nested && field.key === "outputMode") {
    throw new Error(
      'Channel field "outputMode" is shared; declare supportsOutputMode instead.'
    );
  }
  if (typeof field.label !== "string" || field.label.length === 0) {
    throw new Error(`Channel field "${path}" must declare a string label.`);
  }
  if (field.description !== void 0 && typeof field.description !== "string") {
    throw new Error(
      `Channel field "${path}" must declare a string description.`
    );
  }
  if (field.default !== void 0 && typeof field.default !== "string") {
    throw new Error(`Channel field "${path}" must declare a string default.`);
  }
  const envResolvable = Boolean(field.envResolvable);
  const required = Boolean(field.required);
  if (field.kind === "secret" && nested) {
    throw new Error(`Channel field "${path}" cannot declare a nested secret.`);
  }
  if (envResolvable && (nested || field.kind !== "string" && field.kind !== "secret")) {
    throw new Error(
      `Channel field "${path}" cannot resolve environment references.`
    );
  }
  const exclusiveMinimum = field.exclusiveMinimum;
  if (exclusiveMinimum !== void 0) {
    if (field.kind !== "number") {
      throw new Error(
        `Channel field "${path}" can only declare exclusiveMinimum on number fields.`
      );
    }
    if (typeof exclusiveMinimum !== "number" || !Number.isFinite(exclusiveMinimum)) {
      throw new Error(
        `Channel field "${path}" must declare a finite exclusiveMinimum.`
      );
    }
  }
  if (field.kind === "enum") {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      throw new Error(
        `Channel field "${path}" must declare at least one option.`
      );
    }
    if (field.options.some(
      (option) => typeof option?.value !== "string" || option.value.length === 0
    )) {
      throw new Error(
        `Channel field "${path}" must declare non-empty string option values.`
      );
    }
    if (new Set(field.options.map((option) => option.value)).size !== field.options.length) {
      throw new Error(
        `Channel field "${path}" declares duplicate option values.`
      );
    }
    if (field.default !== void 0 && !field.options.some((option) => option.value === field.default)) {
      throw new Error(
        `Channel field "${path}" declares a default that is not one of its options.`
      );
    }
  }
  if (field.kind !== "object") return;
  if (required) {
    throw new Error(`Channel field "${path}" cannot be a required object.`);
  }
  if (!Array.isArray(field.properties)) {
    throw new Error(`Channel field "${path}" must declare a properties array.`);
  }
  if (field.properties.length === 0) {
    throw new Error(
      `Channel field "${path}" must declare at least one property.`
    );
  }
  assertManagementFields(field.properties, path, true);
}
__name(assertManagementField, "assertManagementField");
function assertManagementDescriptor(plugin) {
  const management = plugin.management;
  if (management === void 0) return;
  const defaultSessionScope = plugin.defaultSessionScope ?? "user";
  if (!SESSION_SCOPE_OPTIONS.some(
    (option) => option.value === defaultSessionScope
  )) {
    throw new Error("Channel defaultSessionScope is invalid.");
  }
  if (management.validateConfig !== void 0 && (typeof management.validateConfig !== "function" || management.validateConfig.constructor.name === "AsyncFunction")) {
    throw new Error(
      "Channel management metadata must declare validateConfig as a synchronous function."
    );
  }
  if (!Array.isArray(management.fields)) {
    throw new Error("Channel management metadata must declare a fields array.");
  }
  assertManagementFields(management.fields);
  const sessionScopeField = management.fields.find(
    (field) => field.key === "sessionScope"
  );
  if (sessionScopeField) {
    if (sessionScopeField.kind !== "enum") {
      throw new Error('Channel field "sessionScope" must be an enum.');
    }
    if (!sessionScopeField.options?.some(
      (option) => option.value === defaultSessionScope
    )) {
      throw new Error(
        'Channel field "sessionScope" must include the channel defaultSessionScope.'
      );
    }
  }
}
__name(assertManagementDescriptor, "assertManagementDescriptor");
function ensureBuiltins() {
  if (!builtinsPromise) {
    builtinsPromise = (async () => {
      const labelled = [
        { name: "telegram", promise: import("./dist-I6D6XOWV.js") },
        { name: "weixin", promise: import("./dist-VA4LREAQ.js") },
        { name: "dingtalk", promise: import("./dist-CXDHIHN4.js") },
        { name: "dws", promise: import("./dist-4P3ZJYGI.js") },
        { name: "wecom", promise: import("./dist-XDRTR4QP.js") },
        { name: "feishu", promise: import("./dist-VIKOMAGG.js") },
        { name: "qqbot", promise: import("./dist-CESMUYGN.js") },
        { name: "github", promise: import("./dist-DBBOFWSC.js") },
        { name: "gitlab", promise: import("./dist-7MGRENQ5.js") }
      ];
      const results = await Promise.allSettled(labelled.map((l) => l.promise));
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          registerWithManagementValidation(
            result.value.plugin,
            labelled[i].name
          );
        } else {
          process.stderr.write(
            `[channel-registry] Failed to load "${labelled[i].name}" channel: ${result.reason}
`
          );
        }
      }
    })();
  }
  return builtinsPromise;
}
__name(ensureBuiltins, "ensureBuiltins");
function registerPlugin(plugin) {
  if (registry.has(plugin.channelType)) {
    throw new Error(
      `Channel type "${plugin.channelType}" is already registered.`
    );
  }
  registerWithManagementValidation(plugin, plugin.channelType);
}
__name(registerPlugin, "registerPlugin");
function registerWithManagementValidation(plugin, label) {
  try {
    assertManagementDescriptor(plugin);
  } catch (error) {
    process.stderr.write(
      `[channel-registry] Invalid management metadata in "${label}" channel: ${error instanceof Error ? error.message : String(error)}
`
    );
    const stripped = Object.assign(
      Object.create(
        Object.getPrototypeOf(plugin) ?? Object.prototype
      ),
      plugin
    );
    Object.defineProperty(stripped, "management", {
      value: void 0,
      writable: true,
      enumerable: true,
      configurable: true
    });
    registry.set(plugin.channelType, stripped);
    return;
  }
  registry.set(plugin.channelType, plugin);
}
__name(registerWithManagementValidation, "registerWithManagementValidation");
async function getPlugin(channelType) {
  await ensureBuiltins();
  return registry.get(channelType);
}
__name(getPlugin, "getPlugin");
async function supportedTypes() {
  await ensureBuiltins();
  return [...registry.keys()];
}
__name(supportedTypes, "supportedTypes");
async function supportedChannelCatalog() {
  await ensureBuiltins();
  return [...registry.values()].map(
    ({
      channelType,
      displayName,
      management,
      defaultSessionScope,
      supportsOutputMode
    }) => ({
      type: channelType,
      displayName,
      manageable: management !== void 0,
      fields: management ? managementFieldsWithSharedControls(
        management.fields,
        defaultSessionScope ?? "user",
        supportsOutputMode === true
      ) : []
    })
  );
}
__name(supportedChannelCatalog, "supportedChannelCatalog");

export {
  UNSAFE_OBJECT_KEYS,
  registerPlugin,
  getPlugin,
  supportedTypes,
  supportedChannelCatalog
};
