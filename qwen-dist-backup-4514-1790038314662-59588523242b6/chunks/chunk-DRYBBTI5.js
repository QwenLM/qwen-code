// Force strict mode and setup for ESM
"use strict";
import {
  customDeepMerge,
  getSettingsSchema
} from "./chunk-EP6WO7OX.js";
import {
  DEFAULT_DARK_THEME_NAME,
  DEFAULT_LIGHT_THEME_NAME
} from "./chunk-RKUWKYED.js";
import {
  CONSOLIDATED_DISABLE_KEYS,
  V1_INDICATOR_KEYS,
  V1_TO_V2_MIGRATION_MAP,
  V1_TO_V2_PRESERVE_DISABLE_MAP,
  V2_CONTAINER_KEYS
} from "./chunk-BW4333PP.js";
import {
  getSystemDefaultsPath,
  getSystemSettingsPath
} from "./chunk-IDS7MSUP.js";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  SUPPORTED_LANGUAGES,
  getLanguageNameFromLocale
} from "./chunk-5EJZE3FP.js";
import {
  getHomeEnvFallbackVars,
  loadEnvironment,
  preResolveHomeEnvOverrides
} from "./chunk-DJJJPHS3.js";
import {
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED
} from "./chunk-4VYTH6OF.js";
import {
  isWorkspaceTrusted,
  updateSettingsFilePreservingFormat
} from "./chunk-36RKQ7ZS.js";
import {
  require_strip_json_comments
} from "./chunk-NPQ5ZKRP.js";
import {
  resolveEnvVarsInObject
} from "./chunk-65I7S4Z3.js";
import {
  stripRuntimeSnapshotPrefix
} from "./chunk-TLS6QN2S.js";
import {
  Storage,
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  FatalConfigError,
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/settings.ts
init_esbuild_shims();
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import { homedir } from "node:os";
import process from "node:process";
var import_strip_json_comments = __toESM(require_strip_json_comments(), 1);

// packages/cli/src/config/modelProvidersScope.ts
init_esbuild_shims();
function hasOwnModelProviders(settingsObj) {
  if (!settingsObj || typeof settingsObj !== "object") {
    return false;
  }
  const obj = settingsObj;
  return Object.prototype.hasOwnProperty.call(obj, "modelProviders");
}
__name(hasOwnModelProviders, "hasOwnModelProviders");
function getModelProvidersOwnerScope(settings) {
  if (settings.isTrusted && hasOwnModelProviders(settings.workspace.settings)) {
    return "Workspace" /* Workspace */;
  }
  if (hasOwnModelProviders(settings.user.settings)) {
    return "User" /* User */;
  }
  return void 0;
}
__name(getModelProvidersOwnerScope, "getModelProvidersOwnerScope");
function getPersistScopeForModelSelection(settings) {
  return getModelProvidersOwnerScope(settings) ?? "User" /* User */;
}
__name(getPersistScopeForModelSelection, "getPersistScopeForModelSelection");
function getWritableScopes(settings) {
  return settings.isTrusted ? ["Workspace" /* Workspace */, "User" /* User */] : ["User" /* User */];
}
__name(getWritableScopes, "getWritableScopes");
function getOwnKeyScope(settings, key) {
  for (const scope of getWritableScopes(settings)) {
    const obj = settings.forScope(scope).settings;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return scope;
  }
  return void 0;
}
__name(getOwnKeyScope, "getOwnKeyScope");

// packages/cli/src/config/settingsUtils.ts
init_esbuild_shims();

// packages/cli/src/i18n/languageUtils.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
var LLM_OUTPUT_LANGUAGE_RULE_FILENAME = "output-language.md";
var LLM_OUTPUT_LANGUAGE_MARKER_PREFIX = "qwen-code:llm-output-language:";
var OUTPUT_LANGUAGE_AUTO = "auto";
function isAutoLanguage(value) {
  return !value || value.toLowerCase() === OUTPUT_LANGUAGE_AUTO;
}
__name(isAutoLanguage, "isAutoLanguage");
function normalizeOutputLanguage(language) {
  const normalized = language.trim().replace(/_/g, "-").toLowerCase();
  const knownLanguageName = SUPPORTED_LANGUAGES.find(
    (supportedLanguage) => supportedLanguage.fullName.toLowerCase() === normalized
  );
  if (knownLanguageName) {
    return knownLanguageName.fullName;
  }
  const knownLocaleCode = SUPPORTED_LANGUAGES.some((supportedLanguage) => {
    const code = supportedLanguage.code.toLowerCase();
    const id = supportedLanguage.id.toLowerCase();
    return normalized === code || normalized === id || normalized.startsWith(`${code}-`) || normalized.startsWith(`${id}-`) || normalized.startsWith(`${code}.`) || normalized.startsWith(`${id}.`) || normalized.startsWith(`${code}@`) || normalized.startsWith(`${id}@`);
  });
  if (!knownLocaleCode) {
    return language;
  }
  return getLanguageNameFromLocale(normalized);
}
__name(normalizeOutputLanguage, "normalizeOutputLanguage");
function resolveOutputLanguage(value) {
  if (isAutoLanguage(value)) {
    throw new Error(
      "resolveOutputLanguage does not accept auto; use resolveOutputLanguageOrPreserveAuto instead."
    );
  }
  return normalizeOutputLanguage(value);
}
__name(resolveOutputLanguage, "resolveOutputLanguage");
function resolveOutputLanguageOrPreserveAuto(value) {
  return isAutoLanguage(value) ? OUTPUT_LANGUAGE_AUTO : resolveOutputLanguage(value);
}
__name(resolveOutputLanguageOrPreserveAuto, "resolveOutputLanguageOrPreserveAuto");
function getOutputLanguageFilePath() {
  return path.join(
    Storage.getGlobalQwenDir(),
    LLM_OUTPUT_LANGUAGE_RULE_FILENAME
  );
}
__name(getOutputLanguageFilePath, "getOutputLanguageFilePath");
function sanitizeForMarker(language) {
  return language.replace(/[\r\n]/g, " ").replace(/--!?>/g, "").replace(/--/g, "");
}
__name(sanitizeForMarker, "sanitizeForMarker");
function generateOutputLanguageFileContent(language) {
  const safeLanguage = sanitizeForMarker(language);
  if (isAutoLanguage(language)) {
    return `# Output language preference: ${OUTPUT_LANGUAGE_AUTO}
<!-- ${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX} ${OUTPUT_LANGUAGE_AUTO} -->

## Rule
Respond in the same language as the user's input.

## Exception
If the user **explicitly** requests a response in a specific language (e.g., "please reply in English"), switch to the user's requested language for the remainder of the conversation.

## Mixed-language input
If the user mixes languages, use the language that best matches the user's main request.

## Keep technical artifacts unchanged
Do **not** translate or rewrite:
- Code blocks, CLI commands, file paths, stack traces, logs, JSON keys, identifiers
- Exact quoted text from the user (keep quotes verbatim)

## Tool / system outputs
Raw tool/system outputs may contain fixed-format English. Preserve them verbatim, and if needed, add a short explanation in the user's language below.
`;
  }
  return `# Output language preference: ${language}
<!-- ${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX} ${safeLanguage} -->

## Rule
You MUST always respond in **${language}** regardless of the user's input language.
This is a mandatory requirement, not a preference.

## Exception
If the user **explicitly** requests a response in a specific language (e.g., "please reply in English", "\u7528\u4E2D\u6587\u56DE\u7B54"), switch to the user's requested language for the remainder of the conversation.

## Keep technical artifacts unchanged
Do **not** translate or rewrite:
- Code blocks, CLI commands, file paths, stack traces, logs, JSON keys, identifiers
- Exact quoted text from the user (keep quotes verbatim)

## Tool / system outputs
Raw tool/system outputs may contain fixed-format English. Preserve them verbatim, and if needed, add a short **${language}** explanation below.
`;
}
__name(generateOutputLanguageFileContent, "generateOutputLanguageFileContent");
function parseOutputLanguageFromContent(content) {
  const markerRegex = new RegExp(
    String.raw`<!--\s*${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX}\s*(.*?)\s*-->`,
    "i"
  );
  const markerMatch = content.match(markerRegex);
  if (markerMatch?.[1]?.trim()) {
    return markerMatch[1].trim();
  }
  const headingMatch = content.match(
    /^#.*?CRITICAL:\s*(.*?)\s+Output Language Rule\b/im
  );
  if (headingMatch?.[1]?.trim()) {
    return headingMatch[1].trim();
  }
  return null;
}
__name(parseOutputLanguageFromContent, "parseOutputLanguageFromContent");
function readOutputLanguageFileContent() {
  const filePath = getOutputLanguageFilePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
__name(readOutputLanguageFileContent, "readOutputLanguageFileContent");
function isGeneratedFixedOutputLanguageFileContent(content, language) {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const headings = normalizedContent.match(/^#{1,2}\s+.+$/gm) ?? [];
  return normalizedContent.includes(
    `<!-- ${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX} ${sanitizeForMarker(language)} -->`
  ) && headings.length === 5 && headings[0] === `# Output language preference: ${language}` && headings.includes("## Rule") && headings.includes("## Exception") && headings.includes("## Keep technical artifacts unchanged") && headings.includes("## Tool / system outputs") && normalizedContent.includes(`**${language}**`) && normalizedContent.includes("You MUST always respond");
}
__name(isGeneratedFixedOutputLanguageFileContent, "isGeneratedFixedOutputLanguageFileContent");
function writeOutputLanguageFile(language, targetPath) {
  const filePath = targetPath ?? getOutputLanguageFilePath();
  const content = generateOutputLanguageFileContent(language);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}
__name(writeOutputLanguageFile, "writeOutputLanguageFile");
function updateOutputLanguageFile(settingValue, targetPath) {
  const resolved = resolveOutputLanguageOrPreserveAuto(settingValue);
  writeOutputLanguageFile(resolved, targetPath);
}
__name(updateOutputLanguageFile, "updateOutputLanguageFile");
function writeOutputLanguageAndRegisterPath(settingValue, config) {
  const targetPath = config?.getOutputLanguageFilePath();
  updateOutputLanguageFile(settingValue, targetPath);
  if (!targetPath) {
    config?.setOutputLanguageFilePath(getOutputLanguageFilePath());
  }
}
__name(writeOutputLanguageAndRegisterPath, "writeOutputLanguageAndRegisterPath");
function initializeLlmOutputLanguage(outputLanguage) {
  const currentFileContent = readOutputLanguageFileContent();
  const currentFileLanguage = currentFileContent === null ? null : parseOutputLanguageFromContent(currentFileContent);
  const shouldMigrateFixedFileToAuto = isAutoLanguage(outputLanguage) && currentFileLanguage !== null && !isAutoLanguage(currentFileLanguage) && currentFileContent !== null && isGeneratedFixedOutputLanguageFileContent(
    currentFileContent,
    currentFileLanguage
  );
  if (currentFileLanguage) {
    if (shouldMigrateFixedFileToAuto) {
      try {
        const resolved2 = resolveOutputLanguageOrPreserveAuto(outputLanguage);
        writeOutputLanguageFile(resolved2);
      } catch {
      }
    }
    return;
  }
  const resolved = resolveOutputLanguageOrPreserveAuto(outputLanguage);
  writeOutputLanguageFile(resolved);
}
__name(initializeLlmOutputLanguage, "initializeLlmOutputLanguage");

// packages/cli/src/config/settingsUtils.ts
function flattenSchema(schema, prefix = "") {
  let result = {};
  for (const key in schema) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    const definition = schema[key];
    result[newKey] = { ...definition, key: newKey };
    if (definition.properties) {
      result = { ...result, ...flattenSchema(definition.properties, newKey) };
    }
  }
  return result;
}
__name(flattenSchema, "flattenSchema");
var _FLATTENED_SCHEMA;
function getFlattenedSchema() {
  return _FLATTENED_SCHEMA ?? (_FLATTENED_SCHEMA = flattenSchema(getSettingsSchema()));
}
__name(getFlattenedSchema, "getFlattenedSchema");
function getSettingDefinition(key) {
  return getFlattenedSchema()[key];
}
__name(getSettingDefinition, "getSettingDefinition");
function requiresRestart(key) {
  return getFlattenedSchema()[key]?.requiresRestart ?? false;
}
__name(requiresRestart, "requiresRestart");
function getDefaultValue(key) {
  return getFlattenedSchema()[key]?.default;
}
__name(getDefaultValue, "getDefaultValue");
function getNestedValue(obj, path3) {
  const [first, ...rest] = path3;
  if (!first || !(first in obj)) {
    return void 0;
  }
  const value = obj[first];
  if (rest.length === 0) {
    return value;
  }
  if (value && typeof value === "object" && value !== null) {
    return getNestedValue(value, rest);
  }
  return void 0;
}
__name(getNestedValue, "getNestedValue");
function getNestedProperty(obj, path3) {
  return getNestedValue(obj, path3.split("."));
}
__name(getNestedProperty, "getNestedProperty");
function getEffectiveValue(key, settings, mergedSettings) {
  const definition = getSettingDefinition(key);
  if (!definition) {
    return void 0;
  }
  const path3 = key.split(".");
  let value = getNestedValue(settings, path3);
  if (value !== void 0) {
    return value;
  }
  value = getNestedValue(mergedSettings, path3);
  if (value !== void 0) {
    return value;
  }
  return definition.default;
}
__name(getEffectiveValue, "getEffectiveValue");
function getAllSettingKeys() {
  return Object.keys(getFlattenedSchema());
}
__name(getAllSettingKeys, "getAllSettingKeys");
var SETTINGS_DIALOG_ORDER = [
  // Workflow Control - most impactful setting
  "tools.approvalMode",
  "tools.codeModeOnly",
  // Localization - users often set this first
  "general.language",
  "general.outputLanguage",
  // Theme
  "ui.theme",
  // Editor/Shell Experience
  "general.vimMode",
  "tools.shell.enableInteractiveShell",
  // Display Preferences
  "general.preferredEditor",
  "ide.enabled",
  "ui.showLineNumbers",
  "ui.hideTips",
  "ui.showToolCallDetails",
  "general.terminalBell",
  "ui.enableWelcomeBack",
  // Git Behavior
  "general.gitCoAuthor.commit",
  "general.gitCoAuthor.pr",
  // File Filtering
  "context.fileFiltering.respectGitIgnore",
  "context.fileFiltering.respectQwenIgnore",
  // System Settings - rarely changed
  "general.disableAutoUpdate",
  // Privacy
  "privacy.usageStatisticsEnabled"
];
var MAX_SETTING_STRING_VALUE_LENGTH = 1024;
function validateSettingValue(def, value) {
  switch (def.type) {
    case "boolean":
      if (typeof value !== "boolean") return "Value must be a boolean";
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return "Value must be a finite number";
      if (def.minimum !== void 0 && value < def.minimum)
        return `Value must be >= ${def.minimum}`;
      if (def.maximum !== void 0 && value > def.maximum)
        return `Value must be <= ${def.maximum}`;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value))
        return "Value must be a finite integer";
      if (!Number.isInteger(value)) return "Value must be an integer";
      if (def.minimum !== void 0 && value < def.minimum)
        return `Value must be >= ${def.minimum}`;
      if (def.maximum !== void 0 && value > def.maximum)
        return `Value must be <= ${def.maximum}`;
      break;
    case "string":
      if (typeof value !== "string") return "Value must be a string";
      if (value.length > MAX_SETTING_STRING_VALUE_LENGTH)
        return `Value exceeds ${MAX_SETTING_STRING_VALUE_LENGTH}-character limit`;
      break;
    case "enum":
      if (!def.options?.some((opt) => opt.value === value)) {
        const allowed = def.options?.map((o) => o.value).join(", ") ?? "";
        return `Value must be one of: ${allowed}`;
      }
      break;
    case "object":
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return "Value must be an object";
      }
      break;
    default:
      return `Settings of type '${def.type}' cannot be modified via this API`;
  }
  if ((typeof value === "string" || typeof value === "number") && // `includes` is SameValueZero, so a `[0]` exclusion also catches the `-0`
  // that `Number('-0')` produces and `JSON.stringify` would persist as `0`.
  def.excludedValues?.includes(value)) {
    return `Value must not be ${String(value)}`;
  }
  return void 0;
}
__name(validateSettingValue, "validateSettingValue");
var WORKSPACE_RESTRICTED_SETTINGS = [
  { section: "tools", key: "workflowsEnabled" },
  { section: "security", key: "allowPrivateNetworkHooks" },
  { section: "security", key: "allowedInsecureVoiceBaseUrls" },
  { section: "goals", key: "modelProposed" },
  { section: "outboundCorrelation", key: "allowDynamicHeaderValues" }
];
var WORKSPACE_TIGHTEN_ONLY_SETTINGS = [
  {
    section: "tools",
    key: "workflowNameOnly",
    // Only `true` turns the lock on; anything else leaves the model free to
    // run scripts, so it ranks with unset.
    strictness: /* @__PURE__ */ __name((value) => value === true ? 1 : 0, "strictness")
  },
  {
    section: "agents",
    key: "crossSessionMessaging",
    // Unset means on — the default — so it ranks with `true`. Anything the
    // reader does not recognize keeps the socket closed, like `false`.
    strictness: /* @__PURE__ */ __name((value) => value === true || value === void 0 ? 0 : 1, "strictness")
  },
  {
    section: "agents",
    key: "crossSessionInbound",
    // Unset means approval-mode parity, which delivers some messages and
    // holds others: looser than `hold`, stricter than `accept`.
    strictness: /* @__PURE__ */ __name((value) => value === "accept" ? 0 : value === void 0 ? 1 : value === "hold" ? 2 : value === "refuse" ? 3 : 2, "strictness")
  }
];
var WORKSPACE_RESTRICTED_SETTING_KEYS = WORKSPACE_RESTRICTED_SETTINGS.map(({ section, key }) => `${section}.${key}`);
var WORKSPACE_NON_OVERRIDING_SETTINGS = [
  { section: "security", key: "allowedHttpHookUrls" }
];
function getDialogSettingKeys(options) {
  const dialogSettings = Object.values(getFlattenedSchema()).filter((definition) => definition.showInDialog === true).map((definition) => definition.key).filter(
    (key) => !options?.excludeWorkspaceRestricted || !WORKSPACE_RESTRICTED_SETTING_KEYS.includes(key)
  );
  return dialogSettings.sort((a, b) => {
    const indexA = SETTINGS_DIALOG_ORDER.indexOf(a);
    const indexB = SETTINGS_DIALOG_ORDER.indexOf(b);
    if (indexA !== -1 && indexB !== -1) {
      return indexA - indexB;
    }
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return 0;
  });
}
__name(getDialogSettingKeys, "getDialogSettingKeys");
function settingExistsInScope(key, scopeSettings) {
  const path3 = key.split(".");
  const value = getNestedValue(scopeSettings, path3);
  return value !== void 0;
}
__name(settingExistsInScope, "settingExistsInScope");
function settingPathExists(key, settings) {
  let current = settings;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return false;
    }
    current = current[segment];
  }
  return true;
}
__name(settingPathExists, "settingPathExists");
function pathHasUnsafeSegment(keys) {
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return true;
    }
  }
  return false;
}
__name(pathHasUnsafeSegment, "pathHasUnsafeSegment");
function setNestedPropertyForce(obj, path3, value) {
  const keys = path3.split(".");
  if (pathHasUnsafeSegment(keys)) return;
  const lastKey = keys.pop();
  if (!lastKey) return;
  let current = obj;
  for (const key of keys) {
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }
  current[lastKey] = value;
}
__name(setNestedPropertyForce, "setNestedPropertyForce");
function setNestedPropertySafe(obj, path3, value) {
  const keys = path3.split(".");
  if (pathHasUnsafeSegment(keys)) return;
  const lastKey = keys.pop();
  if (!lastKey) return;
  let current = obj;
  for (const key of keys) {
    if (current[key] === void 0) {
      current[key] = {};
    }
    const next = current[key];
    if (typeof next === "object" && next !== null) {
      current = next;
    } else {
      return;
    }
  }
  current[lastKey] = value;
}
__name(setNestedPropertySafe, "setNestedPropertySafe");
function deleteNestedPropertySafe(obj, path3) {
  const keys = path3.split(".");
  const lastKey = keys.pop();
  if (!lastKey) return;
  let current = obj;
  for (const key of keys) {
    const next = current[key];
    if (typeof next !== "object" || next === null) {
      return;
    }
    current = next;
  }
  delete current[lastKey];
}
__name(deleteNestedPropertySafe, "deleteNestedPropertySafe");
function setPendingSettingValue(key, value, pendingSettings) {
  const newSettings = JSON.parse(JSON.stringify(pendingSettings));
  setNestedPropertyForce(newSettings, key, value);
  return newSettings;
}
__name(setPendingSettingValue, "setPendingSettingValue");
function setPendingSettingValueAny(key, value, pendingSettings) {
  const newSettings = structuredClone(pendingSettings);
  setNestedPropertyForce(newSettings, key, value);
  return newSettings;
}
__name(setPendingSettingValueAny, "setPendingSettingValueAny");
function getRestartRequiredFromModified(modifiedSettings) {
  return Array.from(modifiedSettings).filter((key) => requiresRestart(key));
}
__name(getRestartRequiredFromModified, "getRestartRequiredFromModified");
function saveModifiedSettings(modifiedSettings, pendingSettings, loadedSettings, scope) {
  modifiedSettings.forEach((settingKey) => {
    const path3 = settingKey.split(".");
    const value = getNestedValue(
      pendingSettings,
      path3
    );
    const existsInOriginalFile = settingExistsInScope(
      settingKey,
      loadedSettings.forScope(scope).settings
    );
    if (value === void 0) {
      if (existsInOriginalFile) {
        loadedSettings.setValue(scope, settingKey, void 0);
      }
      return;
    }
    const isDefaultValue2 = value === getDefaultValue(settingKey);
    if (existsInOriginalFile || !isDefaultValue2) {
      loadedSettings.setValue(scope, settingKey, value);
    }
  });
}
__name(saveModifiedSettings, "saveModifiedSettings");
function getDisplayValue(key, settings, _mergedSettings, modifiedSettings, pendingSettings) {
  const definition = getSettingDefinition(key);
  let value;
  if (pendingSettings && settingPathExists(key, pendingSettings)) {
    value = getEffectiveValue(key, pendingSettings, {});
  } else if (settingExistsInScope(key, settings)) {
    value = getEffectiveValue(key, settings, {});
  } else {
    value = getDefaultValue(key);
  }
  let valueString = value === void 0 ? t("(not set)") : String(value);
  if (key === "general.outputLanguage" && isAutoLanguage(value)) {
    valueString = t("Auto (follow user input)");
  } else if (value !== void 0 && definition?.type === "enum" && definition.options) {
    const option = definition.options?.find((option2) => option2.value === value);
    if (option?.label) {
      valueString = t(option.label) || option.label;
    } else {
      valueString = `${value}`;
    }
  }
  const defaultValue = getDefaultValue(key);
  const isChangedFromDefault = value !== defaultValue;
  const isInModifiedSettings = modifiedSettings.has(key);
  if (settingExistsInScope(key, settings) || isInModifiedSettings) {
    return `${valueString}*`;
  }
  if (isChangedFromDefault || isInModifiedSettings) {
    return `${valueString}*`;
  }
  return valueString;
}
__name(getDisplayValue, "getDisplayValue");
function nextBooleanSettingValue(currentValue, defaultValue) {
  if (currentValue !== void 0) return !currentValue;
  return defaultValue === void 0 ? false : !defaultValue;
}
__name(nextBooleanSettingValue, "nextBooleanSettingValue");
function isDefaultValue(key, settings) {
  return !settingExistsInScope(key, settings);
}
__name(isDefaultValue, "isDefaultValue");

