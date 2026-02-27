/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir, platform } from 'node:os';
import * as dotenv from 'dotenv';
import process from 'node:process';
import {
  FatalConfigError,
  QWEN_DIR,
  getErrorMessage,
  Storage,
} from '@qwen-code/qwen-code-core';
import stripJsonComments from 'strip-json-comments';
import { DefaultLight } from '../ui/themes/default-light.js';
import { DefaultDark } from '../ui/themes/default.js';
import { isWorkspaceTrusted } from './trustedFolders.js';
import {
  type Settings,
  type MemoryImportFormat,
  type MergeStrategy,
  type SettingsSchema,
  type SettingDefinition,
  getSettingsSchema,
} from './settingsSchema.js';
import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';
import { customDeepMerge, type MergeableObject } from '../utils/deepMerge.js';
import { updateSettingsFilePreservingFormat } from '../utils/commentJson.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

function getMergeStrategyForPath(path: string[]): MergeStrategy | undefined {
  let current: SettingDefinition | undefined = undefined;
  let currentSchema: SettingsSchema | undefined = getSettingsSchema();

  for (const key of path) {
    if (!currentSchema || !currentSchema[key]) {
      return undefined;
    }
    current = currentSchema[key];
    currentSchema = current.properties;
  }

  return current?.mergeStrategy;
}

export type { Settings, MemoryImportFormat };

export const SETTINGS_DIRECTORY_NAME = '.qwen';
export const USER_SETTINGS_PATH = Storage.getGlobalSettingsPath();
export const USER_SETTINGS_DIR = path.dirname(USER_SETTINGS_PATH);
export const DEFAULT_EXCLUDED_ENV_VARS = ['DEBUG', 'DEBUG_MODE'];

const MIGRATE_V2_OVERWRITE = true;

// Settings version to track migration state
export const SETTINGS_VERSION = 3;
export const SETTINGS_VERSION_KEY = '$version';

const MIGRATION_MAP: Record<string, string> = {
  accessibility: 'ui.accessibility',
  allowedTools: 'tools.allowed',
  allowMCPServers: 'mcp.allowed',
  autoAccept: 'tools.autoAccept',
  autoConfigureMaxOldSpaceSize: 'advanced.autoConfigureMemory',
  bugCommand: 'advanced.bugCommand',
  chatCompression: 'model.chatCompression',
  checkpointing: 'general.checkpointing',
  coreTools: 'tools.core',
  contextFileName: 'context.fileName',
  customThemes: 'ui.customThemes',
  customWittyPhrases: 'ui.customWittyPhrases',
  debugKeystrokeLogging: 'general.debugKeystrokeLogging',
  dnsResolutionOrder: 'advanced.dnsResolutionOrder',
  enforcedAuthType: 'security.auth.enforcedType',
  excludeTools: 'tools.exclude',
  excludeMCPServers: 'mcp.excluded',
  excludedProjectEnvVars: 'advanced.excludedEnvVars',
  extensions: 'extensions',
  fileFiltering: 'context.fileFiltering',
  folderTrustFeature: 'security.folderTrust.featureEnabled',
  folderTrust: 'security.folderTrust.enabled',
  hasSeenIdeIntegrationNudge: 'ide.hasSeenNudge',
  hideWindowTitle: 'ui.hideWindowTitle',
  showStatusInTitle: 'ui.showStatusInTitle',
  hideTips: 'ui.hideTips',
  showLineNumbers: 'ui.showLineNumbers',
  showCitations: 'ui.showCitations',
  ideMode: 'ide.enabled',
  includeDirectories: 'context.includeDirectories',
  loadMemoryFromIncludeDirectories: 'context.loadFromIncludeDirectories',
  maxSessionTurns: 'model.maxSessionTurns',
  mcpServers: 'mcpServers',
  mcpServerCommand: 'mcp.serverCommand',
  memoryImportFormat: 'context.importFormat',
  model: 'model.name',
  preferredEditor: 'general.preferredEditor',
  sandbox: 'tools.sandbox',
  selectedAuthType: 'security.auth.selectedType',
  shouldUseNodePtyShell: 'tools.shell.enableInteractiveShell',
  shellPager: 'tools.shell.pager',
  shellShowColor: 'tools.shell.showColor',
  skipNextSpeakerCheck: 'model.skipNextSpeakerCheck',
  summarizeToolOutput: 'model.summarizeToolOutput',
  telemetry: 'telemetry',
  theme: 'ui.theme',
  toolDiscoveryCommand: 'tools.discoveryCommand',
  toolCallCommand: 'tools.callCommand',
  usageStatisticsEnabled: 'privacy.usageStatisticsEnabled',
  useExternalAuth: 'security.auth.useExternal',
  useRipgrep: 'tools.useRipgrep',
  vimMode: 'general.vimMode',

  enableWelcomeBack: 'ui.enableWelcomeBack',
  approvalMode: 'tools.approvalMode',
  sessionTokenLimit: 'model.sessionTokenLimit',
  contentGenerator: 'model.generationConfig',
  skipLoopDetection: 'model.skipLoopDetection',
  skipStartupContext: 'model.skipStartupContext',
  enableOpenAILogging: 'model.enableOpenAILogging',
  tavilyApiKey: 'advanced.tavilyApiKey',
};

