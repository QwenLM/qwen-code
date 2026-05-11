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
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import stripJsonComments from 'strip-json-comments';
import { DefaultLight } from '../ui/themes/default-light.js';
import { DefaultDark } from '../ui/themes/default.js';
import { isWorkspaceTrusted } from './trustedFolders.js';
import { hasOwnModelProviders } from './modelProvidersScope.js';
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
import { runMigrations, needsMigration } from './migration/index.js';
import {
  V1_TO_V2_MIGRATION_MAP,
  V2_CONTAINER_KEYS,
} from './migration/versions/v1-to-v2-shared.js';

const debugLogger = createDebugLogger('SETTINGS');

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

export const SETTINGS_DIRECTORY_NAME = QWEN_DIR;

// Lazy getters: must NOT be top-level consts. `QWEN_HOME` may be resolved
// from `~/.env` or `~/.qwen/.env` by `preResolveHomeEnvOverrides()` in
// `loadSettings()`, which runs after this module is imported. A const
// captured here would freeze the pre-bootstrap value and split state across
// callers.
export function getUserSettingsPath(): string {
  return Storage.getGlobalSettingsPath();
}
export function getUserSettingsDir(): string {
  return path.dirname(getUserSettingsPath());
}
export const DEFAULT_EXCLUDED_ENV_VARS = ['DEBUG', 'DEBUG_MODE'];

// QWEN_HOME and QWEN_RUNTIME_DIR control where global state (settings, OAuth
// credentials, installation IDs, etc.) is written. A project `.env` must never
// redirect these — that would split global state between the real home and a
// project-controlled directory. Always excluded from project .env files,
// regardless of user-configurable `advanced.excludedEnvVars`.
const PROJECT_ENV_HARDCODED_EXCLUSIONS = ['QWEN_HOME', 'QWEN_RUNTIME_DIR'];

// Settings version to track migration state
export const SETTINGS_VERSION = 4;
export const SETTINGS_VERSION_KEY = '$version';

/**
 * Migrate legacy tool permission settings (tools.core / tools.allowed / tools.exclude)
 * to the new permissions.allow / permissions.ask / permissions.deny format.
 *
 * Conversion rules:
 *   tools.allowed  → permissions.allow (bypass confirmation)
 *   tools.exclude  → permissions.deny  (block tools)
 *   tools.core     → permissions.allow (only listed tools enabled)
 *                    + permissions.deny with a wildcard deny-all if needed
 *
 * Returns the updated settings object, or null if no migration is needed.
 */
export function migrateLegacyPermissions(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  const tools = settings['tools'] as Record<string, unknown> | undefined;
  if (!tools) return null;

  const hasLegacy =
    Array.isArray(tools['core']) ||
    Array.isArray(tools['allowed']) ||
    Array.isArray(tools['exclude']);

  if (!hasLegacy) return null;

  const result = structuredClone(settings) as Record<string, unknown>;
  const resultTools = result['tools'] as Record<string, unknown>;
  const permissions = (result['permissions'] as Record<string, unknown>) ?? {};
  result['permissions'] = permissions;

  const mergeInto = (key: string, items: string[]) => {
    const existing = Array.isArray(permissions[key])
      ? (permissions[key] as string[])
      : [];
    const merged = Array.from(new Set([...existing, ...items]));
    permissions[key] = merged;
  };

  // tools.allowed → permissions.allow
  if (Array.isArray(resultTools['allowed'])) {
    mergeInto('allow', resultTools['allowed'] as string[]);
    delete resultTools['allowed'];
  }

  // tools.exclude → permissions.deny
  if (Array.isArray(resultTools['exclude'])) {
    mergeInto('deny', resultTools['exclude'] as string[]);
    delete resultTools['exclude'];
  }

  // tools.core → permissions.allow (explicit enables)
  // IMPORTANT: tools.core has whitelist semantics: "only these tools can run".
  // To preserve this, we also add deny rules for all tools NOT in the list.
  // A wildcard deny-all followed by specific allows achieves this because
  // allow rules take precedence over the catch-all deny in the evaluation order:
  //   deny = [everything not listed], allow = [listed tools]
  // However, since our priority is deny > allow, we cannot use a blanket deny.
  // Instead we just migrate to allow (auto-approve) and let the coreTools
  // semantics continue to work through the Config.getCoreTools() path until
  // the old API is fully removed.
  if (Array.isArray(resultTools['core'])) {
    mergeInto('allow', resultTools['core'] as string[]);
    delete resultTools['core'];
  }

  return result;
}

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

  // Unknown top-level keys — log silently to debug output.
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

    debugLogger.warn(
      `Unknown setting '${key}' will be ignored in ${settingsFilePath}.`,
    );
  }

  return warnings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAnyProviderEntries(modelProviders: unknown): boolean {
  if (!isPlainObject(modelProviders)) {
    return false;
  }

  return Object.values(modelProviders).some(
    (providerModels) =>
      Array.isArray(providerModels) && providerModels.length > 0,
  );
}

