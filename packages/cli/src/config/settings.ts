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
  stripRuntimeSnapshotPrefix,
} from '@qwen-code/qwen-code-core';
import type {
  MCPServerConfig,
  McpServerScope,
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

// Env var names used for inter-process communication of corruption state.
// Defined as constants to avoid duplicated string literals.
export const ENV_CORRUPTED_PATH = 'QWEN_CODE_SETTINGS_CORRUPTED_PATH';
export const ENV_WAS_RECOVERED = 'QWEN_CODE_SETTINGS_WAS_RECOVERED';

// QWEN_HOME and QWEN_RUNTIME_DIR control where global state (settings, OAuth
// credentials, installation IDs, etc.) is written. A project `.env` must never
// redirect these — that would split global state between the real home and a
// project-controlled directory. Always excluded from project .env files,
// regardless of user-configurable `advanced.excludedEnvVars`.
const PROJECT_ENV_HARDCODED_EXCLUSIONS = [
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'QWEN_CODE_MCP_APPROVALS_PATH',
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
];

const RELOAD_EXCLUDED_KEYS = new Set([
  ...PROJECT_ENV_HARDCODED_EXCLUSIONS,
  'QWEN_SERVER_TOKEN',
  'QWEN_CLI_ENTRY',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
]);

const dotEnvSourcedKeys = new Set<string>();
const settingsEnvSourcedKeys = new Set<string>();
const lastReloadSnapshot = new Map<string, string>();
let lastReloadSnapshotSeeded = false;

// Settings version to track migration state
export const SETTINGS_VERSION = 5;
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

  return Object.values(modelProviders).some((providerModels) => {
    if (Array.isArray(providerModels)) {
      return providerModels.length > 0;
    }
    if (isPlainObject(providerModels)) {
      const models = (providerModels as Record<string, unknown>)['models'];
      return Array.isArray(models) && models.length > 0;
    }
    return false;
  });
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

/**
 * Stamp every MCP server in a scope's settings with its provenance `scope`
 * BEFORE the merge, so the winning entry of the shallow `mcpServers` merge
 * carries the scope it actually came from. This drives both the approval gate
 * (`'workspace'` is gated) and precedence (`'workspace'`/`'system'` outrank a
 * `.mcp.json` server). User/default scopes are left unstamped (trusted, lower
 * precedence than `.mcp.json`). Returns a shallow copy — never mutates input.
 * See issue #4615.
 */
function tagMcpServerScope(
  settings: Settings,
  scope: McpServerScope,
): Settings {
  const servers = settings.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    return settings;
  }
  const tagged: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    tagged[name] = { ...config, scope };
  }
  return { ...settings, mcpServers: tagged };
}