// Settings that need boolean inversion during migration (V1 -> V3)
// Old negative naming -> new positive naming with inverted value
const INVERTED_BOOLEAN_MIGRATIONS: Record<string, string> = {
  disableAutoUpdate: 'general.enableAutoUpdate',
  disableUpdateNag: 'general.enableAutoUpdate',
  disableLoadingPhrases: 'ui.accessibility.enableLoadingPhrases',
  disableFuzzySearch: 'context.fileFiltering.enableFuzzySearch',
  disableCacheControl: 'model.generationConfig.enableCacheControl',
};

// Consolidated settings: multiple old V1 keys that map to a single new key.
// Policy: if ANY of the old disable* settings is true, the new enable* should be false.
const CONSOLIDATED_SETTINGS: Record<string, string[]> = {
  'general.enableAutoUpdate': ['disableAutoUpdate', 'disableUpdateNag'],
};

// V2 nested paths that need inversion when migrating to V3
const INVERTED_V2_PATHS: Record<string, string> = {
  'general.disableAutoUpdate': 'general.enableAutoUpdate',
  'general.disableUpdateNag': 'general.enableAutoUpdate',
  'ui.accessibility.disableLoadingPhrases':
    'ui.accessibility.enableLoadingPhrases',
  'context.fileFiltering.disableFuzzySearch':
    'context.fileFiltering.enableFuzzySearch',
  'model.generationConfig.disableCacheControl':
    'model.generationConfig.enableCacheControl',
};

// Consolidated V2 paths: multiple old paths that map to a single new path.
// Policy: if ANY of the old disable* settings is true, the new enable* should be false.
const CONSOLIDATED_V2_PATHS: Record<string, string[]> = {
  'general.enableAutoUpdate': [
    'general.disableAutoUpdate',
    'general.disableUpdateNag',
  ],
};

export function getSystemSettingsPath(): string {
  if (process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']) {
    return process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
  }
  if (platform() === 'darwin') {
    return '/Library/Application Support/QwenCode/settings.json';
  } else if (platform() === 'win32') {
    return 'C:\\ProgramData\\qwen-code\\settings.json';
  } else {
    return '/etc/qwen-code/settings.json';
  }
}

export function getSystemDefaultsPath(): string {
  if (process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH']) {
    return process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
  }
  return path.join(
    path.dirname(getSystemSettingsPath()),
    'system-defaults.json',
  );
}

export type { DnsResolutionOrder } from './settingsSchema.js';

export enum SettingScope {
  User = 'User',
  Workspace = 'Workspace',
  System = 'System',
  SystemDefaults = 'SystemDefaults',
}

export interface CheckpointingSettings {
  enabled?: boolean;
}

export interface SummarizeToolOutputSettings {
  tokenBudget?: number;
}

export interface AccessibilitySettings {
  enableLoadingPhrases?: boolean;
  screenReader?: boolean;
}

export interface SettingsError {
  message: string;
  path: string;
}

export interface SettingsFile {
  settings: Settings;
  originalSettings: Settings;
  path: string;
  rawJson?: string;
}

function setNestedProperty(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  const keys = path.split('.');
  const lastKey = keys.pop();
  if (!lastKey) return;

  let current: Record<string, unknown> = obj;
  for (const key of keys) {
    if (current[key] === undefined) {
      current[key] = {};
    }
    const next = current[key];
    if (typeof next === 'object' && next !== null) {
      current = next as Record<string, unknown>;
    } else {
      // This path is invalid, so we stop.
      return;
    }
  }
  current[lastKey] = value;
}

// Dynamically determine the top-level keys from the V2 settings structure.
const KNOWN_V2_CONTAINERS = new Set([
  ...Object.values(MIGRATION_MAP).map((path) => path.split('.')[0]),
  ...Object.values(INVERTED_BOOLEAN_MIGRATIONS).map(
    (path) => path.split('.')[0],
  ),
]);