function getModelProvidersOverrideWarnings(
  loadedSettings: LoadedSettings,
): string[] {
  // Untrusted workspaces are ignored in merge, so they cannot shadow user modelProviders.
  if (!loadedSettings.isTrusted) {
    return [];
  }

  const userOriginal = loadedSettings.user
    .originalSettings as unknown as Record<string, unknown>;
  const workspaceOriginal = loadedSettings.workspace
    .originalSettings as unknown as Record<string, unknown>;

  if (
    !hasOwnModelProviders(userOriginal) ||
    !hasOwnModelProviders(workspaceOriginal)
  ) {
    return [];
  }

  const userModelProviders = userOriginal['modelProviders'];
  const workspaceModelProviders = workspaceOriginal['modelProviders'];
  const workspaceIsEmptyModelProviders =
    isPlainObject(workspaceModelProviders) &&
    Object.keys(workspaceModelProviders).length === 0;

  if (
    !workspaceIsEmptyModelProviders ||
    !hasAnyProviderEntries(userModelProviders)
  ) {
    return [];
  }

  return [
    `Warning: '${loadedSettings.workspace.path}' defines an empty 'modelProviders' object. ` +
      `This has no effect with current merge behavior, but may indicate a configuration error. ` +
      `If REPLACE semantics are introduced for 'modelProviders' in the future, this would override user-level model providers in '${loadedSettings.user.path}'.`,
  ];
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

  for (const warning of getModelProvidersOverrideWarnings(loadedSettings)) {
    warningSet.add(warning);
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
    saveSettings(settingsFile, createSettingsUpdate(key, value));
  }

  recomputeMerged(): void {
    this._merged = this.computeMergedSettings();
  }

  /**
   * Get user-level hooks from user settings (not merged with workspace).
   * These hooks should always be loaded regardless of folder trust.
   */
  getUserHooks(): Record<string, unknown> | undefined {
    return this.user.settings.hooks;
  }

  /**
   * Get project-level hooks from workspace settings (not merged).
   * Returns undefined if workspace is not trusted (hooks filtered out).
   */
  getProjectHooks(): Record<string, unknown> | undefined {
    // Only return project hooks if workspace is trusted
    if (!this.isTrusted) {
      return undefined;
    }
    return this.workspace.settings.hooks;
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
 * Returns the set of normalized .env file paths that count as user-level.
 *
 * User-level paths cover the home `.env` and the global Qwen config dir
 * `.env` (which respects `QWEN_HOME`). When `QWEN_HOME` redirects elsewhere,
 * the legacy `<homedir>/.qwen/.env` is also included so credentials users
 * left there continue to load (and the trust check in untrusted workspaces
 * still allows reading it).
 */
function getUserLevelEnvPaths(): Set<string> {
  const homeDir = homedir();
  const globalQwenDir = Storage.getGlobalQwenDir();
  const paths = new Set([
    path.normalize(path.join(homeDir, '.env')),
    path.normalize(path.join(globalQwenDir, '.env')),
  ]);
  const legacyQwenEnv = path.normalize(path.join(homeDir, QWEN_DIR, '.env'));
  paths.add(legacyQwenEnv);
  return paths;
}

/**
 * Pre-resolves QWEN_HOME and QWEN_RUNTIME_DIR from user-level `.env` files
 * before any settings or storage paths are read. Required because
 * module-load `Storage.getGlobalQwenDir()` would otherwise snapshot legacy
 * paths for settings.json, OAuth tokens, installation_id, etc., while the
 * regular `.env` load (inside `loadSettings`) only runs later — splitting
 * global state between `~/.qwen/...` and `<QWEN_HOME>/...`.
 *
 * Only home-scoped paths are consulted; project `.env` files are barred from
 * changing these vars by `PROJECT_ENV_HARDCODED_EXCLUSIONS`.
 *
 * Exported so `main()` can run it before yargs subcommand handlers (e.g.
 * `channel status`/`stop`) — those `process.exit` before `loadSettings()`
 * gets a chance to bootstrap.
 */
let homeEnvBootstrapped = false;
export function preResolveHomeEnvOverrides(): void {
  if (homeEnvBootstrapped) {
    return;
  }
  homeEnvBootstrapped = true;

  if (process.env['QWEN_HOME'] && process.env['QWEN_RUNTIME_DIR']) {
    return;
  }

  // Storage.getGlobalQwenDir() shares the same homedir resolution as the
  // rest of the storage layer; when QWEN_HOME is unset it equals
  // `<homedir>/.qwen`, so path.dirname() recovers `<homedir>`.
  const initialQwenHome = process.env['QWEN_HOME'];
  const initialQwenDir = Storage.getGlobalQwenDir();
  const candidates: string[] = [path.join(initialQwenDir, '.env')];
  if (!initialQwenHome) {
    candidates.push(path.join(path.dirname(initialQwenDir), '.env'));
  }

  for (const candidate of candidates) {
    readHomeEnvInto(candidate);
  }

  // If QWEN_HOME was just discovered, also read <new QWEN_HOME>/.env so
  // QWEN_RUNTIME_DIR can be sourced from there (mirrors the VS Code
  // companion's bootstrapHomeEnvOverrides — without this third pass the
  // CLI and companion would diverge on the runtime dir).
  const discoveredQwenHome = process.env['QWEN_HOME'];
  if (discoveredQwenHome && discoveredQwenHome !== initialQwenHome) {
    const discoveredDir = Storage.getGlobalQwenDir();
    if (discoveredDir !== initialQwenDir) {
      readHomeEnvInto(path.join(discoveredDir, '.env'));
    }
  }
}

function readHomeEnvInto(file: string): void {
  if (!fs.existsSync(file)) {
    return;
  }
  try {
    const parsed = dotenv.parse(fs.readFileSync(file, 'utf-8'));
    for (const key of PROJECT_ENV_HARDCODED_EXCLUSIONS) {
      if (parsed[key] && !Object.hasOwn(process.env, key)) {
        process.env[key] = parsed[key];
      }
    }
  } catch (_e) {
    // Match the dotenv quiet-mode behavior used by loadEnvironment below.
  }
}

/** Test-only: reset the home-env bootstrap latch. */
export function resetHomeEnvBootstrapForTesting(): void {
  homeEnvBootstrapped = false;
}

/**
 * Surfaces a one-shot warning when QWEN_HOME has been redirected but the
 * user hasn't migrated their existing global state. Auto-copying OAuth
 * tokens / settings / memory is intentionally skipped, but silently starting
 * fresh is a footgun. Returns null when there's nothing to warn about.
 */
function detectQwenHomeRedirectWithoutMigration(
  activeUserSettingsPath: string,
): string | null {
  if (!process.env['QWEN_HOME']) {
    return null;
  }
  // Compute the legacy path by briefly unsetting QWEN_HOME so Storage uses
  // its homedir-based default — same homedir resolution as the rest of the
  // storage layer. try/finally restores the env on any throw.
  const activeQwenDir = Storage.getGlobalQwenDir();
  const savedQwenHome = process.env['QWEN_HOME'];
  delete process.env['QWEN_HOME'];
  let legacyQwenDir: string;
  try {
    legacyQwenDir = Storage.getGlobalQwenDir();
  } finally {
    process.env['QWEN_HOME'] = savedQwenHome;
  }
  if (path.resolve(activeQwenDir) === path.resolve(legacyQwenDir)) {
    return null;
  }
  if (fs.existsSync(activeUserSettingsPath)) {
    return null;
  }
  const legacyUserSettings = path.join(legacyQwenDir, 'settings.json');
  if (!fs.existsSync(legacyUserSettings)) {
    return null;
  }
  return (
    `QWEN_HOME points to "${activeQwenDir}" but no settings.json was found there. ` +
    `Existing config remains at "${legacyQwenDir}" — OAuth tokens, settings, memory, ` +
    `extensions, and skills are not auto-migrated. Copy them manually if you want them ` +
    `to apply at the new location.`
  );
}

/**
 * Finds the .env file to load, respecting workspace trust settings.
 *
 * When workspace is untrusted, only allow user-level .env files at:
 * - ~/.qwen/.env
 * - ~/.env
 * - <QWEN_HOME>/.env (when set)
 */
function findEnvFile(
  settings: Settings,
  startDir: string,
  userLevelPaths: Set<string> = getUserLevelEnvPaths(),
): string | null {
  const homeDir = homedir();
  const isTrusted = isWorkspaceTrusted(settings).isTrusted;

  const globalQwenDir = Storage.getGlobalQwenDir();
  const legacyQwenDir = path.normalize(path.join(homeDir, QWEN_DIR));
  const hasCustomConfigDir = path.normalize(globalQwenDir) !== legacyQwenDir;

  const canUseEnvFile = (filePath: string): boolean =>
    isTrusted !== false || userLevelPaths.has(path.normalize(filePath));

  // Home-dir candidates in priority order: globalQwenDir/.env, then legacy
  // ~/.qwen/.env (only when QWEN_HOME redirects), then ~/.env.
  // Users who add `QWEN_HOME=` to an existing global env file shouldn't lose
  // credentials still in the legacy file; routing vars inside it are already
  // pinned by `preResolveHomeEnvOverrides` (no-override).
  const findHomeCandidate = (): string | null => {
    const candidates = [path.join(globalQwenDir, '.env')];
    if (hasCustomConfigDir) {
      candidates.push(path.join(legacyQwenDir, '.env'));
    }
    candidates.push(path.join(homeDir, '.env'));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && canUseEnvFile(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  let currentDir = path.resolve(startDir);
  let visitedHomeDir = false;
  while (true) {
    if (currentDir === homeDir) {
      visitedHomeDir = true;
      const found = findHomeCandidate();
      if (found) return found;
    } else {
      // Workspace step: prefer .qwen/.env, then plain .env.
      const geminiEnvPath = path.join(currentDir, QWEN_DIR, '.env');
      if (fs.existsSync(geminiEnvPath) && canUseEnvFile(geminiEnvPath)) {
        return geminiEnvPath;
      }
      const envPath = path.join(currentDir, '.env');
      if (fs.existsSync(envPath) && canUseEnvFile(envPath)) {
        return envPath;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      return visitedHomeDir ? null : findHomeCandidate();
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
  const userLevelPaths = getUserLevelEnvPaths();
  const envFilePath = findEnvFile(settings, process.cwd(), userLevelPaths);

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
      const normalizedEnvFilePath = path.normalize(envFilePath);
      // homeScoped: `.env` lives under the user's home Qwen dir or `~/.env` —
      //   only these may set QWEN_HOME / QWEN_RUNTIME_DIR.
      // qwenScoped: any `.env` whose immediate parent is `.qwen` (including
      //   `<repo>/.qwen/.env`) — exempt from the user `excludedEnvVars` list.
      const isHomeScopedEnvFile = userLevelPaths.has(normalizedEnvFilePath);
      const isQwenScopedEnvFile =
        isHomeScopedEnvFile ||
        path.basename(path.dirname(normalizedEnvFilePath)) === QWEN_DIR;

      for (const key in parsedEnv) {
        if (Object.hasOwn(parsedEnv, key)) {
          if (
            !isHomeScopedEnvFile &&
            PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)
          ) {
            continue;
          }
          if (!isQwenScopedEnvFile && excludedVars.includes(key)) {
            continue;
          }

          if (!Object.hasOwn(process.env, key)) {
            process.env[key] = parsedEnv[key];
          }
        }
      }
    } catch (_e) {
      // Errors are ignored to match the behavior of `dotenv.config({ quiet: true })`.
    }
  }

  // Step 2: settings.env fallback (lowest priority, no-override).
  // Storage-routing vars must never come from settings.json — a workspace
  // settings.json could otherwise redirect global state after path bootstrap.
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)) {
        continue;
      }
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
  // Apply any QWEN_HOME / QWEN_RUNTIME_DIR set in user-level `.env` files
  // BEFORE any code reads a path derived from them. After this call, the
  // lazy `getUserSettingsPath()` / `Storage.getGlobalQwenDir()` getters
  // return the post-bootstrap value.
  preResolveHomeEnvOverrides();
  const userSettingsPath = getUserSettingsPath();
  const qwenHomeRedirectWarning =
    detectQwenHomeRedirectWithoutMigration(userSettingsPath);

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
  ): { settings: Settings; rawJson?: string; migrationWarnings?: string[] } => {
    try {
      if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf-8');
        let rawSettings: unknown;
        let recoveryWarning: string | undefined;

        try {
          rawSettings = JSON.parse(stripJsonComments(content));
        } catch (parseError: unknown) {
          // JSON parse failed — try to recover from .orig backup
          const backupPath = `${filePath}.orig`;
          if (fs.existsSync(backupPath)) {
            debugLogger.warn(
              `Settings file ${filePath} has invalid JSON (${getErrorMessage(parseError)}). Attempting recovery from backup ${backupPath}.`,
            );
            try {
              const backupContent = fs.readFileSync(backupPath, 'utf-8');
              const backupSettings = JSON.parse(
                stripJsonComments(backupContent),
              );
              // Backup is valid — restore it
              fs.writeFileSync(filePath, backupContent, 'utf-8');
              content = backupContent;
              rawSettings = backupSettings;
              const recoveryMsg = `Settings file ${filePath} had invalid JSON and was recovered from backup ${backupPath}. Some recent settings changes may have been lost.`;
              debugLogger.warn(recoveryMsg);
              // Surface warning to user so they know settings were rolled back
              recoveryWarning = recoveryMsg;
            } catch (backupError) {
              // Could be invalid JSON, read error, or write-back failure
              debugLogger.warn(
                `Failed to recover from backup ${backupPath}: ${getErrorMessage(backupError)}. Falling back to empty settings.`,
              );
            }
          }

          // No valid backup available — rename the corrupted file so the app
          // can start with empty settings rather than crashing.
          if (!rawSettings) {
            const corruptedPath = `${filePath}.corrupted.${Date.now()}`;
            let warningMsg: string;
            try {
              fs.renameSync(filePath, corruptedPath);
              warningMsg = `Settings file ${filePath} has invalid JSON and was renamed to ${corruptedPath}. Your settings have been reset. To recover, fix the JSON in ${corruptedPath} and rename it back.`;
            } catch (renameError) {
              // If rename fails, still proceed with empty settings
              debugLogger.error(
                `Failed to rename corrupted settings file: ${getErrorMessage(renameError)}`,
              );
              warningMsg = `Settings file ${filePath} has invalid JSON. Your settings have been reset. Please fix the JSON in ${filePath} manually.`;
            }
            debugLogger.warn(warningMsg);
            return {
              settings: {},
              migrationWarnings: [warningMsg],
            };
          }
        }

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
            // Use sync mode to remove deprecated keys (zombie key prevention)
            // while preserving comments and formatting from the original file.
            // updateSettingsFilePreservingFormat handles atomicity internally
            // via temp-file + rename writes.
            const written = updateSettingsFilePreservingFormat(
              filePath,
              settingsObject,
              true,
            );
            if (!written) {
              debugLogger.error(
                `${warningPrefix}: updateSettingsFilePreservingFormat returned false for ${filePath}`,
              );
            }
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

        // Prepend recovery warning if settings were restored from backup
        const allWarnings = [
          ...(recoveryWarning ? [recoveryWarning] : []),
          ...(migrationWarnings ?? []),
        ];

        return {
          settings: settingsObject as Settings,
          rawJson: content,
          migrationWarnings:
            allWarnings.length > 0 ? allWarnings : migrationWarnings,
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
  const userResult = loadAndMigrate(userSettingsPath, SettingScope.User);

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
    ...(qwenHomeRedirectWarning ? [qwenHomeRedirectWarning] : []),
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
      path: userSettingsPath,
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

function createSettingsUpdate(
  key: string,
  value: unknown,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  setNestedPropertySafe(root, key, value);
  return root;
}

export function saveSettings(
  settingsFile: SettingsFile,
  updates: Record<string, unknown> = settingsFile.originalSettings as Record<
    string,
    unknown
  >,
): void {
  try {
    // Ensure the directory exists
    const dirPath = path.dirname(settingsFile.path);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Use the format-preserving update function
    updateSettingsFilePreservingFormat(settingsFile.path, updates);
  } catch (error) {
    debugLogger.error('Error saving user settings file.');
    debugLogger.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
