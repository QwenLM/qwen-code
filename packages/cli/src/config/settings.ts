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
  setDebugLogSession,
  sanitizeCwd,
  createDebugLogger,
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
import { setNestedPropertySafe } from '../utils/settingsUtils.js';
import { customDeepMerge } from '../utils/deepMerge.js';
import { updateSettingsFilePreservingFormat } from '../utils/commentJson.js';
const debugLogger = createDebugLogger('SETTINGS');
import { runMigrations, needsMigration } from './migration/index.js';
import {
  V1_TO_V2_MIGRATION_MAP,
  V2_CONTAINER_KEYS,
} from './migration/versions/v1-to-v2-shared.js';
import { writeWithBackupSync } from '../utils/writeWithBackup.js';

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

// Settings version to track migration state
export const SETTINGS_VERSION = 3;
export const SETTINGS_VERSION_KEY = '$version';

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
  for (const [oldKey, newPath] of Object.entries(V1_TO_V2_MIGRATION_MAP)) {
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
      V2_CONTAINER_KEYS.has(oldKey) &&
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
 * Collects warnings for ignored legacy and unknown settings keys,
 * as well as migration warnings.
 *
 * For `$version: 2` settings files, we do not apply implicit migrations.
 * Instead, we surface actionable, de-duplicated warnings in the terminal UI.
 */
export function getSettingsWarnings(loadedSettings: LoadedSettings): string[] {
  const warningSet = new Set<string>();

  // Add migration warnings first
  for (const warning of loadedSettings.migrationWarnings) {
    warningSet.add(`Warning: ${warning}`);
  }

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
    migrationWarnings: string[] = [],
  ) {
    this.system = system;
    this.systemDefaults = systemDefaults;
    this.user = user;
    this.workspace = workspace;
    this.isTrusted = isTrusted;
    this.migratedInMemorScopes = migratedInMemorScopes;
    this.migrationWarnings = migrationWarnings;
    this._merged = this.computeMergedSettings();
  }

  readonly system: SettingsFile;
  readonly systemDefaults: SettingsFile;
  readonly user: SettingsFile;
  readonly workspace: SettingsFile;
  readonly isTrusted: boolean;
  readonly migratedInMemorScopes: Set<SettingScope>;
  readonly migrationWarnings: string[];

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
    setNestedPropertySafe(settingsFile.settings, key, value);
    setNestedPropertySafe(settingsFile.originalSettings, key, value);
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
    [],
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
  // Set up a temporary debug log session for the startup phase.
  // This allows migration errors to be logged to file instead of being
  // exposed to users via stderr. The Config class will override this
  // with the actual session once initialized.
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const sanitizedProjectId = sanitizeCwd(resolvedWorkspaceDir);
  setDebugLogSession({
    getSessionId: () => `startup-${sanitizedProjectId}`,
  });

  let systemSettings: Settings = {};
  let systemDefaultSettings: Settings = {};
  let userSettings: Settings = {};
  let workspaceSettings: Settings = {};
  const settingsErrors: SettingsError[] = [];
  const systemSettingsPath = getSystemSettingsPath();
  const systemDefaultsPath = getSystemDefaultsPath();
  const migratedInMemorScopes = new Set<SettingScope>();

  // Resolve paths to their canonical representation to handle symlinks
  // Note: resolvedWorkspaceDir is already defined at the top of the function
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
  ): { settings: Settings; rawJson?: string; migrationWarnings?: string[] } => {
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
        const hasVersionKey = SETTINGS_VERSION_KEY in settingsObject;
        const versionValue = settingsObject[SETTINGS_VERSION_KEY];
        const hasInvalidVersion =
          hasVersionKey && typeof versionValue !== 'number';
        const hasLegacyNumericVersion =
          typeof versionValue === 'number' && versionValue < SETTINGS_VERSION;
        let migrationWarnings: string[] | undefined;

        const persistSettingsObject = (warningPrefix: string) => {
          try {
            writeWithBackupSync(
              filePath,
              JSON.stringify(settingsObject, null, 2),
            );
          } catch (e) {
            debugLogger.error(`${warningPrefix}: ${getErrorMessage(e)}`);
          }
        };

        if (needsMigration(settingsObject)) {
          const migrationResult = runMigrations(settingsObject, scope);
          if (migrationResult.executedMigrations.length > 0) {
            settingsObject = migrationResult.settings as Record<
              string,
              unknown
            >;
            migrationWarnings = migrationResult.warnings;
            persistSettingsObject('Error migrating settings file on disk');
          } else if (hasLegacyNumericVersion || hasInvalidVersion) {
            // Migration was deemed needed but nothing executed. Normalize version metadata
            // to avoid repeated no-op checks on startup.
            settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
            debugLogger.warn(
              `Settings version metadata in ${filePath} could not be migrated by any registered migration. Normalizing ${SETTINGS_VERSION_KEY} to ${SETTINGS_VERSION}.`,
            );
            persistSettingsObject('Error normalizing settings version on disk');
          }
        } else if (
          !hasVersionKey ||
          hasInvalidVersion ||
          hasLegacyNumericVersion
        ) {
          // No migration needed/executable, but version metadata is missing or invalid.
          // Normalize it to current version to avoid repeated startup work.
          settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
          persistSettingsObject('Error normalizing settings version on disk');
        }

        return {
          settings: settingsObject as Settings,
          rawJson: content,
          migrationWarnings,
        };
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

  let workspaceResult: {
    settings: Settings;
    rawJson?: string;
    migrationWarnings?: string[];
  } = {
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

  // Collect all migration warnings from all scopes
  const allMigrationWarnings: string[] = [
    ...(systemResult.migrationWarnings ?? []),
    ...(systemDefaultsResult.migrationWarnings ?? []),
    ...(userResult.migrationWarnings ?? []),
    ...(workspaceResult.migrationWarnings ?? []),
  ];

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
    allMigrationWarnings,
  );
}

export function saveSettings(settingsFile: SettingsFile): void {
  try {
    // Ensure the directory exists
    const dirPath = path.dirname(settingsFile.path);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Use the format-preserving update function
    updateSettingsFilePreservingFormat(
      settingsFile.path,
      settingsFile.originalSettings as Record<string, unknown>,
    );
  } catch (error) {
    debugLogger.error('Error saving user settings file.');
    debugLogger.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