export function needsMigration(settings: Record<string, unknown>): boolean {
  // Check version field first - if present and matches current version, no migration needed
  if (SETTINGS_VERSION_KEY in settings) {
    const version = settings[SETTINGS_VERSION_KEY];
    if (typeof version === 'number' && version >= SETTINGS_VERSION) {
      return false;
    }
  }

  // Fallback to legacy detection: A file needs migration if it contains any
  // top-level key that is moved to a nested location in V2.
  const hasV1Keys = Object.entries(MIGRATION_MAP).some(([v1Key, v2Path]) => {
    if (v1Key === v2Path || !(v1Key in settings)) {
      return false;
    }
    // If a key exists that is both a V1 key and a V2 container (like 'model'),
    // we need to check the type. If it's an object, it's a V2 container and not
    // a V1 key that needs migration.
    if (
      KNOWN_V2_CONTAINERS.has(v1Key) &&
      typeof settings[v1Key] === 'object' &&
      settings[v1Key] !== null
    ) {
      return false;
    }
    return true;
  });

  // Also check for old inverted boolean keys (disable* -> enable*)
  const hasInvertedBooleanKeys = Object.keys(INVERTED_BOOLEAN_MIGRATIONS).some(
    (v1Key) => v1Key in settings,
  );

  return hasV1Keys || hasInvertedBooleanKeys;
}

/**
 * Migrates V1 (flat) settings directly to V3.
 * This includes both structural migration (flat -> nested) and boolean
 * inversion (disable* -> enable*), so migrateV2ToV3 will be skipped.
 */
function migrateV1ToV3(
  flatSettings: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!needsMigration(flatSettings)) {
    return null;
  }

  const v2Settings: Record<string, unknown> = {};
  const flatKeys = new Set(Object.keys(flatSettings));

  for (const [oldKey, newPath] of Object.entries(MIGRATION_MAP)) {
    if (flatKeys.has(oldKey)) {
      // Safety check: If this key is a V2 container (like 'model') and it's
      // already an object, it's likely already in V2 format. Skip migration
      // to prevent double-nesting (e.g., model.name.name).
      if (
        KNOWN_V2_CONTAINERS.has(oldKey) &&
        typeof flatSettings[oldKey] === 'object' &&
        flatSettings[oldKey] !== null &&
        !Array.isArray(flatSettings[oldKey])
      ) {
        // This is already a V2 container, carry it over as-is
        v2Settings[oldKey] = flatSettings[oldKey];
        flatKeys.delete(oldKey);
        continue;
      }

      setNestedProperty(v2Settings, newPath, flatSettings[oldKey]);
      flatKeys.delete(oldKey);
    }
  }

  // Handle consolidated settings first (multiple old keys -> single new key)
  // Policy: if ANY of the old disable* settings is true, the new enable* should be false
  for (const [newPath, oldKeys] of Object.entries(CONSOLIDATED_SETTINGS)) {
    let hasAnyDisable = false;
    let hasAnyValue = false;
    for (const oldKey of oldKeys) {
      if (flatKeys.has(oldKey)) {
        hasAnyValue = true;
        const oldValue = flatSettings[oldKey];
        if (typeof oldValue === 'boolean' && oldValue === true) {
          hasAnyDisable = true;
        }
        flatKeys.delete(oldKey);
      }
    }
    if (hasAnyValue) {
      // enableAutoUpdate = !hasAnyDisable (if any disable* was true, enable should be false)
      setNestedProperty(v2Settings, newPath, !hasAnyDisable);
    }
  }

  // Handle remaining V1 settings that need boolean inversion (disable* -> enable*)
  // Skip keys that were already handled by consolidated settings
  const consolidatedKeys = new Set(Object.values(CONSOLIDATED_SETTINGS).flat());
  for (const [oldKey, newPath] of Object.entries(INVERTED_BOOLEAN_MIGRATIONS)) {
    if (consolidatedKeys.has(oldKey)) {
      continue;
    }
    if (flatKeys.has(oldKey)) {
      const oldValue = flatSettings[oldKey];
      if (typeof oldValue === 'boolean') {
        setNestedProperty(v2Settings, newPath, !oldValue);
      }
      flatKeys.delete(oldKey);
    }
  }

  // Preserve mcpServers at the top level
  if (flatSettings['mcpServers']) {
    v2Settings['mcpServers'] = flatSettings['mcpServers'];
    flatKeys.delete('mcpServers');
  }

  // Carry over any unrecognized keys
  for (const remainingKey of flatKeys) {
    const existingValue = v2Settings[remainingKey];
    const newValue = flatSettings[remainingKey];

    if (
      typeof existingValue === 'object' &&
      existingValue !== null &&
      !Array.isArray(existingValue) &&
      typeof newValue === 'object' &&
      newValue !== null &&
      !Array.isArray(newValue)
    ) {
      const pathAwareGetStrategy = (path: string[]) =>
        getMergeStrategyForPath([remainingKey, ...path]);
      v2Settings[remainingKey] = customDeepMerge(
        pathAwareGetStrategy,
        {},
        newValue as MergeableObject,
        existingValue as MergeableObject,
      );
    } else {
      v2Settings[remainingKey] = newValue;
    }
  }

  // Set version field to indicate this is a V2 settings file
  v2Settings[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;

  return v2Settings;
}