function mergeSettings(
  system: Settings,
  systemDefaults: Settings,
  user: Settings,
  workspace: Settings,
  isTrusted: boolean,
): Settings {
  const safeWorkspace = isTrusted
    ? tagMcpServerScope(workspace, 'workspace')
    : ({} as Settings);

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
    tagMcpServerScope(system, 'system'),
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
    corruptedPath: string | undefined = undefined,
    wasRecovered: boolean = false,
    workspaceSettingsActive: boolean = true,
  ) {
    this.system = system;
    this.systemDefaults = systemDefaults;
    this.user = user;
    this.workspace = workspace;
    this.isTrusted = isTrusted;
    this.migratedInMemorScopes = migratedInMemorScopes;
    this.migrationWarnings = migrationWarnings;
    this.corruptedPath = corruptedPath;
    this.wasRecovered = wasRecovered;
    this.workspaceSettingsActive = workspaceSettingsActive;
    this._merged = this.computeMergedSettings();
  }

  readonly system: SettingsFile;
  readonly systemDefaults: SettingsFile;
  readonly user: SettingsFile;
  readonly workspace: SettingsFile;
  readonly isTrusted: boolean;
  readonly migratedInMemorScopes: Set<SettingScope>;
  readonly migrationWarnings: string[];
  readonly corruptedPath: string | undefined;
  readonly wasRecovered: boolean;
  readonly workspaceSettingsActive: boolean;
  corruptionDialogDismissed: boolean = false;

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
    // Never persist a runtime snapshot ID to model.name (it re-wraps on restart).
    if (key === 'model.name' && typeof value === 'string') {
      value = stripRuntimeSnapshotPrefix(value);
    }
    const settingsFile = this.forScope(scope);
    setNestedPropertySafe(settingsFile.settings, key, value);
    setNestedPropertySafe(settingsFile.originalSettings, key, value);
    this._merged = this.computeMergedSettings();
    const replacePath = key === 'mcpServers' ? key.split('.') : [];
    saveSettings(settingsFile, createSettingsUpdate(key, value), replacePath);
  }

  recomputeMerged(): void {
    this._merged = this.computeMergedSettings();
  }

  reloadScopeFromDisk(scope: SettingScope): void {
    const file = this.forScope(scope);
    try {
      if (!fs.existsSync(file.path)) {
        file.settings = {};
        file.originalSettings = {};
        file.rawJson = undefined;
        this._merged = this.computeMergedSettings();
        return;
      }

      const content = fs.readFileSync(file.path, 'utf-8');
      const parsed = JSON.parse(stripJsonComments(content));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const resolved = resolveEnvVarsInObject(
          parsed as Settings,
          getHomeEnvFallbackVars(),
        );
        file.settings = resolved;
        file.originalSettings = structuredClone(parsed) as Settings;
        file.rawJson = content;
      }
    } catch (err) {
      debugLogger.warn(
        `reloadScopeFromDisk(${scope}): ${getErrorMessage(err)}`,
      );
    }
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
    undefined,
    false,
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
 * Collects environment variables from user-level `.env` files and returns
 * them as a plain dictionary **without** mutating `process.env`.
 *
 * Candidates are iterated most-specific-first (`~/.qwen/.env` before
 * `~/.env`).  `??=` ensures the first file to define a key wins, matching
 * dotenv's first-occurrence-wins semantics used elsewhere.
 *
 * Note: this dict intentionally does NOT filter PROJECT_ENV_HARDCODED_EXCLUSIONS
 * or advanced.excludedEnvVars — substitution scope is narrower than process.env
 * population handled by preResolveHomeEnvOverrides / readHomeEnvInto.
 */
function getHomeEnvFallbackVars(): Record<string, string> {
  const globalQwenDir = Storage.getGlobalQwenDir();
  const candidates = [path.join(globalQwenDir, '.env')];
  // When QWEN_HOME is set, skip ~/.env to avoid surprise cross-contamination
  // from a shared home .env. getUserLevelEnvPaths() always includes ~/.env
  // because loadEnvironment() populates process.env independently — the two
  // scopes are intentionally different.
  if (!process.env['QWEN_HOME']) {
    candidates.push(path.join(path.dirname(globalQwenDir), '.env'));
  }

  const result: Record<string, string> = {};
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = dotenv.parse(fs.readFileSync(candidate, 'utf-8'));
      for (const key in parsed) {
        if (Object.hasOwn(parsed, key) && !Object.hasOwn(process.env, key)) {
          result[key] ??= parsed[key]!;
        }
      }
    } catch (e) {
      debugLogger.warn(
        `Failed to read home .env candidate ${candidate}: ${getErrorMessage(e)}`,
      );
    }
  }
  return result;
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
            dotEnvSourcedKeys.add(key);
          }
          // Seed snapshot with ALL parsed keys (not just written ones)
          // so child processes can detect deletions on first reload.
          if (!lastReloadSnapshotSeeded) {
            lastReloadSnapshot.set(key, parsedEnv[key]!);
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
        settingsEnvSourcedKeys.add(key);
      }
      if (
        !lastReloadSnapshotSeeded &&
        typeof value === 'string' &&
        !lastReloadSnapshot.has(key)
      ) {
        lastReloadSnapshot.set(key, value);
      }
    }
  }
  lastReloadSnapshotSeeded = true;
}

export interface EnvReloadResult {
  updatedKeys: string[];
  removedKeys: string[];
}