// packages/cli/src/config/migration/index.ts
init_esbuild_shims();

// packages/cli/src/config/migration/scheduler.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("SETTINGS_MIGRATION");
function formatScope(scope) {
  if (scope === "SystemDefaults") {
    return "system default";
  }
  return scope.toLowerCase();
}
__name(formatScope, "formatScope");
var MigrationScheduler = class {
  /**
   * Creates a new MigrationScheduler with the given migrations.
   *
   * @param migrations - Array of migrations in execution order (typically ascending version)
   * @param scope - The scope of settings being migrated
   */
  constructor(migrations, scope) {
    this.migrations = migrations;
    this.scope = scope;
  }
  static {
    __name(this, "MigrationScheduler");
  }
  /**
   * Executes the migration chain on the given settings.
   *
   * Iterates through all registered migrations in order. For each migration:
   * 1. Calls `shouldMigrate` with the current settings
   * 2. If true, calls `migrate` to transform the settings
   * 3. Records the execution
   *
   * The scheduler itself has no version awareness - all version detection
   * is delegated to the individual migrations.
   *
   * @param settings - The settings object to migrate
   * @returns MigrationResult containing the final settings, version, and execution log
   */
  migrate(settings) {
    debugLogger.debug("MigrationScheduler: Starting migration chain");
    let current = settings;
    const executed = [];
    const allWarnings = [];
    for (const migration of this.migrations) {
      try {
        if (migration.shouldMigrate(current)) {
          debugLogger.debug(
            `MigrationScheduler: Executing migration ${migration.fromVersion} \u2192 ${migration.toVersion}`
          );
          const formattedScope = formatScope(this.scope);
          const result = migration.migrate(current, formattedScope);
          current = result.settings;
          allWarnings.push(...result.warnings);
          executed.push({
            fromVersion: migration.fromVersion,
            toVersion: migration.toVersion
          });
          debugLogger.debug(
            `MigrationScheduler: Migration ${migration.fromVersion} \u2192 ${migration.toVersion} completed successfully`
          );
        }
      } catch (error) {
        debugLogger.error(
          `MigrationScheduler: Migration ${migration.fromVersion} \u2192 ${migration.toVersion} failed:`,
          error
        );
        throw error;
      }
    }
    const finalVersion = current["$version"] ?? 1;
    debugLogger.debug(
      `MigrationScheduler: Migration chain complete. Final version: ${finalVersion}, Executed: ${executed.length} migrations`
    );
    return {
      settings: current,
      finalVersion,
      executedMigrations: executed,
      warnings: allWarnings
    };
  }
};