// Migrate V2 settings to V3 (invert disable* -> enable* booleans)
function migrateV2ToV3(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  const version = settings[SETTINGS_VERSION_KEY];
  if (typeof version === 'number' && version >= 3) {
    return null;
  }

  let changed = false;
  const result = structuredClone(settings);
  const processedPaths = new Set<string>();

  // Handle consolidated V2 paths first (multiple old paths -> single new path)
  // Policy: if ANY of the old disable* settings is true, the new enable* should be false
  for (const [newPath, oldPaths] of Object.entries(CONSOLIDATED_V2_PATHS)) {
    let hasAnyDisable = false;
    let hasAnyValue = false;
    for (const oldPath of oldPaths) {
      const oldValue = getNestedProperty(result, oldPath);
      if (typeof oldValue === 'boolean') {
        hasAnyValue = true;
        if (oldValue === true) {
          hasAnyDisable = true;
        }
        deleteNestedProperty(result, oldPath);
        processedPaths.add(oldPath);
        changed = true;
      }
    }
    if (hasAnyValue) {
      // enableAutoUpdate = !hasAnyDisable (if any disable* was true, enable should be false)
      setNestedProperty(result, newPath, !hasAnyDisable);
    }
  }

  // Handle remaining V2 paths that need inversion
  for (const [oldPath, newPath] of Object.entries(INVERTED_V2_PATHS)) {
    if (processedPaths.has(oldPath)) {
      continue;
    }
    const oldValue = getNestedProperty(result, oldPath);
    if (typeof oldValue === 'boolean') {
      // Remove old property
      deleteNestedProperty(result, oldPath);
      // Set new property with inverted value
      setNestedProperty(result, newPath, !oldValue);
      changed = true;
    }
  }

  if (changed) {
    result[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
    return result;
  }

  // Even if no changes, bump version to 3 to skip future migration checks
  if (typeof version === 'number' && version < SETTINGS_VERSION) {
    result[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
    return result;
  }

  return null;
}

function deleteNestedProperty(
  obj: Record<string, unknown>,
  path: string,
): void {
  const keys = path.split('.');
  const lastKey = keys.pop();
  if (!lastKey) return;

  let current: Record<string, unknown> = obj;
  for (const key of keys) {
    const next = current[key];
    if (typeof next !== 'object' || next === null) {
      return;
    }
    current = next as Record<string, unknown>;
  }
  delete current[lastKey];
}

function getNestedProperty(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const REVERSE_MIGRATION_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(MIGRATION_MAP).map(([key, value]) => [value, key]),
);

// Reverse map for old V2 paths (before rename) to V1 keys.
// Used when migrating settings that still have old V2 naming (e.g., general.disableAutoUpdate).
const OLD_V2_TO_V1_MAP: Record<string, string> = {};
for (const [oldV2Path, newV3Path] of Object.entries(INVERTED_V2_PATHS)) {
  // Find the V1 key that maps to this V3 path
  for (const [v1Key, v3Path] of Object.entries(INVERTED_BOOLEAN_MIGRATIONS)) {
    if (v3Path === newV3Path) {
      OLD_V2_TO_V1_MAP[oldV2Path] = v1Key;
      break;
    }
  }
}

// Reverse map for new V3 paths to V1 keys (with boolean inversion).
// Used when migrating settings that have new V3 naming (e.g., general.enableAutoUpdate).
const V3_TO_V1_INVERTED_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(INVERTED_BOOLEAN_MIGRATIONS).map(([v1Key, v3Path]) => [
    v3Path,
    v1Key,
  ]),
);

function getSettingsFileKeyWarnings(
  settings: Record<string, unknown>,
  settingsFilePath: string,
): string[] {
  const version = settings[SETTINGS_VERSION_KEY];
  if (typeof version !== 'number' || version < SETTINGS_VERSION) {
    return [];
  }

  const warnings: string[] = [];
  const ignoredLegacyKeys = new Set<string>();

  // Ignored legacy keys (V1 top-level keys that moved to a nested V2 path).
  for (const [oldKey, newPath] of Object.entries(MIGRATION_MAP)) {
    if (oldKey === newPath) {
      continue;
    }
    if (!(oldKey in settings)) {
      continue;
    }

    const oldValue = settings[oldKey];

    // If this key is a V2 container (like 'model') and it's already an object,
    // it's likely already in V2 format. Don't warn.
    if (
      KNOWN_V2_CONTAINERS.has(oldKey) &&
      typeof oldValue === 'object' &&
      oldValue !== null &&
      !Array.isArray(oldValue)
    ) {
      continue;
    }

    ignoredLegacyKeys.add(oldKey);
    warnings.push(
      `Warning: Legacy setting '${oldKey}' will be ignored in ${settingsFilePath}. Please use '${newPath}' instead.`,
    );
  }

  // Unknown top-level keys.
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

    warnings.push(
      `Warning: Unknown setting '${key}' will be ignored in ${settingsFilePath}.`,
    );
  }

  return warnings;
}

