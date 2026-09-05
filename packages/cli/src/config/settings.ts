/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import {
  FatalConfigError,
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
import { isWorkspaceTrusted } from './trustedFolders.js';
import { hasOwnModelProviders } from './modelProvidersScope.js';
import {
  type Settings,
  type MemoryImportFormat,
  type SettingsSchema,
  type SettingDefinition,
  getSettingsSchema,
} from './settingsSchema.js';
import { resolveEnvVarsInObject } from '@qwen-code/qwen-code-core/envVarResolver';
import {
  setNestedPropertySafe,
  WORKSPACE_NON_OVERRIDING_SETTINGS,
  WORKSPACE_RESTRICTED_SETTINGS,
  WORKSPACE_TIGHTEN_ONLY_SETTINGS,
} from './settingsUtils.js';
import { customDeepMerge, type MergeStrategy } from '../utils/deepMerge.js';
import { updateSettingsFilePreservingFormat } from '../utils/jsonc-editor.js';
import { runMigrations, needsMigration } from './migration/index.js';
import {
  V1_TO_V2_MIGRATION_MAP,
  V2_CONTAINER_KEYS,
} from './migration/versions/v1-to-v2-shared.js';
import {
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  getHomeEnvFallbackVars,
  loadEnvironment,
  preResolveHomeEnvOverrides,
} from './environment.js';
import {
  DEFAULT_DARK_THEME_NAME,
  DEFAULT_LIGHT_THEME_NAME,
} from './default-theme-names.js';
import {
  getSystemDefaultsPath,
  getSystemSettingsPath,
} from './storage-paths-lite.js';

export {
  DEFAULT_EXCLUDED_ENV_VARS,
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  getHomeEnvFallbackVars,
  loadEnvironment,
  preResolveHomeEnvOverrides,
  reloadEnvironment,
  resetEnvironmentTrackingForTesting,
  resetHomeEnvBootstrapForTesting,
  setUpCloudShellEnvironment,
  SETTINGS_DIRECTORY_NAME,
} from './environment.js';
export { getSystemDefaultsPath, getSystemSettingsPath };
export type { EnvReloadResult } from './environment.js';

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
 * DELIBERATELY UNWIRED — nothing calls this, and settings.md documents the
 * legacy keys as "not automatically migrated; still honoured at startup".
 * Do not wire it up as written: the `tools.core` → `permissions.allow` arm
 * below encodes exactly the conflation #10075 was reported for and #10098
 * removed. `permissions.allow` is pure auto-approval and cannot restrict
 * registration, so that arm would delete a user's `tools.core` allowlist
 * and silently replace it with a no-op. A real migration maps `tools.core`
 * to `tools.eager` (defer unlisted tools) or `permissions.deny` (remove
 * them) — see the migration table in
 * docs/users/configuration/settings.md.
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

  // Settings restricted to trusted scopes are stripped from Workspace during
  // the merge; warn so the user knows their workspace setting has no effect.
  // Driven by WORKSPACE_RESTRICTED_SETTINGS so the warning cannot drift from
  // the strip that produces it.
  const workspaceFile = loadedSettings.forScope(SettingScope.Workspace);
  if (workspaceFile.rawJson !== undefined) {
    for (const { section, key } of WORKSPACE_RESTRICTED_SETTINGS) {
      const sectionValue = workspaceFile.originalSettings[section] as
        | Record<string, unknown>
        | undefined;
      if (sectionValue?.[key] === undefined) continue;
      warningSet.add(
        `Warning: ${section}.${key} in workspace settings (${workspaceFile.path}) is ignored. This setting is only honored from User, System, or SystemDefaults scope settings.`,
      );
    }
    for (const ref of WORKSPACE_NON_OVERRIDING_SETTINGS) {
      if (!isSettingDefined(workspaceFile.originalSettings, ref)) continue;
      const definingScope = [
        SettingScope.System,
        SettingScope.User,
        SettingScope.SystemDefaults,
      ].find((scope) =>
        isSettingDefined(loadedSettings.forScope(scope).originalSettings, ref),
      );
      if (definingScope === undefined) continue;
      warningSet.add(
        `Warning: ${ref.section}.${ref.key} in workspace settings (${workspaceFile.path}) is ignored because ${definingScope} scope settings also set it. A workspace value is honored only when no User, System, or SystemDefaults scope sets this setting.`,
      );
    }
    // Tighten-only keys: the same verdict the merge applied, so the
    // warning and the strip cannot disagree about a value. A value that
    // merely repeats what is already in force is dropped without a
    // warning — it lost nothing.
    for (const entry of WORKSPACE_TIGHTEN_ONLY_SETTINGS) {
      const verdict = tightenOnlyVerdict(entry, workspaceFile.settings, {
        system: loadedSettings.system.settings,
        systemDefaults: loadedSettings.systemDefaults.settings,
        user: loadedSettings.user.settings,
      });
      if (verdict === undefined || verdict.kept) continue;
      const key = `${entry.section}.${entry.key}`;
      if (verdict.reason === 'system-sets') {
        warningSet.add(
          `Warning: ${key} in workspace settings (${workspaceFile.path}) is ignored because System scope settings also set it.`,
        );
      } else if (verdict.reason === 'looser') {
        warningSet.add(
          `Warning: ${key} in workspace settings (${workspaceFile.path}) is ignored because it would loosen the ${verdict.against} value. A workspace may only make this setting stricter.`,
        );
      }
    }
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

type SettingKeyRef = {
  readonly section: keyof Settings;
  readonly key: string;
};

function isSettingDefined(
  settings: Settings,
  { section, key }: SettingKeyRef,
): boolean {
  const sectionValue = settings[section] as Record<string, unknown> | undefined;
  return sectionValue?.[key] !== undefined;
}

/**
 * Return `settings` without the given keys. Returns a shallow copy, and the
 * input unchanged when it carries none of them.
 */
function stripSettingKeys(
  settings: Settings,
  keys: Iterable<SettingKeyRef>,
): Settings {
  let stripped: Settings | undefined;
  for (const { section, key } of keys) {
    const source = (stripped ?? settings)[section] as
      | Record<string, unknown>
      | undefined;
    if (source?.[key] === undefined) continue;
    const { [key]: _removed, ...rest } = source;
    stripped = { ...(stripped ?? settings), [section]: rest } as Settings;
  }
  return stripped ?? settings;
}

/**
 * Strip the workspace-restricted settings before merging so a repository
 * cannot opt the user into those capabilities.
 */
function stripWorkspaceRestrictedSettings(settings: Settings): Settings {
  return stripSettingKeys(settings, WORKSPACE_RESTRICTED_SETTINGS);
}

/**
 * Drop the workspace's WORKSPACE_NON_OVERRIDING_SETTINGS values that a
 * higher scope also defines. A repository may narrow where its own HTTP
 * hooks send data, but it must never replace a whitelist the user or
 * platform configured: an empty whitelist means "allow all", so a replaced
 * list is a widened one.
 */
function stripWorkspaceOverrides(
  workspace: Settings,
  higherScopes: readonly Settings[],
): Settings {
  return stripSettingKeys(
    workspace,
    WORKSPACE_NON_OVERRIDING_SETTINGS.filter((ref) =>
      higherScopes.some((scope) => isSettingDefined(scope, ref)),
    ),
  );
}

type TightenOnlyEntry = (typeof WORKSPACE_TIGHTEN_ONLY_SETTINGS)[number];

type TightenOnlyVerdict =
  | { kept: true }
  | { kept: false; reason: 'system-sets' }
  | {
      kept: false;
      reason: 'looser';
      against: 'User' | 'SystemDefaults' | 'default';
    }
  | { kept: false; reason: 'same' };

/**
 * Decide one tighten-only key for a workspace, or `undefined` when the
 * workspace does not set it.
 *
 * System wins outright, as it does for every setting. Otherwise the
 * workspace value is compared against whichever of User and SystemDefaults
 * sets the key — the stricter of the two if both do — and against the
 * feature's default when neither does. Strictly stricter is kept; equal
 * is dropped silently; looser is dropped with a warning.
 */
function tightenOnlyVerdict(
  entry: TightenOnlyEntry,
  workspace: Settings,
  scopes: { system: Settings; systemDefaults: Settings; user: Settings },
): TightenOnlyVerdict | undefined {
  const read = (settings: Settings): unknown =>
    (settings[entry.section] as Record<string, unknown> | undefined)?.[
      entry.key
    ];
  const candidate = read(workspace);
  if (candidate === undefined) return undefined;
  if (read(scopes.system) !== undefined) {
    return { kept: false, reason: 'system-sets' };
  }
  let against: 'User' | 'SystemDefaults' | 'default' = 'default';
  let baseline = entry.strictness(undefined);
  for (const [name, settings] of [
    ['SystemDefaults', scopes.systemDefaults],
    ['User', scopes.user],
  ] as const) {
    const value = read(settings);
    if (value === undefined) continue;
    const rank = entry.strictness(value);
    if (against === 'default' || rank > baseline) {
      against = name;
      baseline = rank;
    }
  }
  const rank = entry.strictness(candidate);
  if (rank > baseline) return { kept: true };
  if (rank === baseline) return { kept: false, reason: 'same' };
  return { kept: false, reason: 'looser', against };
}

/**
 * Drop the workspace's tighten-only values that would not make the
 * setting stricter than the operator scopes already have it.
 */
function stripWorkspaceLoosenings(
  workspace: Settings,
  scopes: { system: Settings; systemDefaults: Settings; user: Settings },
): Settings {
  return stripSettingKeys(
    workspace,
    WORKSPACE_TIGHTEN_ONLY_SETTINGS.filter((entry) => {
      const verdict = tightenOnlyVerdict(entry, workspace, scopes);
      return verdict !== undefined && !verdict.kept;
    }),
  );
}

function mergeSettings(
  system: Settings,
  systemDefaults: Settings,
  user: Settings,
  workspace: Settings,
  isTrusted: boolean,
): Settings {
  const safeWorkspace = isTrusted
    ? tagMcpServerScope(
        stripWorkspaceLoosenings(
          stripWorkspaceOverrides(stripWorkspaceRestrictedSettings(workspace), [
            systemDefaults,
            user,
            system,
          ]),
          { system, systemDefaults, user },
        ),
        'workspace',
      )
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
    migratedInMemoryScopes: Set<SettingScope>,
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
    this.migratedInMemoryScopes = migratedInMemoryScopes;
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
  readonly migratedInMemoryScopes: Set<SettingScope>;
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

  setValue(
    scope: SettingScope,
    key: string,
    value: unknown,
    assertCanCommit?: () => void,
    opts: { throwOnWriteFailure?: boolean } = {},
  ): void {
    // Never persist a runtime snapshot ID to model.name (it re-wraps on restart).
    if (key === 'model.name' && typeof value === 'string') {
      value = stripRuntimeSnapshotPrefix(value);
    }
    assertCanCommit?.();
    const settingsFile = this.forScope(scope);
    const replacePath = key === 'mcpServers' ? key.split('.') : [];
    if (opts.throwOnWriteFailure) {
      saveSettings(
        settingsFile,
        createSettingsUpdate(key, value),
        replacePath,
        {
          throwOnWriteFailure: true,
        },
      );
    }
    setNestedPropertySafe(settingsFile.settings, key, value);
    setNestedPropertySafe(settingsFile.originalSettings, key, value);
    this._merged = this.computeMergedSettings();
    if (!opts.throwOnWriteFailure) {
      saveSettings(settingsFile, createSettingsUpdate(key, value), replacePath);
    }
  }

  setValues(
    writes: ReadonlyArray<{
      scope: SettingScope;
      key: string;
      value: unknown;
    }>,
    onScopeCommitted?: (scope: SettingScope) => void,
    assertCanCommit?: () => void,
  ): void {
    const scopes = new Set<SettingScope>();
    for (const write of writes) {
      const value =
        write.key === 'model.name' && typeof write.value === 'string'
          ? stripRuntimeSnapshotPrefix(write.value)
          : write.value;
      const settingsFile = this.forScope(write.scope);
      setNestedPropertySafe(settingsFile.settings, write.key, value);
      setNestedPropertySafe(settingsFile.originalSettings, write.key, value);
      scopes.add(write.scope);
    }
    this._merged = this.computeMergedSettings();
    const scopeList = Array.from(scopes);
    for (let i = 0; i < scopeList.length; i++) {
      const scope = scopeList[i]!;
      try {
        assertCanCommit?.();
        saveSettings(this.forScope(scope), undefined, undefined, {
          throwOnWriteFailure: true,
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

  recomputeMerged(): void {
    this._merged = this.computeMergedSettings();
  }

  reloadScopeFromDisk(scope: SettingScope): boolean {
    const file = this.forScope(scope);
    if (scope === SettingScope.Workspace && !this.workspaceSettingsActive) {
      file.settings = {};
      file.originalSettings = {};
      file.rawJson = undefined;
      this._merged = this.computeMergedSettings();
      return true;
    }
    let reloaded = false;
    try {
      if (!fs.existsSync(file.path)) {
        file.settings = {};
        file.originalSettings = {};
        file.rawJson = undefined;
        this._merged = this.computeMergedSettings();
        return true;
      }

      const content = fs.readFileSync(file.path, 'utf-8');
      const parsed = JSON.parse(stripJsonComments(content));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const resolved = resolveEnvVarsInObject(
          parsed as Settings,
          getHomeEnvFallbackVars((message) => debugLogger.warn(message)),
        );
        file.settings = resolved;
        file.originalSettings = structuredClone(parsed) as Settings;
        file.rawJson = content;
        reloaded = true;
      } else {
        debugLogger.warn(
          `reloadScopeFromDisk(${scope}): settings file is not a JSON object, keeping previous settings`,
        );
      }
    } catch (err) {
      debugLogger.warn(
        `reloadScopeFromDisk(${scope}): ${getErrorMessage(err)}`,
      );
    }
    this._merged = this.computeMergedSettings();
    return reloaded;
  }

  reloadScopesFromDiskAtomically(scopes: readonly SettingScope[]): boolean {
    const snapshots = scopes.map((scope) => {
      const file = this.forScope(scope);
      return {
        file,
        settings: structuredClone(file.settings),
        originalSettings: structuredClone(file.originalSettings),
        rawJson: file.rawJson,
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

export const CORRUPTED_SUFFIX = '.corrupted';

/**
 * Load and merge settings from all scopes:
 * System Defaults → User (~/.qwen/settings.json) → Workspace → System.
 */
export interface LoadSettingsOptions {
  consumeCorruptionEnvVars?: boolean;
  skipLoadEnvironment?: boolean;
  skipWorkspaceSettings?: boolean;
  workspaceTrusted?: boolean;
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
  const migratedInMemoryScopes = new Set<SettingScope>();

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
  const workspaceSettingsActive =
    !opts.skipWorkspaceSettings && realWorkspaceDir !== realHomeDir;
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
  const homeEnvFallback = getHomeEnvFallbackVars((message) =>
    debugLogger.warn(message),
  );
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
    userSettings.ui.theme = DEFAULT_LIGHT_THEME_NAME;
  } else if (userSettings.ui?.theme === 'VS2015') {
    userSettings.ui.theme = DEFAULT_DARK_THEME_NAME;
  }
  if (workspaceSettings.ui?.theme === 'VS') {
    workspaceSettings.ui.theme = DEFAULT_LIGHT_THEME_NAME;
  } else if (workspaceSettings.ui?.theme === 'VS2015') {
    workspaceSettings.ui.theme = DEFAULT_DARK_THEME_NAME;
  }

  // For the initial trust check, we can only use user and system settings.
  const initialTrustCheckSettings = customDeepMerge(
    getMergeStrategyForPath,
    {},
    systemSettings,
    userSettings,
  );
  const isTrusted =
    opts.workspaceTrusted ??
    isWorkspaceTrusted(
      initialTrustCheckSettings as Settings,
      undefined,
      realWorkspaceDir,
    ).isTrusted ??
    true;

  // Create a temporary merged settings object to pass to loadEnvironment.
  const tempMergedSettings = mergeSettings(
    systemSettings,
    systemDefaultSettings,
    userSettings,
    workspaceSettings,
    isTrusted,
  );

  // loadEnvironment depends on settings so we have to create a temp version of
  // the settings to avoid a cycle
  if (!opts.skipLoadEnvironment) {
    loadEnvironment(tempMergedSettings, workspaceDir);
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
    migratedInMemoryScopes,
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
  opts: { throwOnWriteFailure?: boolean } = {},
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
      const message = `saveSettings: updateSettingsFilePreservingFormat returned false for ${settingsFile.path}`;
      if (opts.throwOnWriteFailure) {
        throw new Error(message);
      }
      debugLogger.error(message);
    }
  } catch (error) {
    debugLogger.error('Error saving user settings file.');
    debugLogger.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