// packages/cli/src/config/migration/versions/v1-to-v2.ts
init_esbuild_shims();
var V1ToV2Migration = class {
  static {
    __name(this, "V1ToV2Migration");
  }
  fromVersion = 1;
  toVersion = 2;
  /**
   * Determines whether this migration should execute.
   *
   * Decision strategy:
   * - Hard-stop when `$version` is a number >= 2 (already V2+).
   * - Otherwise, scan indicator keys and trigger only when at least one indicator is
   *   still in legacy top-level shape (primitive/array/null).
   *
   * Mixed-shape tolerance:
   * - Files that are partially migrated are supported; V2-like object-valued indicators
   *   are ignored while legacy-shaped indicators can still trigger migration.
   */
  shouldMigrate(settings) {
    if (typeof settings !== "object" || settings === null) {
      return false;
    }
    const s = settings;
    const version = s["$version"];
    if (typeof version === "number" && version >= 2) {
      return false;
    }
    return V1_INDICATOR_KEYS.some((key) => {
      if (!(key in s)) {
        return false;
      }
      const value = s[key];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return false;
      }
      return true;
    });
  }
  /**
   * Performs non-destructive V1 -> V2 transformation.
   *
   * Detailed strategy:
   * 1) Relocate known V1 keys using `V1_TO_V2_MIGRATION_MAP`.
   *    - If a source value is already an object and maps to a child path of itself
   *      (partial V2 shape), merge child properties into target path.
   * 2) Relocate disable* keys into V2 disable* locations.
   *    - Consolidated keys (`disableAutoUpdate`, `disableUpdateNag`): normalize to
   *      boolean with stable-compatible presence semantics (`value === true`).
   *    - Other disable* keys: migrate only boolean values.
   * 3) Preserve `mcpServers` top-level placement.
   * 4) Carry over remaining keys:
   *    - If a key is parent of migrated nested paths, merge unprocessed object children.
   *    - If parent value is non-object, preserve that scalar/array/null as-is.
   *    - Otherwise copy untouched key/value.
   * 5) Stamp `$version = 2`.
   *
   * The method is pure with respect to input mutation.
   */
  migrate(settings, _scope) {
    if (typeof settings !== "object" || settings === null) {
      throw new Error("Settings must be an object");
    }
    const source = settings;
    const result = {};
    const processedKeys = /* @__PURE__ */ new Set();
    const warnings = [];
    for (const [v1Key, v2Path] of Object.entries(V1_TO_V2_MIGRATION_MAP)) {
      if (v1Key in source) {
        const value = source[v1Key];
        if (V2_CONTAINER_KEYS.has(v1Key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
          result[v1Key] = value;
          processedKeys.add(v1Key);
          continue;
        }
        if (typeof value === "object" && value !== null && !Array.isArray(value) && v2Path.startsWith(v1Key + ".")) {
          for (const [nestedKey, nestedValue] of Object.entries(value)) {
            setNestedPropertySafe(
              result,
              `${v2Path}.${nestedKey}`,
              nestedValue
            );
          }
        } else {
          setNestedPropertySafe(result, v2Path, value);
        }
        processedKeys.add(v1Key);
      }
    }
    for (const [v1Key, v2Path] of Object.entries(
      V1_TO_V2_PRESERVE_DISABLE_MAP
    )) {
      if (v1Key in source) {
        const value = source[v1Key];
        if (CONSOLIDATED_DISABLE_KEYS.has(v1Key)) {
          setNestedPropertySafe(result, v2Path, value === true);
        } else if (typeof value === "boolean") {
          setNestedPropertySafe(result, v2Path, value);
        }
        processedKeys.add(v1Key);
      }
    }
    if ("mcpServers" in source) {
      result["mcpServers"] = source["mcpServers"];
      processedKeys.add("mcpServers");
    }
    for (const key of Object.keys(source)) {
      if (!processedKeys.has(key)) {
        const isParentOfMigratedPath = Array.from(processedKeys).some(
          (processedKey) => {
            const v2Path = V1_TO_V2_MIGRATION_MAP[processedKey] || V1_TO_V2_PRESERVE_DISABLE_MAP[processedKey];
            if (!v2Path) return false;
            return v2Path.startsWith(key + ".");
          }
        );
        if (isParentOfMigratedPath) {
          const existingValue = source[key];
          if (typeof existingValue === "object" && existingValue !== null && !Array.isArray(existingValue)) {
            for (const [nestedKey, nestedValue] of Object.entries(
              existingValue
            )) {
              const fullNestedPath = `${key}.${nestedKey}`;
              const wasProcessed = Array.from(processedKeys).some(
                (processedKey) => {
                  const v2Path = V1_TO_V2_MIGRATION_MAP[processedKey] || V1_TO_V2_PRESERVE_DISABLE_MAP[processedKey];
                  return v2Path === fullNestedPath;
                }
              );
              if (!wasProcessed) {
                setNestedPropertySafe(result, fullNestedPath, nestedValue);
              }
            }
          } else {
            result[key] = source[key];
          }
        } else {
          result[key] = source[key];
        }
      }
    }
    result["$version"] = 2;
    return { settings: result, warnings };
  }
};
var v1ToV2Migration = new V1ToV2Migration();