/**
 * Only keys previously set by loadEnvironment() are overwritten;
 * shell-exported variables are never touched.
 * Fully synchronous — no TOCTOU window between delete and re-add.
 */
export function reloadEnvironment(
  settings: Settings,
  workspaceCwd: string,
): EnvReloadResult {
  const userLevelPaths = getUserLevelEnvPaths();
  const envFilePath = findEnvFile(settings, workspaceCwd, userLevelPaths);

  if (process.env['CLOUD_SHELL'] === 'true') {
    setUpCloudShellEnvironment(envFilePath);
  }

  // Build the set of new keys from .env (higher priority) + settings.env
  let dotEnvReadFailed = false;
  const newDotEnvKeys = new Map<string, string>();
  const newSettingsEnvKeys = new Map<string, string>();

  if (envFilePath) {
    try {
      const envFileContent = fs.readFileSync(envFilePath, 'utf-8');
      const parsedEnv = dotenv.parse(envFileContent);
      const excludedVars =
        settings?.advanced?.excludedEnvVars || DEFAULT_EXCLUDED_ENV_VARS;
      const normalizedEnvFilePath = path.normalize(envFilePath);
      const isHomeScopedEnvFile = userLevelPaths.has(normalizedEnvFilePath);
      const isQwenScopedEnvFile =
        isHomeScopedEnvFile ||
        path.basename(path.dirname(normalizedEnvFilePath)) === QWEN_DIR;

      for (const key in parsedEnv) {
        if (!Object.hasOwn(parsedEnv, key)) continue;
        if (RELOAD_EXCLUDED_KEYS.has(key)) continue;
        if (
          !isHomeScopedEnvFile &&
          PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)
        ) {
          continue;
        }
        if (!isQwenScopedEnvFile && excludedVars.includes(key)) continue;
        newDotEnvKeys.set(key, parsedEnv[key]!);
      }
    } catch {
      dotEnvReadFailed = true;
    }
  }

  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (RELOAD_EXCLUDED_KEYS.has(key)) continue;
      if (PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)) continue;
      if (typeof value !== 'string') continue;
      if (newDotEnvKeys.has(key)) continue;
      // When .env read failed, use the snapshot as the shadow set so
      // settings.env keys that were previously shadowed by .env don't
      // accidentally overwrite the still-live .env values in process.env.
      if (dotEnvReadFailed && lastReloadSnapshot.has(key)) continue;
      newSettingsEnvKeys.set(key, value);
    }
  }

  // Union of all new keys
  const allNewKeys = new Set([
    ...newDotEnvKeys.keys(),
    ...newSettingsEnvKeys.keys(),
  ]);

  const updatedKeys: string[] = [];
  const removedKeys: string[] = [];

  // Delete keys previously known (from tracking Sets OR the boot snapshot)
  // that are no longer in any source file. The snapshot covers keys that
  // ACP children inherited from the daemon without tracking.
  // Skip deletion entirely if the .env file became unreadable — treat as
  // transient I/O failure rather than intentional key removal.
  if (!dotEnvReadFailed) {
    const previouslyKnown = new Set([
      ...lastReloadSnapshot.keys(),
      ...dotEnvSourcedKeys,
      ...settingsEnvSourcedKeys,
    ]);
    for (const key of previouslyKnown) {
      if (!allNewKeys.has(key) && !RELOAD_EXCLUDED_KEYS.has(key)) {
        delete process.env[key];
        removedKeys.push(key);
      }
    }
  }

  // Force-write all source keys. RELOAD_EXCLUDED_KEYS are already filtered
  // at parse time so dangerous keys (PATH, HOME, etc.) never reach here.
  // This unconditional write is necessary because ACP children inherit
  // daemon env without tracking, so the tracking-based guard would miss them.
  for (const [key, value] of newDotEnvKeys) {
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

  // Update tracking sets and snapshot only when the .env file was readable.
  // A transient read failure must not wipe provenance — the stale tracking
  // state is needed so the next successful reload can still detect deletions.
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
  // settings.env is always readable (from settings.json, not a file),
  // so its tracking set is always updated.
  settingsEnvSourcedKeys.clear();
  for (const key of newSettingsEnvKeys.keys()) {
    settingsEnvSourcedKeys.add(key);
  }

  return { updatedKeys, removedKeys };
}