/**
 * Collects warnings for ignored legacy and unknown settings keys.
 *
 * For `$version: 2` settings files, we do not apply implicit migrations.
 * Instead, we surface actionable, de-duplicated warnings in the terminal UI.
 */
export function getSettingsWarnings(loadedSettings: LoadedSettings): string[] {
  const warningSet = new Set<string>();

  for (const scope of [SettingScope.User, SettingScope.Workspace]) {
    const settingsFile = loadedSettings.forScope(scope);
    if (settingsFile.rawJson === undefined) {
      continue;
      // File not present / not loaded.
    }
    const settingsObject = settingsFile.originalSettings as unknown as Record<
      string,
      unknown
    >;

    for (const warning of getSettingsFileKeyWarnings(
      settingsObject,
      settingsFile.path,
    )) {
      warningSet.add(warning);
    }
  }

  return [...warningSet];
}

export function migrateSettingsToV1(
  v2Settings: Record<string, unknown>,
): Record<string, unknown> {
  const v1Settings: Record<string, unknown> = {};
  const v2Keys = new Set(Object.keys(v2Settings));

  for (const [newPath, oldKey] of Object.entries(REVERSE_MIGRATION_MAP)) {
    const value = getNestedProperty(v2Settings, newPath);
    if (value !== undefined) {
      v1Settings[oldKey] = value;
      v2Keys.delete(newPath.split('.')[0]);
    }
  }

  // Handle old V2 inverted paths (no value inversion needed)
  // e.g., general.disableAutoUpdate -> disableAutoUpdate
  for (const [oldV2Path, v1Key] of Object.entries(OLD_V2_TO_V1_MAP)) {
    const value = getNestedProperty(v2Settings, oldV2Path);
    if (value !== undefined) {
      v1Settings[v1Key] = value;
      v2Keys.delete(oldV2Path.split('.')[0]);
    }
  }

  // Handle new V3 inverted paths (WITH value inversion)
  // e.g., general.enableAutoUpdate -> disableAutoUpdate (inverted)
  for (const [v3Path, v1Key] of Object.entries(V3_TO_V1_INVERTED_MAP)) {
    const value = getNestedProperty(v2Settings, v3Path);
    if (value !== undefined && typeof value === 'boolean') {
      v1Settings[v1Key] = !value;
      v2Keys.delete(v3Path.split('.')[0]);
    }
  }

  // Preserve mcpServers at the top level
  if (v2Settings['mcpServers']) {
    v1Settings['mcpServers'] = v2Settings['mcpServers'];
    v2Keys.delete('mcpServers');
  }

  // Carry over any unrecognized keys
  for (const remainingKey of v2Keys) {
    // Skip the version field - it's only for V2 format
    if (remainingKey === SETTINGS_VERSION_KEY) {
      continue;
    }

    const value = v2Settings[remainingKey];
    if (value === undefined) {
      continue;
    }

    // Don't carry over empty objects that were just containers for migrated settings.
    if (
      KNOWN_V2_CONTAINERS.has(remainingKey) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue;
    }

    v1Settings[remainingKey] = value;
  }

  return v1Settings;
}

function mergeSettings(
  system: Settings,
  systemDefaults: Settings,
  user: Settings,
  workspace: Settings,
  isTrusted: boolean,
): Settings {
  const safeWorkspace = isTrusted ? workspace : ({} as Settings);

  // Settings are merged with the following precedence (last one wins for
  // single values):
  // 1. System Defaults
  // 2. User Settings
  // 3. Workspace Settings
  // 4. System Settings (as overrides)
  return customDeepMerge(
    getMergeStrategyForPath,
    {}, // Start with an empty object
    systemDefaults,
    user,
    safeWorkspace,
    system,
  ) as Settings;
}

export class LoadedSettings {
  constructor(
    system: SettingsFile,
    systemDefaults: SettingsFile,
    user: SettingsFile,
    workspace: SettingsFile,
    isTrusted: boolean,
    migratedInMemorScopes: Set<SettingScope>,
  ) {
    this.system = system;
    this.systemDefaults = systemDefaults;
    this.user = user;
    this.workspace = workspace;
    this.isTrusted = isTrusted;
    this.migratedInMemorScopes = migratedInMemorScopes;
    this._merged = this.computeMergedSettings();
  }

  readonly system: SettingsFile;
  readonly systemDefaults: SettingsFile;
  readonly user: SettingsFile;
  readonly workspace: SettingsFile;
  readonly isTrusted: boolean;
  readonly migratedInMemorScopes: Set<SettingScope>;

  private _merged: Settings;

  get merged(): Settings {
    return this._merged;
  }