// packages/cli/src/config/migration/versions/v2-to-v3.ts
init_esbuild_shims();
var V2_TO_V3_BOOLEAN_MAP = {
  "general.disableAutoUpdate": "general.enableAutoUpdate",
  "general.disableUpdateNag": "general.enableAutoUpdate",
  "ui.accessibility.disableLoadingPhrases": "ui.accessibility.enableLoadingPhrases",
  "context.fileFiltering.disableFuzzySearch": "context.fileFiltering.enableFuzzySearch",
  "model.generationConfig.disableCacheControl": "model.generationConfig.enableCacheControl"
};
var CONSOLIDATED_V2_PATHS = {
  "general.enableAutoUpdate": [
    "general.disableAutoUpdate",
    "general.disableUpdateNag"
  ]
};
function normalizeDisableValue(value) {
  if (value === void 0) {
    return { isPresent: false, isValid: false };
  }
  if (typeof value === "boolean") {
    return { isPresent: true, isValid: true, booleanValue: value };
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return { isPresent: true, isValid: true, booleanValue: true };
    }
    if (normalized === "false") {
      return { isPresent: true, isValid: true, booleanValue: false };
    }
  }
  return { isPresent: true, isValid: false };
}
__name(normalizeDisableValue, "normalizeDisableValue");
var V2ToV3Migration = class {
  static {
    __name(this, "V2ToV3Migration");
  }
  fromVersion = 2;
  toVersion = 3;
  /**
   * Migration trigger rule.
   *
   * Execute only when `$version === 2`.
   * This includes V2 files with no migratable disable* booleans so that version
   * metadata still advances to 3.
   */
  shouldMigrate(settings) {
    if (typeof settings !== "object" || settings === null) {
      return false;
    }
    const s = settings;
    return s["$version"] === 2;
  }
  /**
   * Applies V2 -> V3 transformation with deterministic deprecated-key cleanup.
   *
   * Detailed strategy:
   * 1) Clone input.
   * 2) Process consolidated paths first:
   *    - Inspect each source path.
   *    - Normalize each present value (boolean / coercible string / invalid).
   *    - Always delete present deprecated source key.
   *    - Valid normalized values contribute to aggregate.
   *    - Invalid values emit warnings.
   *    - Emit consolidated target when at least one valid source was consumed.
   * 3) Process remaining one-to-one mappings:
   *    - For each unmapped source, normalize value.
   *    - If valid -> delete old key and write inverted target.
   *    - If invalid -> delete old key and emit warning.
   * 4) Set `$version = 3`.
   *
   * Guarantees:
   * - Input object is not mutated.
   * - Valid migration and invalid cleanup are deterministic.
   * - Deprecated disable* keys are not retained after migration.
   */
  migrate(settings, scope) {
    if (typeof settings !== "object" || settings === null) {
      throw new Error("Settings must be an object");
    }
    const result = structuredClone(settings);
    const processedPaths = /* @__PURE__ */ new Set();
    const warnings = [];
    for (const [newPath, oldPaths] of Object.entries(CONSOLIDATED_V2_PATHS)) {
      let hasAnyDisable = false;
      let hasAnyBooleanValue = false;
      for (const oldPath of oldPaths) {
        const oldValue = getNestedProperty(result, oldPath);
        const normalized = normalizeDisableValue(oldValue);
        if (!normalized.isPresent) {
          continue;
        }
        deleteNestedPropertySafe(result, oldPath);
        processedPaths.add(oldPath);
        if (normalized.isValid) {
          hasAnyBooleanValue = true;
          if (normalized.booleanValue === true) {
            hasAnyDisable = true;
          }
        } else {
          warnings.push(
            `Removed deprecated setting '${oldPath}' from ${scope} settings because the value is invalid. Expected boolean.`
          );
        }
      }
      if (hasAnyBooleanValue) {
        setNestedPropertySafe(result, newPath, !hasAnyDisable);
      }
    }
    for (const [oldPath, newPath] of Object.entries(V2_TO_V3_BOOLEAN_MAP)) {
      if (processedPaths.has(oldPath)) {
        continue;
      }
      const oldValue = getNestedProperty(result, oldPath);
      const normalized = normalizeDisableValue(oldValue);
      if (!normalized.isPresent) {
        continue;
      }
      deleteNestedPropertySafe(result, oldPath);
      if (normalized.isValid) {
        setNestedPropertySafe(result, newPath, !normalized.booleanValue);
      } else {
        warnings.push(
          `Removed deprecated setting '${oldPath}' from ${scope} settings because the value is invalid. Expected boolean or string "true"/"false".`
        );
      }
    }
    result["$version"] = 3;
    return { settings: result, warnings };
  }
};
var v2ToV3Migration = new V2ToV3Migration();

// packages/cli/src/config/migration/versions/v3-to-v4.ts
init_esbuild_shims();
var GIT_CO_AUTHOR_PATH = "general.gitCoAuthor";
var V3ToV4Migration = class {
  static {
    __name(this, "V3ToV4Migration");
  }
  fromVersion = 3;
  toVersion = 4;
  shouldMigrate(settings) {
    if (typeof settings !== "object" || settings === null) {
      return false;
    }
    const s = settings;
    if (s["$version"] === 3) {
      return true;
    }
    if (s["$version"] === void 0) {
      const value = getNestedProperty(s, GIT_CO_AUTHOR_PATH);
      if (value === void 0) return false;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return false;
      }
      return true;
    }
    return false;
  }
  migrate(settings, scope) {
    if (typeof settings !== "object" || settings === null) {
      throw new Error("Settings must be an object");
    }
    const result = structuredClone(settings);
    const warnings = [];
    const value = getNestedProperty(result, GIT_CO_AUTHOR_PATH);
    if (typeof value === "boolean") {
      setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
        commit: value,
        pr: value
      });
    } else if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      const disableIntent = ["false", "no", "off", "0", "disabled", ""];
      const enableIntent = ["true", "yes", "on", "1", "enabled"];
      if (enableIntent.includes(lowered)) {
        setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
          commit: true,
          pr: true
        });
      } else if (disableIntent.includes(lowered)) {
        setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
          commit: false,
          pr: false
        });
      } else {
        setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
          commit: false,
          pr: false
        });
        warnings.push(
          `Reset '${GIT_CO_AUTHOR_PATH}' in ${scope} settings to {commit: false, pr: false} because the stored string '${value}' was not a recognized boolean form.`
        );
      }
    } else if (value !== void 0 && (typeof value !== "object" || value === null || Array.isArray(value))) {
      setNestedPropertySafe(result, GIT_CO_AUTHOR_PATH, {
        commit: false,
        pr: false
      });
      warnings.push(
        `Reset '${GIT_CO_AUTHOR_PATH}' in ${scope} settings to {commit: false, pr: false} because the stored value was not a boolean or object.`
      );
    }
    result["$version"] = 4;
    return { settings: result, warnings };
  }
};
var v3ToV4Migration = new V3ToV4Migration();