export const CORRUPTED_SUFFIX = '.corrupted';

/**
 * Load and merge settings from all scopes:
 * System Defaults → User (~/.qwen/settings.json) → Workspace → System.
 */
export interface LoadSettingsOptions {
  consumeCorruptionEnvVars?: boolean;
  skipLoadEnvironment?: boolean;
}

export function loadSettings(
  workspaceDir: string = process.cwd(),
  consumeCorruptionEnvVars: boolean | LoadSettingsOptions = true,
): LoadedSettings {
  const opts: LoadSettingsOptions =
    typeof consumeCorruptionEnvVars === 'object'
      ? consumeCorruptionEnvVars
      : { consumeCorruptionEnvVars };
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
  ): {
    settings: Settings;
    rawJson?: string;
    migrationWarnings?: string[];
    corruptedPath?: string;
    wasRecovered?: boolean;
  } => {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        let rawSettings: unknown;
        // Carry corruption state through to the final return so it
        // can be attached after the migration pipeline runs.
        const corruptedPath = `${filePath}${CORRUPTED_SUFFIX}`;
        let corruptedSaved = false;
        let recoveredFromEnvVar: boolean | null = null;

        try {
          rawSettings = JSON.parse(stripJsonComments(content));
        } catch (parseError: unknown) {
          // ===== JSON parse failed — enter corruption recovery =====
          // Strategy: save corrupted file as .corrupted → reset to empty →
          // show dialog in UI. Never crash due to a corrupted settings file.
          //
          // Note: there is no on-disk `.orig` backup to recover from. Writes go
          // through `writeWithBackupSync`, which uses `.orig` only as an
          // in-flight safety net and removes it on success — so it never
          // lingers in the user's directory (see writeWithBackup.ts).

          // Step 1: copy corrupted file to .corrupted for reference
          // MUST guarantee .corrupted exists so onExit can restore it.
          // Use copy (not rename) — the file must stay on disk so that
          // child processes spawned by relaunchAppInChildProcess() can
          // enter the existsSync block where env-var propagation is checked.
          debugLogger.warn(
            `Settings file ${filePath} has invalid JSON (${getErrorMessage(parseError)}). Resetting to empty settings.`,
          );

          try {
            fs.copyFileSync(filePath, corruptedPath);
            corruptedSaved = true;
          } catch (copyError) {
            debugLogger.warn(
              `Failed to copy corrupted file: ${getErrorMessage(copyError)}`,
            );
          }

          // Step 2: no recoverable content — start with empty settings
          if (!rawSettings) {
            const warningMsg = `Settings file ${filePath} has invalid JSON. Your settings have been reset.`;
            debugLogger.warn(warningMsg);
            if (corruptedSaved) {
              // Clear the original file so the settings UI shows empty settings
              // instead of the corrupted content.
              try {
                fs.writeFileSync(filePath, '{}', 'utf-8');
              } catch {
                /* ignore — settings are already empty in memory */
              }
            }
            return {
              settings: {},
              migrationWarnings: [],
              corruptedPath: corruptedSaved ? corruptedPath : undefined,
              wasRecovered: false,
            };
          }
        }

        // Propagate corruption state from parent process via env vars.
        // relaunchAppInChildProcess() spawns a child that re-reads
        // settings.json (already valid after parent recovered it). The
        // env vars preserve the corruption marker across the boundary.
        // Only apply to user scope since that's where corruption is detected.
        // Clear env vars after reading so subsequent loadSettings calls
        // don't re-trigger this path.
        const envCorruptedPath = process.env[ENV_CORRUPTED_PATH];
        if (
          (opts.consumeCorruptionEnvVars ?? true) &&
          envCorruptedPath &&
          envCorruptedPath === corruptedPath &&
          scope === SettingScope.User
        ) {
          corruptedSaved = true;
          recoveredFromEnvVar = process.env[ENV_WAS_RECOVERED] === '1';
          delete process.env[ENV_CORRUPTED_PATH];
          delete process.env[ENV_WAS_RECOVERED];
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

        // Execute migrations even on recovered settings — the migrated data
        // must persist. The disk-write branches below (version normalization)
        // are guarded by !corruptedSaved to avoid creating .orig backups
        // of freshly-reset settings.
        if (needsMigration(settingsObject)) {
          const migrationResult = runMigrations(settingsObject, scope);
          if (migrationResult.executedMigrations.length > 0) {
            settingsObject = migrationResult.settings as Record<
              string,
              unknown
            >;
            migrationWarnings = migrationResult.warnings;
            persistSettingsObject('Error migrating settings file on disk');
          } else if (
            (hasLegacyNumericVersion || hasInvalidVersion) &&
            !corruptedSaved
          ) {
            // Migration was deemed needed but nothing executed. Normalize version metadata
            // to avoid repeated no-op checks on startup.
            settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
            debugLogger.warn(
              `Settings version metadata in ${filePath} could not be migrated by any registered migration. Normalizing ${SETTINGS_VERSION_KEY} to ${SETTINGS_VERSION}.`,
            );
            persistSettingsObject('Error normalizing settings version on disk');
          }
        } else if (
          (!hasVersionKey || hasInvalidVersion || hasLegacyNumericVersion) &&
          !corruptedSaved
        ) {
          // No migration needed/executable, but version metadata is missing or invalid.
          // Normalize it to current version to avoid repeated startup work.
          // Skip if we just recovered from corruption — the next startup will
          // handle normalization, avoiding an unnecessary writeWithBackupSync
          // that would create a .orig file from the freshly reset settings.
          settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
          persistSettingsObject('Error normalizing settings version on disk');
        }

        // Attach corruption state propagated from the parent via env vars.
        const result: ReturnType<typeof loadAndMigrate> = {
          settings: settingsObject as Settings,
          rawJson: content,
          migrationWarnings: migrationWarnings ?? [],
        };
        if (corruptedSaved) {
          result.corruptedPath = corruptedPath;
          result.wasRecovered = recoveredFromEnvVar ?? false;
        }
        return result;
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
  const workspaceSettingsActive = realWorkspaceDir !== realHomeDir;
  if (workspaceSettingsActive) {
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

  // Resolve ${VAR} placeholders in settings using home .env as fallback.
  // getHomeEnvFallbackVars() excludes keys already in process.env, so
  // effective precedence is: process.env > home .env > unresolved placeholder.
  // The resolver checks customEnv before process.env, but since customEnv
  // never contains a process.env key, process.env always wins.
  const homeEnvFallback = getHomeEnvFallbackVars();
  systemSettings = resolveEnvVarsInObject(
    systemResult.settings,
    homeEnvFallback,
  );
  systemDefaultSettings = resolveEnvVarsInObject(
    systemDefaultsResult.settings,
    homeEnvFallback,
  );
  userSettings = resolveEnvVarsInObject(userResult.settings, homeEnvFallback);
  workspaceSettings = resolveEnvVarsInObject(
    workspaceResult.settings,
    homeEnvFallback,
  );

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
  if (!opts.skipLoadEnvironment) {
    loadEnvironment(tempMergedSettings);
  }

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
    userResult.corruptedPath,
    userResult.wasRecovered ?? false,
    workspaceSettingsActive,
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
  replacePath: readonly string[] = [],
): void {
  try {
    // Ensure the directory exists
    const dirPath = path.dirname(settingsFile.path);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Use the format-preserving update function
    const written = updateSettingsFilePreservingFormat(
      settingsFile.path,
      updates,
      false,
      replacePath,
    );
    if (!written) {
      debugLogger.error(
        `saveSettings: updateSettingsFilePreservingFormat returned false for ${settingsFile.path}`,
      );
    }
  } catch (error) {
    debugLogger.error('Error saving user settings file.');
    debugLogger.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