  private computeMergedSettings(): Settings {
    return mergeSettings(
      this.system.settings,
      this.systemDefaults.settings,
      this.user.settings,
      this.workspace.settings,
      this.isTrusted,
    );
  }

  forScope(scope: SettingScope): SettingsFile {
    switch (scope) {
      case SettingScope.User:
        return this.user;
      case SettingScope.Workspace:
        return this.workspace;
      case SettingScope.System:
        return this.system;
      case SettingScope.SystemDefaults:
        return this.systemDefaults;
      default:
        throw new Error(`Invalid scope: ${scope}`);
    }
  }

  setValue(scope: SettingScope, key: string, value: unknown): void {
    const settingsFile = this.forScope(scope);
    setNestedProperty(settingsFile.settings, key, value);
    setNestedProperty(settingsFile.originalSettings, key, value);
    this._merged = this.computeMergedSettings();
    saveSettings(settingsFile);
  }
}

/**
 * Creates a minimal LoadedSettings instance with empty settings.
 * Used in stream-json mode where settings are ignored.
 */
export function createMinimalSettings(): LoadedSettings {
  const emptySettingsFile: SettingsFile = {
    path: '',
    settings: {},
    originalSettings: {},
    rawJson: '{}',
  };
  return new LoadedSettings(
    emptySettingsFile,
    emptySettingsFile,
    emptySettingsFile,
    emptySettingsFile,
    false,
    new Set(),
  );
}

/**
 * Finds the .env file to load, respecting workspace trust settings.
 *
 * When workspace is untrusted, only allow user-level .env files at:
 * - ~/.qwen/.env
 * - ~/.env
 */
function findEnvFile(settings: Settings, startDir: string): string | null {
  const homeDir = homedir();
  const isTrusted = isWorkspaceTrusted(settings).isTrusted;

  // Pre-compute user-level .env paths for fast comparison
  const userLevelPaths = new Set([
    path.normalize(path.join(homeDir, '.env')),
    path.normalize(path.join(homeDir, QWEN_DIR, '.env')),
  ]);

  // Determine if we can use this .env file based on trust settings
  const canUseEnvFile = (filePath: string): boolean =>
    isTrusted !== false || userLevelPaths.has(path.normalize(filePath));

  let currentDir = path.resolve(startDir);
  while (true) {
    // Prefer gemini-specific .env under QWEN_DIR
    const geminiEnvPath = path.join(currentDir, QWEN_DIR, '.env');
    if (fs.existsSync(geminiEnvPath) && canUseEnvFile(geminiEnvPath)) {
      return geminiEnvPath;
    }

    const envPath = path.join(currentDir, '.env');
    if (fs.existsSync(envPath) && canUseEnvFile(envPath)) {
      return envPath;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      // At home directory - check fallback .env files
      const homeGeminiEnvPath = path.join(homeDir, QWEN_DIR, '.env');
      if (fs.existsSync(homeGeminiEnvPath)) {
        return homeGeminiEnvPath;
      }
      const homeEnvPath = path.join(homeDir, '.env');
      if (fs.existsSync(homeEnvPath)) {
        return homeEnvPath;
      }
      return null;
    }
    currentDir = parentDir;
  }
}

export function setUpCloudShellEnvironment(envFilePath: string | null): void {
  // Special handling for GOOGLE_CLOUD_PROJECT in Cloud Shell:
  // Because GOOGLE_CLOUD_PROJECT in Cloud Shell tracks the project
  // set by the user using "gcloud config set project" we do not want to
  // use its value. So, unless the user overrides GOOGLE_CLOUD_PROJECT in
  // one of the .env files, we set the Cloud Shell-specific default here.
  if (envFilePath && fs.existsSync(envFilePath)) {
    const envFileContent = fs.readFileSync(envFilePath);
    const parsedEnv = dotenv.parse(envFileContent);
    if (parsedEnv['GOOGLE_CLOUD_PROJECT']) {
      // .env file takes precedence in Cloud Shell
      process.env['GOOGLE_CLOUD_PROJECT'] = parsedEnv['GOOGLE_CLOUD_PROJECT'];
    } else {
      // If not in .env, set to default and override global
      process.env['GOOGLE_CLOUD_PROJECT'] = 'cloudshell-gca';
    }
  } else {
    // If no .env file, set to default and override global
    process.env['GOOGLE_CLOUD_PROJECT'] = 'cloudshell-gca';
  }
}
/**
 * Loads environment variables from .env files and settings.env.
 *
 * Priority order (highest to lowest):
 * 1. CLI flags
 * 2. process.env (system/export/inline environment variables)
 * 3. .env files (no-override mode)
 * 4. settings.env (no-override mode)
 * 5. defaults
 */