// packages/cli/src/config/migration/versions/v5-to-v4.ts
init_esbuild_shims();
var PROVIDER_KEY_TO_PROTOCOL = {
  openai: "openai",
  "qwen-oauth": "qwen-oauth",
  gemini: "gemini",
  "vertex-ai": "gemini",
  anthropic: "anthropic"
};
function isWrappedProviderConfig(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isWrappedProviderConfig, "isWrappedProviderConfig");
var V5ToV4Migration = class {
  static {
    __name(this, "V5ToV4Migration");
  }
  fromVersion = 5;
  toVersion = 4;
  shouldMigrate(settings) {
    if (typeof settings !== "object" || settings === null) {
      return false;
    }
    const s = settings;
    if (s["$version"] === 5) {
      return true;
    }
    if (s["$version"] !== void 0) {
      return false;
    }
    const modelProviders = s["modelProviders"];
    if (typeof modelProviders !== "object" || modelProviders === null) {
      return false;
    }
    return Object.values(modelProviders).some(
      (v) => isWrappedProviderConfig(v)
    );
  }
  migrate(settings, _scope) {
    if (typeof settings !== "object" || settings === null) {
      throw new Error("Settings must be an object");
    }
    const result = structuredClone(settings);
    const warnings = [];
    const modelProviders = result["modelProviders"];
    if (typeof modelProviders === "object" && modelProviders !== null) {
      const providers = modelProviders;
      for (const [key, value] of Object.entries(providers)) {
        if (Array.isArray(value)) {
          continue;
        }
        if (!isWrappedProviderConfig(value)) {
          continue;
        }
        const derivedProtocol = Object.hasOwn(PROVIDER_KEY_TO_PROTOCOL, key) ? PROVIDER_KEY_TO_PROTOCOL[key] : void 0;
        if (typeof value.protocol === "string" && derivedProtocol !== void 0 && value.protocol !== derivedProtocol) {
          warnings.push(
            `Provider "${key}" declared protocol "${value.protocol}", but V4 derives protocol "${derivedProtocol}" from the provider key. The explicit protocol has been dropped.`
          );
        }
        providers[key] = Array.isArray(value.models) ? value.models : [];
      }
    }
    result["$version"] = 4;
    return { settings: result, warnings };
  }
};
var v5ToV4Migration = new V5ToV4Migration();

// packages/cli/src/config/migration/index.ts
var ALL_MIGRATIONS = [
  v1ToV2Migration,
  v2ToV3Migration,
  v3ToV4Migration
];
var DOWNGRADE_MIGRATIONS = [v5ToV4Migration];
var CONVERGENCE_MIGRATIONS = [
  ...ALL_MIGRATIONS,
  ...DOWNGRADE_MIGRATIONS
];
function runMigrations(settings, scope) {
  const scheduler = new MigrationScheduler([...CONVERGENCE_MIGRATIONS], scope);
  return scheduler.migrate(settings);
}
__name(runMigrations, "runMigrations");
function needsMigration(settings) {
  if (typeof settings !== "object" || settings === null) {
    return false;
  }
  const s = settings;
  const version = s["$version"];
  const hasApplicableMigration = CONVERGENCE_MIGRATIONS.some(
    (migration) => migration.shouldMigrate(settings)
  );
  if (typeof version === "number") {
    if (version === SETTINGS_VERSION) {
      return false;
    }
    return hasApplicableMigration;
  }
  return hasApplicableMigration;
}
__name(needsMigration, "needsMigration");