export function loadEnvironment(settings: Settings): void {
  const envFilePath = findEnvFile(settings, process.cwd());

  // Cloud Shell environment variable handling
  if (process.env['CLOUD_SHELL'] === 'true') {
    setUpCloudShellEnvironment(envFilePath);
  }

  // Step 1: Load from .env files (higher priority than settings.env)
  // Only set if not already present in process.env (no-override mode)
  if (envFilePath) {
    try {
      const envFileContent = fs.readFileSync(envFilePath, 'utf-8');
      const parsedEnv = dotenv.parse(envFileContent);

      const excludedVars =
        settings?.advanced?.excludedEnvVars || DEFAULT_EXCLUDED_ENV_VARS;
      const isProjectEnvFile = !envFilePath.includes(QWEN_DIR);

      for (const key in parsedEnv) {
        if (Object.hasOwn(parsedEnv, key)) {
          // If it's a project .env file, skip loading excluded variables.
          if (isProjectEnvFile && excludedVars.includes(key)) {
            continue;
          }

          // Only set if not already present in process.env (no-override)
          if (!Object.hasOwn(process.env, key)) {
            process.env[key] = parsedEnv[key];
          }
        }
      }
    } catch (_e) {
      // Errors are ignored to match the behavior of `dotenv.config({ quiet: true })`.
    }
  }

  // Step 2: Load environment variables from settings.env as fallback (lowest priority)
  // Only set if not already present (no-override, after .env is loaded)
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (!Object.hasOwn(process.env, key) && typeof value === 'string') {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Loads settings from user and workspace directories.
 * Project settings override user settings.
 */
export function loadSettings(
  workspaceDir: string = process.cwd(),
): LoadedSettings {
  let systemSettings: Settings = {};
  let systemDefaultSettings: Settings = {};
  let userSettings: Settings = {};
  let workspaceSettings: Settings = {};
  const settingsErrors: SettingsError[] = [];
  const systemSettingsPath = getSystemSettingsPath();
  const systemDefaultsPath = getSystemDefaultsPath();
  const migratedInMemorScopes = new Set<SettingScope>();

  // Resolve paths to their canonical representation to handle symlinks
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedHomeDir = path.resolve(homedir());

  let realWorkspaceDir = resolvedWorkspaceDir;
  try {
    // fs.realpathSync gets the "true" path, resolving any symlinks
    realWorkspaceDir = fs.realpathSync(resolvedWorkspaceDir);
  } catch (_e) {
    // This is okay. The path might not exist yet, and that's a valid state.
  }

  // We expect homedir to always exist and be resolvable.
  const realHomeDir = fs.realpathSync(resolvedHomeDir);

  const workspaceSettingsPath = new Storage(
    workspaceDir,
  ).getWorkspaceSettingsPath();

  const loadAndMigrate = (
    filePath: string,
    scope: SettingScope,
  ): { settings: Settings; rawJson?: string } => {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const rawSettings: unknown = JSON.parse(stripJsonComments(content));

        if (
          typeof rawSettings !== 'object' ||
          rawSettings === null ||
          Array.isArray(rawSettings)
        ) {
          settingsErrors.push({
            message: 'Settings file is not a valid JSON object.',
            path: filePath,
          });
          return { settings: {} };
        }

        let settingsObject = rawSettings as Record<string, unknown>;
        if (needsMigration(settingsObject)) {
          const migratedSettings = migrateV1ToV3(settingsObject);
          if (migratedSettings) {
            if (MIGRATE_V2_OVERWRITE) {
              try {
                fs.renameSync(filePath, `${filePath}.orig`);
                fs.writeFileSync(
                  filePath,
                  JSON.stringify(migratedSettings, null, 2),
                  'utf-8',
                );
              } catch (e) {
                writeStderrLine(
                  `Error migrating settings file on disk: ${getErrorMessage(
                    e,
                  )}`,
                );
              }
            } else {
              migratedInMemorScopes.add(scope);
            }
            settingsObject = migratedSettings;
          }
        } else if (!(SETTINGS_VERSION_KEY in settingsObject)) {
          // No migration needed, but version field is missing - add it for future optimizations
          settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
          if (MIGRATE_V2_OVERWRITE) {
            try {
              fs.writeFileSync(
                filePath,
                JSON.stringify(settingsObject, null, 2),
                'utf-8',
              );
            } catch (e) {
              writeStderrLine(
                `Error adding version to settings file: ${getErrorMessage(e)}`,
              );
            }
          }
        }

        // V2 to V3 migration (invert disable* -> enable* booleans)
        const v3Migrated = migrateV2ToV3(settingsObject);
        if (v3Migrated) {
          if (MIGRATE_V2_OVERWRITE) {
            try {
              // Only backup if not already backed up by V1->V2 migration
              const backupPath = `${filePath}.orig`;
              if (!fs.existsSync(backupPath)) {
                fs.renameSync(filePath, backupPath);
              }
              fs.writeFileSync(
                filePath,
                JSON.stringify(v3Migrated, null, 2),
                'utf-8',
              );
            } catch (e) {
              writeStderrLine(
                `Error migrating settings file to V3: ${getErrorMessage(e)}`,
              );
            }
          } else {
            migratedInMemorScopes.add(scope);
          }
          settingsObject = v3Migrated;
        }

        return { settings: settingsObject as Settings, rawJson: content };
      }
    } catch (error: unknown) {
      settingsErrors.push({
        message: getErrorMessage(error),
        path: filePath,
      });
    }
    return { settings: {} };
  };

  const systemResult = loadAndMigrate(systemSettingsPath, SettingScope.System);
  const systemDefaultsResult = loadAndMigrate(
    systemDefaultsPath,
    SettingScope.SystemDefaults,
  );
  const userResult = loadAndMigrate(USER_SETTINGS_PATH, SettingScope.User);

  let workspaceResult: { settings: Settings; rawJson?: string } = {
    settings: {} as Settings,
    rawJson: undefined,
  };
  if (realWorkspaceDir !== realHomeDir) {
    workspaceResult = loadAndMigrate(
      workspaceSettingsPath,
      SettingScope.Workspace,
    );
  }

  const systemOriginalSettings = structuredClone(systemResult.settings);
  const systemDefaultsOriginalSettings = structuredClone(
    systemDefaultsResult.settings,
  );
  const userOriginalSettings = structuredClone(userResult.settings);
  const workspaceOriginalSettings = structuredClone(workspaceResult.settings);

  // Environment variables for runtime use
  systemSettings = resolveEnvVarsInObject(systemResult.settings);
  systemDefaultSettings = resolveEnvVarsInObject(systemDefaultsResult.settings);
  userSettings = resolveEnvVarsInObject(userResult.settings);
  workspaceSettings = resolveEnvVarsInObject(workspaceResult.settings);

  // Support legacy theme names
  if (userSettings.ui?.theme === 'VS') {
    userSettings.ui.theme = DefaultLight.name;
  } else if (userSettings.ui?.theme === 'VS2015') {
    userSettings.ui.theme = DefaultDark.name;
  }
  if (workspaceSettings.ui?.theme === 'VS') {
    workspaceSettings.ui.theme = DefaultLight.name;
  } else if (workspaceSettings.ui?.theme === 'VS2015') {
    workspaceSettings.ui.theme = DefaultDark.name;
  }

  // For the initial trust check, we can only use user and system settings.
  const initialTrustCheckSettings = customDeepMerge(
    getMergeStrategyForPath,
    {},
    systemSettings,
    userSettings,
  );
  const isTrusted =
    isWorkspaceTrusted(initialTrustCheckSettings as Settings).isTrusted ?? true;

  // Create a temporary merged settings object to pass to loadEnvironment.
  const tempMergedSettings = mergeSettings(
    systemSettings,
    systemDefaultSettings,
    userSettings,
    workspaceSettings,
    isTrusted,
  );

  // loadEnviroment depends on settings so we have to create a temp version of
  // the settings to avoid a cycle
  loadEnvironment(tempMergedSettings);

  // Create LoadedSettings first

  if (settingsErrors.length > 0) {
    const errorMessages = settingsErrors.map(
      (error) => `Error in ${error.path}: ${error.message}`,
    );
    throw new FatalConfigError(
      `${errorMessages.join('\n')}\nPlease fix the configuration file(s) and try again.`,
    );
  }

  return new LoadedSettings(
    {
      path: systemSettingsPath,
      settings: systemSettings,
      originalSettings: systemOriginalSettings,
      rawJson: systemResult.rawJson,
    },
    {
      path: systemDefaultsPath,
      settings: systemDefaultSettings,
      originalSettings: systemDefaultsOriginalSettings,
      rawJson: systemDefaultsResult.rawJson,
    },
    {
      path: USER_SETTINGS_PATH,
      settings: userSettings,
      originalSettings: userOriginalSettings,
      rawJson: userResult.rawJson,
    },
    {
      path: workspaceSettingsPath,
      settings: workspaceSettings,
      originalSettings: workspaceOriginalSettings,
      rawJson: workspaceResult.rawJson,
    },
    isTrusted,
    migratedInMemorScopes,
  );
}

export function saveSettings(settingsFile: SettingsFile): void {
  try {
    // Ensure the directory exists
    const dirPath = path.dirname(settingsFile.path);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    let settingsToSave = settingsFile.originalSettings;
    if (!MIGRATE_V2_OVERWRITE) {
      settingsToSave = migrateSettingsToV1(
        settingsToSave as Record<string, unknown>,
      ) as Settings;
    }

    // Use the format-preserving update function
    updateSettingsFilePreservingFormat(
      settingsFile.path,
      settingsToSave as Record<string, unknown>,
    );
  } catch (error) {
    writeStderrLine('Error saving user settings file.');
    writeStderrLine(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