// packages/cli/src/config/settings.ts
var debugLogger2 = createDebugLogger("SETTINGS");
function getMergeStrategyForPath(path3) {
  let current = void 0;
  let currentSchema = getSettingsSchema();
  for (const key of path3) {
    if (!currentSchema || !currentSchema[key]) {
      return void 0;
    }
    current = currentSchema[key];
    currentSchema = current.properties;
  }
  return current?.mergeStrategy;
}
__name(getMergeStrategyForPath, "getMergeStrategyForPath");
function getUserSettingsPath() {
  return Storage.getGlobalSettingsPath();
}
__name(getUserSettingsPath, "getUserSettingsPath");
function getUserSettingsDir() {
  return path2.dirname(getUserSettingsPath());
}
__name(getUserSettingsDir, "getUserSettingsDir");
var SETTINGS_VERSION = 4;
var SETTINGS_VERSION_KEY = "$version";
function migrateLegacyPermissions(settings) {
  const tools = settings["tools"];
  if (!tools) return null;
  const hasLegacy = Array.isArray(tools["core"]) || Array.isArray(tools["allowed"]) || Array.isArray(tools["exclude"]);
  if (!hasLegacy) return null;
  const result = structuredClone(settings);
  const resultTools = result["tools"];
  const permissions = result["permissions"] ?? {};
  result["permissions"] = permissions;
  const mergeInto = /* @__PURE__ */ __name((key, items) => {
    const existing = Array.isArray(permissions[key]) ? permissions[key] : [];
    const merged = Array.from(/* @__PURE__ */ new Set([...existing, ...items]));
    permissions[key] = merged;
  }, "mergeInto");
  if (Array.isArray(resultTools["allowed"])) {
    mergeInto("allow", resultTools["allowed"]);
    delete resultTools["allowed"];
  }
  if (Array.isArray(resultTools["exclude"])) {
    mergeInto("deny", resultTools["exclude"]);
    delete resultTools["exclude"];
  }
  if (Array.isArray(resultTools["core"])) {
    mergeInto("allow", resultTools["core"]);
    delete resultTools["core"];
  }
  return result;
}
__name(migrateLegacyPermissions, "migrateLegacyPermissions");
var SettingScope = /* @__PURE__ */ ((SettingScope2) => {
  SettingScope2["User"] = "User";
  SettingScope2["Workspace"] = "Workspace";
  SettingScope2["System"] = "System";
  SettingScope2["SystemDefaults"] = "SystemDefaults";
  return SettingScope2;
})(SettingScope || {});
function getSettingsFileKeyWarnings(settings, settingsFilePath) {
  const version = settings[SETTINGS_VERSION_KEY];
  if (typeof version !== "number" || version < SETTINGS_VERSION) {
    return [];
  }
  const warnings = [];
  const ignoredLegacyKeys = /* @__PURE__ */ new Set();
  for (const [oldKey, newPath] of Object.entries(V1_TO_V2_MIGRATION_MAP)) {
    if (oldKey === newPath) {
      continue;
    }
    if (!(oldKey in settings)) {
      continue;
    }
    const oldValue = settings[oldKey];
    if (V2_CONTAINER_KEYS.has(oldKey) && typeof oldValue === "object" && oldValue !== null && !Array.isArray(oldValue)) {
      continue;
    }
    ignoredLegacyKeys.add(oldKey);
    warnings.push(
      `Warning: Legacy setting '${oldKey}' will be ignored in ${settingsFilePath}. Please use '${newPath}' instead.`
    );
  }
  const schemaKeys = new Set(Object.keys(getSettingsSchema()));
  for (const key of Object.keys(settings)) {
    if (key === SETTINGS_VERSION_KEY) {
      continue;
    }
    if (ignoredLegacyKeys.has(key)) {
      continue;
    }
    if (schemaKeys.has(key)) {
      continue;
    }
    debugLogger2.warn(
      `Unknown setting '${key}' will be ignored in ${settingsFilePath}.`
    );
  }
  return warnings;
}
__name(getSettingsFileKeyWarnings, "getSettingsFileKeyWarnings");
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isPlainObject, "isPlainObject");
function hasAnyProviderEntries(modelProviders) {
  if (!isPlainObject(modelProviders)) {
    return false;
  }
  return Object.values(modelProviders).some(
    (providerModels) => Array.isArray(providerModels) && providerModels.length > 0
  );
}
__name(hasAnyProviderEntries, "hasAnyProviderEntries");
function getModelProvidersOverrideWarnings(loadedSettings) {
  if (!loadedSettings.isTrusted) {
    return [];
  }
  const userOriginal = loadedSettings.user.originalSettings;
  const workspaceOriginal = loadedSettings.workspace.originalSettings;
  if (!hasOwnModelProviders(userOriginal) || !hasOwnModelProviders(workspaceOriginal)) {
    return [];
  }
  const userModelProviders = userOriginal["modelProviders"];
  const workspaceModelProviders = workspaceOriginal["modelProviders"];
  const workspaceIsEmptyModelProviders = isPlainObject(workspaceModelProviders) && Object.keys(workspaceModelProviders).length === 0;
  if (!workspaceIsEmptyModelProviders || !hasAnyProviderEntries(userModelProviders)) {
    return [];
  }
  return [
    `Warning: '${loadedSettings.workspace.path}' defines an empty 'modelProviders' object. This has no effect with current merge behavior, but may indicate a configuration error. If REPLACE semantics are introduced for 'modelProviders' in the future, this would override user-level model providers in '${loadedSettings.user.path}'.`
  ];
}
__name(getModelProvidersOverrideWarnings, "getModelProvidersOverrideWarnings");
function getSettingsWarnings(loadedSettings) {
  const warningSet = /* @__PURE__ */ new Set();
  for (const warning of loadedSettings.migrationWarnings) {
    warningSet.add(`Warning: ${warning}`);
  }
  for (const scope of ["User" /* User */, "Workspace" /* Workspace */]) {
    const settingsFile = loadedSettings.forScope(scope);
    if (settingsFile.rawJson === void 0) {
      continue;
    }
    const settingsObject = settingsFile.originalSettings;
    for (const warning of getSettingsFileKeyWarnings(
      settingsObject,
      settingsFile.path
    )) {
      warningSet.add(warning);
    }
  }
  for (const warning of getModelProvidersOverrideWarnings(loadedSettings)) {
    warningSet.add(warning);
  }
  const workspaceFile = loadedSettings.forScope("Workspace" /* Workspace */);
  if (workspaceFile.rawJson !== void 0) {
    for (const { section, key } of WORKSPACE_RESTRICTED_SETTINGS) {
      const sectionValue = workspaceFile.originalSettings[section];
      if (sectionValue?.[key] === void 0) continue;
      warningSet.add(
        `Warning: ${section}.${key} in workspace settings (${workspaceFile.path}) is ignored. This setting is only honored from User, System, or SystemDefaults scope settings.`
      );
    }
    for (const ref of WORKSPACE_NON_OVERRIDING_SETTINGS) {
      if (!isSettingDefined(workspaceFile.originalSettings, ref)) continue;
      const definingScope = [
        "System" /* System */,
        "User" /* User */,
        "SystemDefaults" /* SystemDefaults */
      ].find(
        (scope) => isSettingDefined(loadedSettings.forScope(scope).originalSettings, ref)
      );
      if (definingScope === void 0) continue;
      warningSet.add(
        `Warning: ${ref.section}.${ref.key} in workspace settings (${workspaceFile.path}) is ignored because ${definingScope} scope settings also set it. A workspace value is honored only when no User, System, or SystemDefaults scope sets this setting.`
      );
    }
    for (const entry of WORKSPACE_TIGHTEN_ONLY_SETTINGS) {
      const verdict = tightenOnlyVerdict(entry, workspaceFile.settings, {
        system: loadedSettings.system.settings,
        systemDefaults: loadedSettings.systemDefaults.settings,
        user: loadedSettings.user.settings
      });
      if (verdict === void 0 || verdict.kept) continue;
      const key = `${entry.section}.${entry.key}`;
      if (verdict.reason === "system-sets") {
        warningSet.add(
          `Warning: ${key} in workspace settings (${workspaceFile.path}) is ignored because System scope settings also set it.`
        );
      } else if (verdict.reason === "looser") {
        warningSet.add(
          `Warning: ${key} in workspace settings (${workspaceFile.path}) is ignored because it would loosen the ${verdict.against} value. A workspace may only make this setting stricter.`
        );
      }
    }
  }
  return [...warningSet];
}
__name(getSettingsWarnings, "getSettingsWarnings");
function tagMcpServerScope(settings, scope) {
  const servers = settings.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    return settings;
  }
  const tagged = {};
  for (const [name, config] of Object.entries(servers)) {
    tagged[name] = { ...config, scope };
  }
  return { ...settings, mcpServers: tagged };
}
__name(tagMcpServerScope, "tagMcpServerScope");
function isSettingDefined(settings, { section, key }) {
  const sectionValue = settings[section];
  return sectionValue?.[key] !== void 0;
}
__name(isSettingDefined, "isSettingDefined");
function stripSettingKeys(settings, keys) {
  let stripped;
  for (const { section, key } of keys) {
    const source = (stripped ?? settings)[section];
    if (source?.[key] === void 0) continue;
    const { [key]: _removed, ...rest } = source;
    stripped = { ...stripped ?? settings, [section]: rest };
  }
  return stripped ?? settings;
}
__name(stripSettingKeys, "stripSettingKeys");
function stripWorkspaceRestrictedSettings(settings) {
  return stripSettingKeys(settings, WORKSPACE_RESTRICTED_SETTINGS);
}
__name(stripWorkspaceRestrictedSettings, "stripWorkspaceRestrictedSettings");
function stripWorkspaceOverrides(workspace, higherScopes) {
  return stripSettingKeys(
    workspace,
    WORKSPACE_NON_OVERRIDING_SETTINGS.filter(
      (ref) => higherScopes.some((scope) => isSettingDefined(scope, ref))
    )
  );
}
__name(stripWorkspaceOverrides, "stripWorkspaceOverrides");
function tightenOnlyVerdict(entry, workspace, scopes) {
  const read = /* @__PURE__ */ __name((settings) => settings[entry.section]?.[entry.key], "read");
  const candidate = read(workspace);
  if (candidate === void 0) return void 0;
  if (read(scopes.system) !== void 0) {
    return { kept: false, reason: "system-sets" };
  }
  const userValue = read(scopes.user);
  const systemDefaultsValue = read(scopes.systemDefaults);
  const against = userValue !== void 0 ? "User" : systemDefaultsValue !== void 0 ? "SystemDefaults" : "default";
  const baseline = entry.strictness(
    userValue !== void 0 ? userValue : systemDefaultsValue
  );
  const rank = entry.strictness(candidate);
  if (rank > baseline) return { kept: true };
  if (rank === baseline) return { kept: false, reason: "same" };
  return { kept: false, reason: "looser", against };
}
__name(tightenOnlyVerdict, "tightenOnlyVerdict");
function stripWorkspaceLoosenings(workspace, scopes) {
  return stripSettingKeys(
    workspace,
    WORKSPACE_TIGHTEN_ONLY_SETTINGS.filter((entry) => {
      const verdict = tightenOnlyVerdict(entry, workspace, scopes);
      return verdict !== void 0 && !verdict.kept;
    })
  );
}
__name(stripWorkspaceLoosenings, "stripWorkspaceLoosenings");
function mergeSettings(system, systemDefaults, user, workspace, isTrusted) {
  const safeWorkspace = isTrusted ? tagMcpServerScope(
    stripWorkspaceLoosenings(
      stripWorkspaceOverrides(stripWorkspaceRestrictedSettings(workspace), [
        systemDefaults,
        user,
        system
      ]),
      { system, systemDefaults, user }
    ),
    "workspace"
  ) : {};
  return customDeepMerge(
    getMergeStrategyForPath,
    {},
    // Start with an empty object
    systemDefaults,
    user,
    safeWorkspace,
    tagMcpServerScope(system, "system")
  );
}
__name(mergeSettings, "mergeSettings");
var LoadedSettings = class {
  static {
    __name(this, "LoadedSettings");
  }
  constructor(system, systemDefaults, user, workspace, isTrusted, migratedInMemoryScopes, migrationWarnings = [], corruptedPath = void 0, wasRecovered = false, workspaceSettingsActive = true) {
    this.system = system;
    this.systemDefaults = systemDefaults;
    this.user = user;
    this.workspace = workspace;
    this.isTrusted = isTrusted;
    this.migratedInMemoryScopes = migratedInMemoryScopes;
    this.migrationWarnings = migrationWarnings;
    this.corruptedPath = corruptedPath;
    this.wasRecovered = wasRecovered;
    this.workspaceSettingsActive = workspaceSettingsActive;
    this._merged = this.computeMergedSettings();
  }
  system;
  systemDefaults;
  user;
  workspace;
  isTrusted;
  migratedInMemoryScopes;
  migrationWarnings;
  corruptedPath;
  wasRecovered;
  workspaceSettingsActive;
  corruptionDialogDismissed = false;
  _merged;
  get merged() {
    return this._merged;
  }
  computeMergedSettings() {
    return mergeSettings(
      this.system.settings,
      this.systemDefaults.settings,
      this.user.settings,
      this.workspace.settings,
      this.isTrusted
    );
  }
  forScope(scope) {
    switch (scope) {
      case "User" /* User */:
        return this.user;
      case "Workspace" /* Workspace */:
        return this.workspace;
      case "System" /* System */:
        return this.system;
      case "SystemDefaults" /* SystemDefaults */:
        return this.systemDefaults;
      default:
        throw new Error(`Invalid scope: ${scope}`);
    }
  }
  setValue(scope, key, value, assertCanCommit, opts = {}) {
    if (key === "model.name" && typeof value === "string") {
      value = stripRuntimeSnapshotPrefix(value);
    }
    assertCanCommit?.();
    const settingsFile = this.forScope(scope);
    const replacePath = key === "mcpServers" ? key.split(".") : [];
    if (opts.throwOnWriteFailure) {
      saveSettings(
        settingsFile,
        createSettingsUpdate(key, value),
        replacePath,
        {
          throwOnWriteFailure: true
        }
      );
    }
    setNestedPropertySafe(settingsFile.settings, key, value);
    setNestedPropertySafe(settingsFile.originalSettings, key, value);
    this._merged = this.computeMergedSettings();
    if (!opts.throwOnWriteFailure) {
      saveSettings(settingsFile, createSettingsUpdate(key, value), replacePath);
    }
  }
  setValues(writes, onScopeCommitted, assertCanCommit) {
    const scopes = /* @__PURE__ */ new Set();
    for (const write of writes) {
      const value = write.key === "model.name" && typeof write.value === "string" ? stripRuntimeSnapshotPrefix(write.value) : write.value;
      const settingsFile = this.forScope(write.scope);
      setNestedPropertySafe(settingsFile.settings, write.key, value);
      setNestedPropertySafe(settingsFile.originalSettings, write.key, value);
      scopes.add(write.scope);
    }
    this._merged = this.computeMergedSettings();
    const scopeList = Array.from(scopes);
    for (let i = 0; i < scopeList.length; i++) {
      const scope = scopeList[i];
      try {
        assertCanCommit?.();
        saveSettings(this.forScope(scope), void 0, void 0, {
          throwOnWriteFailure: true
        });
      } catch (err) {
        for (const uncommittedScope of scopeList.slice(i)) {
          this.reloadScopeFromDisk(uncommittedScope);
        }
        throw err;
      }
      onScopeCommitted?.(scope);
    }
  }
  recomputeMerged() {
    this._merged = this.computeMergedSettings();
  }
  reloadScopeFromDisk(scope) {
    const file = this.forScope(scope);
    if (scope === "Workspace" /* Workspace */ && !this.workspaceSettingsActive) {
      file.settings = {};
      file.originalSettings = {};
      file.rawJson = void 0;
      this._merged = this.computeMergedSettings();
      return true;
    }
    let reloaded = false;
    try {
      if (!fs2.existsSync(file.path)) {
        file.settings = {};
        file.originalSettings = {};
        file.rawJson = void 0;
        this._merged = this.computeMergedSettings();
        return true;
      }
      const content = fs2.readFileSync(file.path, "utf-8");
      const parsed = JSON.parse((0, import_strip_json_comments.default)(content));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const resolved = resolveEnvVarsInObject(
          parsed,
          getHomeEnvFallbackVars((message) => debugLogger2.warn(message))
        );
        file.settings = resolved;
        file.originalSettings = structuredClone(parsed);
        file.rawJson = content;
        reloaded = true;
      } else {
        debugLogger2.warn(
          `reloadScopeFromDisk(${scope}): settings file is not a JSON object, keeping previous settings`
        );
      }
    } catch (err) {
      debugLogger2.warn(
        `reloadScopeFromDisk(${scope}): ${getErrorMessage(err)}`
      );
    }
    this._merged = this.computeMergedSettings();
    return reloaded;
  }
  reloadScopesFromDiskAtomically(scopes) {
    const snapshots = scopes.map((scope) => {
      const file = this.forScope(scope);
      return {
        file,
        settings: structuredClone(file.settings),
        originalSettings: structuredClone(file.originalSettings),
        rawJson: file.rawJson
      };
    });
    const reloaded = scopes.map((scope) => this.reloadScopeFromDisk(scope));
    if (reloaded.every(Boolean)) return true;
    for (const snapshot of snapshots) {
      snapshot.file.settings = snapshot.settings;
      snapshot.file.originalSettings = snapshot.originalSettings;
      snapshot.file.rawJson = snapshot.rawJson;
    }
    this._merged = this.computeMergedSettings();
    return false;
  }
  /**
   * Get system-scope hooks: the SystemDefaults and System settings files,
   * merged with the same strategy as the full merge (each `hooks.<Event>` list
   * is concatenated), SystemDefaults first. Administrator configuration is not
   * gated by folder trust, exactly like user hooks. Returns undefined, not an
   * empty object, when neither file configures hooks, so callers can tell a
   * scope with no data apart from one with data.
   */
  getSystemHooks() {
    const merged = customDeepMerge(
      getMergeStrategyForPath,
      {},
      { hooks: this.systemDefaults.settings.hooks ?? {} },
      { hooks: this.system.settings.hooks ?? {} }
    );
    const hooks = merged.hooks;
    return hooks && Object.keys(hooks).length > 0 ? hooks : void 0;
  }
  /**
   * Get user-level hooks from user settings (not merged with workspace).
   * These hooks should always be loaded regardless of folder trust.
   */
  getUserHooks() {
    return this.user.settings.hooks;
  }
  /**
   * Get project-level hooks from workspace settings (not merged).
   * Returns undefined if workspace is not trusted (hooks filtered out).
   */
  getProjectHooks() {
    if (!this.isTrusted) {
      return void 0;
    }
    return this.workspace.settings.hooks;
  }
};
function createMinimalSettings() {
  const emptySettingsFile = {
    path: "",
    settings: {},
    originalSettings: {},
    rawJson: "{}"
  };
  return new LoadedSettings(
    emptySettingsFile,
    emptySettingsFile,
    emptySettingsFile,
    emptySettingsFile,
    false,
    /* @__PURE__ */ new Set(),
    [],
    void 0,
    false
  );
}
__name(createMinimalSettings, "createMinimalSettings");
function detectQwenHomeRedirectWithoutMigration(activeUserSettingsPath) {
  if (!process.env["QWEN_HOME"]) {
    return null;
  }
  const activeQwenDir = Storage.getGlobalQwenDir();
  const savedQwenHome = process.env["QWEN_HOME"];
  delete process.env["QWEN_HOME"];
  let legacyQwenDir;
  try {
    legacyQwenDir = Storage.getGlobalQwenDir();
  } finally {
    process.env["QWEN_HOME"] = savedQwenHome;
  }
  if (path2.resolve(activeQwenDir) === path2.resolve(legacyQwenDir)) {
    return null;
  }
  if (fs2.existsSync(activeUserSettingsPath)) {
    return null;
  }
  const legacyUserSettings = path2.join(legacyQwenDir, "settings.json");
  if (!fs2.existsSync(legacyUserSettings)) {
    return null;
  }
  return `QWEN_HOME points to "${activeQwenDir}" but no settings.json was found there. Existing config remains at "${legacyQwenDir}" \u2014 OAuth tokens, settings, memory, extensions, and skills are not auto-migrated. Copy them manually if you want them to apply at the new location.`;
}
__name(detectQwenHomeRedirectWithoutMigration, "detectQwenHomeRedirectWithoutMigration");
var CORRUPTED_SUFFIX = ".corrupted";
function loadSettings(workspaceDir = process.cwd(), consumeCorruptionEnvVars = true) {
  const opts = typeof consumeCorruptionEnvVars === "object" ? consumeCorruptionEnvVars : { consumeCorruptionEnvVars };
  preResolveHomeEnvOverrides();
  const userSettingsPath = getUserSettingsPath();
  const qwenHomeRedirectWarning = detectQwenHomeRedirectWithoutMigration(userSettingsPath);
  let systemSettings = {};
  let systemDefaultSettings = {};
  let userSettings = {};
  let workspaceSettings = {};
  const settingsErrors = [];
  const systemSettingsPath = getSystemSettingsPath();
  const systemDefaultsPath = getSystemDefaultsPath();
  const migratedInMemoryScopes = /* @__PURE__ */ new Set();
  const resolvedWorkspaceDir = path2.resolve(workspaceDir);
  const resolvedHomeDir = path2.resolve(homedir());
  let realWorkspaceDir = resolvedWorkspaceDir;
  try {
    realWorkspaceDir = fs2.realpathSync(resolvedWorkspaceDir);
  } catch (_e) {
  }
  const realHomeDir = fs2.realpathSync(resolvedHomeDir);
  const workspaceSettingsPath = new Storage(
    workspaceDir
  ).getWorkspaceSettingsPath();
  const loadAndMigrate = /* @__PURE__ */ __name((filePath, scope) => {
    try {
      if (fs2.existsSync(filePath)) {
        const content = fs2.readFileSync(filePath, "utf-8");
        let rawSettings;
        const corruptedPath = `${filePath}${CORRUPTED_SUFFIX}`;
        let corruptedSaved = false;
        let recoveredFromEnvVar = null;
        try {
          rawSettings = JSON.parse((0, import_strip_json_comments.default)(content));
        } catch (parseError) {
          debugLogger2.warn(
            `Settings file ${filePath} has invalid JSON (${getErrorMessage(parseError)}). Resetting to empty settings.`
          );
          try {
            fs2.copyFileSync(filePath, corruptedPath);
            corruptedSaved = true;
          } catch (copyError) {
            debugLogger2.warn(
              `Failed to copy corrupted file: ${getErrorMessage(copyError)}`
            );
          }
          if (!rawSettings) {
            const warningMsg = `Settings file ${filePath} has invalid JSON. Your settings have been reset.`;
            debugLogger2.warn(warningMsg);
            if (corruptedSaved) {
              try {
                fs2.writeFileSync(filePath, "{}", "utf-8");
              } catch {
              }
            }
            return {
              settings: {},
              migrationWarnings: [],
              corruptedPath: corruptedSaved ? corruptedPath : void 0,
              wasRecovered: false
            };
          }
        }
        const envCorruptedPath = process.env[ENV_CORRUPTED_PATH];
        if ((opts.consumeCorruptionEnvVars ?? true) && envCorruptedPath && envCorruptedPath === corruptedPath && scope === "User" /* User */) {
          corruptedSaved = true;
          recoveredFromEnvVar = process.env[ENV_WAS_RECOVERED] === "1";
          delete process.env[ENV_CORRUPTED_PATH];
          delete process.env[ENV_WAS_RECOVERED];
        }
        if (typeof rawSettings !== "object" || rawSettings === null || Array.isArray(rawSettings)) {
          settingsErrors.push({
            message: "Settings file is not a valid JSON object.",
            path: filePath
          });
          return { settings: {} };
        }
        let settingsObject = rawSettings;
        const hasVersionKey = SETTINGS_VERSION_KEY in settingsObject;
        const versionValue = settingsObject[SETTINGS_VERSION_KEY];
        const hasInvalidVersion = hasVersionKey && typeof versionValue !== "number";
        const hasLegacyNumericVersion = typeof versionValue === "number" && versionValue < SETTINGS_VERSION;
        let migrationWarnings;
        const persistSettingsObject = /* @__PURE__ */ __name((warningPrefix) => {
          try {
            const written = updateSettingsFilePreservingFormat(
              filePath,
              settingsObject,
              true
            );
            if (!written) {
              debugLogger2.error(
                `${warningPrefix}: updateSettingsFilePreservingFormat returned false for ${filePath}`
              );
            }
          } catch (e) {
            debugLogger2.error(`${warningPrefix}: ${getErrorMessage(e)}`);
          }
        }, "persistSettingsObject");
        if (needsMigration(settingsObject)) {
          const migrationResult = runMigrations(settingsObject, scope);
          if (migrationResult.executedMigrations.length > 0) {
            settingsObject = migrationResult.settings;
            migrationWarnings = migrationResult.warnings;
            persistSettingsObject("Error migrating settings file on disk");
          } else if ((hasLegacyNumericVersion || hasInvalidVersion) && !corruptedSaved) {
            settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
            debugLogger2.warn(
              `Settings version metadata in ${filePath} could not be migrated by any registered migration. Normalizing ${SETTINGS_VERSION_KEY} to ${SETTINGS_VERSION}.`
            );
            persistSettingsObject("Error normalizing settings version on disk");
          }
        } else if ((!hasVersionKey || hasInvalidVersion || hasLegacyNumericVersion) && !corruptedSaved) {
          settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
          persistSettingsObject("Error normalizing settings version on disk");
        }
        const result = {
          settings: settingsObject,
          rawJson: content,
          migrationWarnings: migrationWarnings ?? []
        };
        if (corruptedSaved) {
          result.corruptedPath = corruptedPath;
          result.wasRecovered = recoveredFromEnvVar ?? false;
        }
        return result;
      }
    } catch (error) {
      settingsErrors.push({
        message: getErrorMessage(error),
        path: filePath
      });
    }
    return { settings: {} };
  }, "loadAndMigrate");
  const systemResult = loadAndMigrate(systemSettingsPath, "System" /* System */);
  const systemDefaultsResult = loadAndMigrate(
    systemDefaultsPath,
    "SystemDefaults" /* SystemDefaults */
  );
  const userResult = loadAndMigrate(userSettingsPath, "User" /* User */);
  let workspaceResult = {
    settings: {},
    rawJson: void 0
  };
  const workspaceSettingsActive = !opts.skipWorkspaceSettings && realWorkspaceDir !== realHomeDir;
  if (workspaceSettingsActive) {
    workspaceResult = loadAndMigrate(
      workspaceSettingsPath,
      "Workspace" /* Workspace */
    );
  }
  const systemOriginalSettings = structuredClone(systemResult.settings);
  const systemDefaultsOriginalSettings = structuredClone(
    systemDefaultsResult.settings
  );
  const userOriginalSettings = structuredClone(userResult.settings);
  const workspaceOriginalSettings = structuredClone(workspaceResult.settings);
  const homeEnvFallback = getHomeEnvFallbackVars(
    (message) => debugLogger2.warn(message)
  );
  systemSettings = resolveEnvVarsInObject(
    systemResult.settings,
    homeEnvFallback
  );
  systemDefaultSettings = resolveEnvVarsInObject(
    systemDefaultsResult.settings,
    homeEnvFallback
  );
  userSettings = resolveEnvVarsInObject(userResult.settings, homeEnvFallback);
  workspaceSettings = resolveEnvVarsInObject(
    workspaceResult.settings,
    homeEnvFallback
  );
  if (userSettings.ui?.theme === "VS") {
    userSettings.ui.theme = DEFAULT_LIGHT_THEME_NAME;
  } else if (userSettings.ui?.theme === "VS2015") {
    userSettings.ui.theme = DEFAULT_DARK_THEME_NAME;
  }
  if (workspaceSettings.ui?.theme === "VS") {
    workspaceSettings.ui.theme = DEFAULT_LIGHT_THEME_NAME;
  } else if (workspaceSettings.ui?.theme === "VS2015") {
    workspaceSettings.ui.theme = DEFAULT_DARK_THEME_NAME;
  }
  const initialTrustCheckSettings = customDeepMerge(
    getMergeStrategyForPath,
    {},
    systemSettings,
    userSettings
  );
  const isTrusted = opts.workspaceTrusted ?? isWorkspaceTrusted(
    initialTrustCheckSettings,
    void 0,
    realWorkspaceDir
  ).isTrusted ?? true;
  const tempMergedSettings = mergeSettings(
    systemSettings,
    systemDefaultSettings,
    userSettings,
    workspaceSettings,
    isTrusted
  );
  if (!opts.skipLoadEnvironment) {
    loadEnvironment(tempMergedSettings, workspaceDir);
  }
  if (settingsErrors.length > 0) {
    const errorMessages = settingsErrors.map(
      (error) => `Error in ${error.path}: ${error.message}`
    );
    throw new FatalConfigError(
      `${errorMessages.join("\n")}
Please fix the configuration file(s) and try again.`
    );
  }
  const allMigrationWarnings = [
    ...qwenHomeRedirectWarning ? [qwenHomeRedirectWarning] : [],
    ...systemResult.migrationWarnings ?? [],
    ...systemDefaultsResult.migrationWarnings ?? [],
    ...userResult.migrationWarnings ?? [],
    ...workspaceResult.migrationWarnings ?? []
  ];
  return new LoadedSettings(
    {
      path: systemSettingsPath,
      settings: systemSettings,
      originalSettings: systemOriginalSettings,
      rawJson: systemResult.rawJson
    },
    {
      path: systemDefaultsPath,
      settings: systemDefaultSettings,
      originalSettings: systemDefaultsOriginalSettings,
      rawJson: systemDefaultsResult.rawJson
    },
    {
      path: userSettingsPath,
      settings: userSettings,
      originalSettings: userOriginalSettings,
      rawJson: userResult.rawJson
    },
    {
      path: workspaceSettingsPath,
      settings: workspaceSettings,
      originalSettings: workspaceOriginalSettings,
      rawJson: workspaceResult.rawJson
    },
    isTrusted,
    migratedInMemoryScopes,
    allMigrationWarnings,
    userResult.corruptedPath,
    userResult.wasRecovered ?? false,
    workspaceSettingsActive
  );
}
__name(loadSettings, "loadSettings");
function createSettingsUpdate(key, value) {
  const root = {};
  setNestedPropertySafe(root, key, value);
  return root;
}
__name(createSettingsUpdate, "createSettingsUpdate");
function saveSettings(settingsFile, updates = settingsFile.originalSettings, replacePath = [], opts = {}) {
  try {
    const dirPath = path2.dirname(settingsFile.path);
    if (!fs2.existsSync(dirPath)) {
      fs2.mkdirSync(dirPath, { recursive: true });
    }
    const written = updateSettingsFilePreservingFormat(
      settingsFile.path,
      updates,
      false,
      replacePath
    );
    if (!written) {
      const message = `saveSettings: updateSettingsFilePreservingFormat returned false for ${settingsFile.path}`;
      if (opts.throwOnWriteFailure) {
        throw new Error(message);
      }
      debugLogger2.error(message);
    }
  } catch (error) {
    debugLogger2.error("Error saving user settings file.");
    debugLogger2.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
__name(saveSettings, "saveSettings");

export {
  getModelProvidersOwnerScope,
  getPersistScopeForModelSelection,
  getWritableScopes,
  getOwnKeyScope,
  OUTPUT_LANGUAGE_AUTO,
  isAutoLanguage,
  resolveOutputLanguageOrPreserveAuto,
  getOutputLanguageFilePath,
  updateOutputLanguageFile,
  writeOutputLanguageAndRegisterPath,
  initializeLlmOutputLanguage,
  getFlattenedSchema,
  getSettingDefinition,
  requiresRestart,
  getDefaultValue,
  getNestedValue,
  getNestedProperty,
  getEffectiveValue,
  getAllSettingKeys,
  validateSettingValue,
  WORKSPACE_RESTRICTED_SETTING_KEYS,
  getDialogSettingKeys,
  settingExistsInScope,
  deleteNestedPropertySafe,
  setPendingSettingValue,
  setPendingSettingValueAny,
  getRestartRequiredFromModified,
  saveModifiedSettings,
  getDisplayValue,
  nextBooleanSettingValue,
  isDefaultValue,
  v1ToV2Migration,
  getUserSettingsPath,
  getUserSettingsDir,
  SETTINGS_VERSION,
  SETTINGS_VERSION_KEY,
  migrateLegacyPermissions,
  SettingScope,
  getSettingsWarnings,
  LoadedSettings,
  createMinimalSettings,
  CORRUPTED_SUFFIX,
  loadSettings,
  saveSettings
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
