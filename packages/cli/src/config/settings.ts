/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Settings,
  type MergedSettings,
  LoadedSettings,
  invalidateSettingsFileSources,
  type SettingsService,
  type UserSettingsSource,
  SettingScope,
  type LoadableSettingScope,
  type LoadedSettingsError,
  type LoadedSettingsFile,
  type SettingsFileSources,
  type SettingsDefinition,
  type SettingsFieldDefinition,
  type ResolveSettingsOptions,
} from '@qwen-code/resource';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import {
  FatalConfigError,
  CONFIG_DIR,
  getErrorMessage,
  getFsErrorMessage,
  Storage,
  coreEvents,
  stripBOM,
  ENV_SHELL_PREFIX,
  ENV_SHELL_PREFIX_COMPAT,
  ENV_GIT_BASH_PATH,
  ENV_BASH_PATH,
  ENV_AGENT_SDK_ENTRYPOINT,
  normalizePath,
  type ModelPreferenceEntry,
  generationConfigFromLegacyFields,
  generationConfigFromModelPreference,
  modelPreferenceWithGeneration,
  runLogger,
} from '@qwen-code/core';

import stripJsonComments from 'strip-json-comments';
import { DefaultLight } from '../ui/themes/builtin/light/default-light.js';
import { DefaultDark } from '../ui/themes/builtin/dark/default-dark.js';
import { isWorkspaceTrusted } from './trustedFolders.js';
import {
  type MemoryImportFormat,
  type MergeStrategy,
  type SettingsSchema,
  type SettingDefinition,
  getSettingsSchema,
} from './settingsSchema.js';

export { LoadedSettings };
export type {
  Settings,
  MergedSettings,
  LoadedSettingsSnapshot,
} from '@qwen-code/resource';

export {
  type MemoryImportFormat,
  type MergeStrategy,
  type SettingsSchema,
  type SettingDefinition,
  getSettingsSchema,
};

import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';
import { customDeepMerge } from '../utils/deepMerge.js';
import type { CommentJsonPath } from '../utils/commentJson.js';
import { logInfrastructureFailure } from './settingsPersistence.js';
import {
  getSettingsZodSchema,
  formatValidationError,
  requireSettingsDefinition,
} from './settings-validation.js';
import {
  normalizeLegacySettingsShape,
  sanitizeRecoverableSettingsValidationIssues,
  skipInvalidMcpServerConfigs,
} from './settingsCompatibility.js';

export function getMergeStrategyForPath(
  path: string[],
  schema: SettingsDefinition['schema'] = getSettingsSchema(),
): SettingsFieldDefinition['mergeStrategy'] {
  let current: SettingsFieldDefinition | undefined = undefined;
  let currentSchema: SettingsDefinition['schema'] | undefined = schema;
  let parent: SettingsFieldDefinition | undefined = undefined;

  for (const key of path) {
    if (!currentSchema || !currentSchema[key]) {
      // Key not found in schema - check if parent has additionalProperties
      if (parent?.additionalProperties?.mergeStrategy) {
        return parent.additionalProperties.mergeStrategy;
      }
      return undefined;
    }
    parent = current;
    current = currentSchema[key];
    currentSchema = current.properties;
  }

  return current?.mergeStrategy;
}

export const USER_SETTINGS_PATH = Storage.getGlobalSettingsPath();
export const USER_SETTINGS_DIR = path.dirname(USER_SETTINGS_PATH);
// Capture the user-controlled root before the first project .env is loaded.
// Environment loading can run more than once during startup, and a project
// file may itself set the CLI home or config directory override. Re-reading
// those overrides here would let the same project file masquerade as a
// user-global source on a later pass.
const USER_CONFIG_ENV_PATH = path.resolve(USER_SETTINGS_DIR, '.env');
const NORMALIZED_USER_CONFIG_ENV_PATH = normalizePath(USER_CONFIG_ENV_PATH);

const USER_GLOBAL_EXECUTION_OVERRIDE_ENV_VARS = new Set([
  ENV_SHELL_PREFIX,
  ENV_SHELL_PREFIX_COMPAT,
  ENV_GIT_BASH_PATH,
]);

const WINDOWS_UNTRUSTED_PROJECT_DISCOVERY_ENV_VARS = new Set([
  ENV_BASH_PATH,
  'BASH_PATH',
  'GIT_BASH',
  'GIT_HOME',
  'PATH',
  'SYSTEMROOT',
]);

function matchesExecutionEnvVar(
  variables: ReadonlySet<string>,
  key: string,
): boolean {
  // Windows environment keys are case-insensitive. POSIX keys are not, so a
  // differently-cased name there must retain the existing dotenv semantics.
  return variables.has(process.platform === 'win32' ? key.toUpperCase() : key);
}

/**
 * Sanitizes an environment variable value to prevent shell injection.
 * Restricts values to a safe character set: alphanumeric, -, _, ., /
 */
export function sanitizeEnvVar(value: string): string {
  return value.replace(/[^a-zA-Z0-9\-_./]/g, '');
}

export type { DnsResolutionOrder } from './settingsSchema.js';

export { SettingScope, type LoadableSettingScope };

/**
 * The actual values of the loadable settings scopes.
 */
const _loadableSettingScopes: LoadableSettingScope[] = [
  SettingScope.User,
  SettingScope.Project,
  SettingScope.Local,
];

/** Enumerate the persistable settings scopes. */
export function getLoadableSettingScopes(): readonly LoadableSettingScope[] {
  return [..._loadableSettingScopes];
}

/**
 * A type guard function that checks if `scope` is a loadable settings scope,
 * and allows promotion to the `LoadableSettingsScope` type based on the result.
 */
export function isLoadableSettingScope(
  scope: SettingScope,
): scope is LoadableSettingScope {
  return _loadableSettingScopes.some((candidate) => candidate === scope);
}

export interface SummarizeToolOutputSettings {
  tokenBudget?: number;
}

export type LoadingPhrasesMode = 'tips' | 'witty' | 'all' | 'off';

export interface AccessibilitySettings {
  /** @deprecated Use ui.loadingPhrases instead. */
  enableLoadingPhrases?: boolean;
  screenReader?: boolean;
}

export type { SessionRetentionSettings } from '@qwen-code/resource';

export type SettingsError = LoadedSettingsError;
export type SettingsFile = LoadedSettingsFile;

export type SettingsPath = CommentJsonPath;

export type SettingsMutationEditor =
  import('@qwen-code/resource').SettingsMutationEditor;

export function getDefaultsFromSchema(
  schema: SettingsDefinition['schema'] = getSettingsSchema(),
): Settings {
  const defaults: Record<string, unknown> = {};
  for (const key in schema) {
    const definition = schema[key];
    if (definition.properties) {
      defaults[key] = getDefaultsFromSchema(definition.properties);
    } else if (definition.default !== undefined) {
      defaults[key] = definition.default;
    }
  }
  return defaults as Settings;
}

export function mergeSettings(
  user: Settings,
  project: Settings,
  isTrusted: boolean,
  local?: Settings,
  flag?: Settings,
  schema: SettingsDefinition['schema'] = getSettingsSchema(),
): MergedSettings {
  const safeProject = isTrusted ? project : ({} as Settings);
  const safeLocal = isTrusted ? (local ?? ({} as Settings)) : ({} as Settings);
  // Flag-provided settings are always applied regardless of trust — the user
  // explicitly opted in by passing --settings on the command line.
  const safeFlag = flag ?? ({} as Settings);
  const schemaDefaults = getDefaultsFromSchema(schema);

  // Settings are merged with the following precedence (last one wins for
  // single values):
  // 1. Schema Defaults (Built-in)
  // 2. User Settings
  // 3. Project Settings
  // 4. Local Settings (personal project overrides, not checked in)
  // 5. Flag Settings (--settings CLI flag — highest precedence)

  return customDeepMerge(
    (path) => getMergeStrategyForPath(path, schema),
    schemaDefaults,
    user,
    safeProject,
    safeLocal,
    safeFlag,
  ) as MergedSettings;
}

/**
 * Creates a fully populated MergedSettings object for testing purposes.
 * It merges the provided overrides with the default settings from the schema.
 *
 * @param overrides Partial settings to override the defaults.
 * @returns A complete MergedSettings object.
 */
export function createTestMergedSettings(
  overrides: Partial<Settings> = {},
): MergedSettings {
  return customDeepMerge(
    getMergeStrategyForPath,
    getDefaultsFromSchema(),
    overrides,
  ) as MergedSettings;
}

/** Assemble product rules around the Resource-owned settings instance. */
export function createLoadedSettings(
  user: SettingsFile,
  project: SettingsFile,
  local: SettingsFile,
  isTrusted: boolean,
  errors: SettingsError[] = [],
  flag?: SettingsFile,
  userSettingsLoadRejected = false,
  fileSources?: SettingsFileSources,
  settingsService?: SettingsService,
  initialMerged?: MergedSettings,
): LoadedSettings {
  let boundService = settingsService;
  const getDefinition = () =>
    boundService ? requireSettingsDefinition(boundService) : undefined;
  const getValidation = () =>
    getDefinition()?.validation ?? getSettingsZodSchema();
  const validate = (data: unknown) => getValidation().safeParse(data);
  return new LoadedSettings(
    {
      merge: (userValues, projectValues, trusted, localValues, flagValues) =>
        mergeSettings(
          userValues,
          projectValues,
          trusted,
          localValues,
          flagValues,
          getDefinition()?.schema,
        ),
      onServiceAttached: (service) => {
        const { schema } = requireSettingsDefinition(service);
        boundService = service;
        return schema !== getSettingsSchema();
      },
      runtimeValues: (original) => {
        const runtime = structuredClone(original) as Record<string, unknown>;
        normalizeLegacySettingsShape(runtime);
        skipInvalidMcpServerConfigs(runtime, validate);
        sanitizeRecoverableSettingsValidationIssues(runtime, validate);
        return resolveSettingsEnv(runtime as Settings);
      },
      normalizeOriginal: normalizeLegacySettingsShape,
      resolveEnvironment: resolveSettingsEnv,
      normalizeDisplaySettings: normalizeLegacyThemeNames,
      readFile: (filePath, errors, source) => {
        const result = loadSettingsFile(
          filePath,
          errors,
          { ...PERSISTABLE_DISK_LOAD_OPTIONS, validation: getValidation() },
          source,
        );
        return { ...result, loadRejected: result.rejected };
      },
      onChanged: () => coreEvents.emitSettingsChanged(),
      onPersisted: clearSettingsCache,
      onReload: clearSettingsCache,
      onWriteError: (operation, error) =>
        coreEvents.emitFeedback(
          'error',
          `Failed to ${operation} settings: ${getFsErrorMessage(error)}`,
          error,
        ),
      onWarning: (message) => runLogger.warn(message),
      onError: (message) => runLogger.error(message),
      onInfrastructureError: logInfrastructureFailure,
    },
    user,
    project,
    local,
    isTrusted,
    errors,
    flag,
    userSettingsLoadRejected,
    fileSources,
    settingsService,
    initialMerged,
  );
}
/**
 * Read an explicitly configured loading-phrase mode using the same precedence
 * as {@link mergeSettings}. The merged view cannot distinguish an explicit
 * `off` from the schema default, which matters for features that are on by
 * default but still use `ui.loadingPhrases` as their opt-out.
 */
export function getExplicitLoadingPhrasesMode(
  loadedSettings: LoadedSettings,
): LoadingPhrasesMode | undefined {
  const scopes = [
    loadedSettings.flag.settings,
    loadedSettings.isTrusted ? loadedSettings.local.settings : undefined,
    loadedSettings.project.settings,
    loadedSettings.user.settings,
  ];

  for (const scope of scopes) {
    const mode = scope?.ui?.loadingPhrases;
    if (
      mode === 'tips' ||
      mode === 'witty' ||
      mode === 'all' ||
      mode === 'off'
    ) {
      return mode;
    }
  }

  return undefined;
}

function findEnvFile(workspaceDir: string): string | null {
  // Project environment belongs to the exact workspace config directory.
  // Do not traverse ancestors or load ordinary .env files: those files belong
  // to the user's application and must not silently reconfigure itself.
  const projectEnvPath = path.join(
    path.resolve(workspaceDir),
    CONFIG_DIR,
    '.env',
  );
  if (fs.existsSync(projectEnvPath)) {
    return projectEnvPath;
  }

  // User-global environment is the only fallback.
  return fs.existsSync(USER_CONFIG_ENV_PATH) ? USER_CONFIG_ENV_PATH : null;
}

const loadedEnvironment = new Map<
  string,
  { previous: string | undefined; injected: string }
>();
let environmentOwner = process.env;
let productProcessOnlyEnvironmentVariables: ReadonlySet<string> = new Set();

/** Installed by the application owner before settings or .env are loaded. */
export function setProcessOnlyEnvironmentVariables(
  keys: readonly string[],
): () => void {
  const variables = new Set(keys);
  productProcessOnlyEnvironmentVariables = variables;
  return () => {
    if (productProcessOnlyEnvironmentVariables === variables) {
      productProcessOnlyEnvironmentVariables = new Set();
    }
  };
}

function injectEnvironment(key: string, value: string): void {
  if (environmentOwner !== process.env) {
    loadedEnvironment.clear();
    environmentOwner = process.env;
  }
  const previous = loadedEnvironment.get(key);
  loadedEnvironment.set(key, {
    previous:
      previous && process.env[key] === previous.injected
        ? previous.previous
        : process.env[key],
    injected: value,
  });
  process.env[key] = value;
}

/** 项目运行环境退出后，仅恢复 CLI 仍持有的注入值，不覆盖其他来源的更新。 */
export function restoreLoadedEnvironment(): void {
  if (environmentOwner === process.env) {
    for (const [key, { previous, injected }] of loadedEnvironment) {
      if (process.env[key] !== injected) continue;
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
  loadedEnvironment.clear();
  environmentOwner = process.env;
}

export function loadEnvironment(
  settings: Settings,
  workspaceDir: string,
  isWorkspaceTrustedFn = isWorkspaceTrusted,
): void {
  const envFilePath = findEnvFile(workspaceDir);
  const trustResult = isWorkspaceTrustedFn(settings, workspaceDir);

  const isTrusted = trustResult.isTrusted ?? false;

  if (envFilePath) {
    // Parse explicitly so values already supplied by the host or shell keep precedence.
    try {
      const envFileContent = fs.readFileSync(envFilePath, 'utf-8');
      const parsedEnv = dotenv.parse(envFileContent);

      const resolvedEnvFilePath = normalizePath(envFilePath);
      const isProjectExecutionEnvFile =
        resolvedEnvFilePath !== NORMALIZED_USER_CONFIG_ENV_PATH;

      for (const key in parsedEnv) {
        if (Object.hasOwn(parsedEnv, key)) {
          // Host identity and product-declared process-only variables must
          // never be supplied by project or user .env files.
          const processOnlyKey =
            process.platform === 'win32' ? key.toUpperCase() : key;
          if (
            processOnlyKey === ENV_AGENT_SDK_ENTRYPOINT ||
            productProcessOnlyEnvironmentVariables.has(processOnlyKey)
          ) {
            continue;
          }
          const value = parsedEnv[key];
          const isProtectedExecutionEnvVar =
            matchesExecutionEnvVar(
              USER_GLOBAL_EXECUTION_OVERRIDE_ENV_VARS,
              key,
            ) ||
            (process.platform === 'win32' &&
              matchesExecutionEnvVar(
                WINDOWS_UNTRUSTED_PROJECT_DISCOVERY_ENV_VARS,
                key,
              ));
          // A project-controlled env file must not be able to prepend an
          // unreviewed executable, replace the Windows Bash executable, or
          // redirect its executable discovery on Windows in an untrusted
          // workspace. Parent-process and user-global values remain trusted.
          if (
            !isTrusted &&
            isProjectExecutionEnvFile &&
            isProtectedExecutionEnvVar
          ) {
            continue;
          }

          // Load variable only if it's not already set in the environment.
          if (!Object.hasOwn(process.env, key)) {
            injectEnvironment(key, value);
          }
        }
      }
    } catch {
      // Errors are ignored to match the behavior of `dotenv.config({ quiet: true })`.
    }
  }
}

export type SettingSource = 'user' | 'project' | 'local';

const ALL_SETTING_SOURCES: readonly SettingSource[] = [
  'user',
  'project',
  'local',
];

let defaultSettingSourcesForProcess: readonly SettingSource[] | undefined;

function normalizeSettingSources(
  sources: readonly SettingSource[] | undefined,
): readonly SettingSource[] {
  if (sources === undefined) {
    return ALL_SETTING_SOURCES;
  }
  const requested = new Set(sources);
  return ALL_SETTING_SOURCES.filter((source) => requested.has(source));
}

/**
 * Sets the source selection used by resolutions without explicit sources in the
 * current CLI process. This keeps hot reloads and command callbacks aligned
 * with the startup `--setting-sources` flag.
 * @internal
 */
export function setDefaultSettingSourcesForProcess(
  sources: readonly SettingSource[] | undefined,
): void {
  defaultSettingSourcesForProcess =
    sources === undefined ? undefined : normalizeSettingSources(sources);
}

/**
 * Clears the settings cache so that the next resolution
 * re-reads all settings files from disk. Used by the settings-change
 * hot-reload path to ensure freshly-written files are not masked by
 * the TTL-based cache.
 */
export function clearSettingsCache(): void {
  invalidateSettingsFileSources();
}

/**
 * Resets the settings cache. Used exclusively for test isolation.
 * @internal
 */
export function resetSettingsCacheForTesting() {
  clearSettingsCache();
}

export type FlagSettingsInput = NonNullable<ResolveSettingsOptions['flagSettings']>;

// The startup invocation registers its flag layer before the first resolution.
let flagSettingsInput: FlagSettingsInput | undefined;

export function setFlagSettingsInput(input: FlagSettingsInput | undefined): void {
  flagSettingsInput = input;
}

export function getFlagSettingsInput(): FlagSettingsInput | undefined {
  return flagSettingsInput;
}

/**
 * Sets the path to the flag-provided settings file (from --settings CLI flag).
 * Callers must invoke this before any resolution to avoid serving
 * stale cached results.
 */
export function setFlagSettingsPath(p: string | undefined): void {
  setFlagSettingsInput(p);
}

/**
 * Returns the path supplied by a file-backed --settings invocation.
 */
export function getFlagSettingsPath(): string | undefined {
  return typeof flagSettingsInput === 'string' ? flagSettingsInput : undefined;
}

/**
 * Resolve `${ENV_VAR}` placeholders in a settings object for runtime use.
 *
 * The `hooks` subtree is skipped so HTTP hook header placeholders like
 * "${MY_SECRET}" survive for hookRunner.interpolateEnvVars() to resolve later
 * against its allowedEnvVars whitelist. Shared by the initial full load and
 * the disk-refresh path so both apply identical resolution.
 */
function resolveSettingsEnv<T>(obj: T): T {
  return resolveEnvVarsInObject(obj, { rootSkipKeys: new Set(['hooks']) });
}

/** Migrate legacy theme names in-place. Shared by full load and reload. */
export function normalizeLegacyThemeNames(settings: Settings): void {
  if (settings.ui?.theme === 'VS') {
    settings.ui.theme = DefaultLight.name;
  } else if (settings.ui?.theme === 'VS2015') {
    settings.ui.theme = DefaultDark.name;
  }
}

/** Result of parsing a single settings file from disk. */
type SettingsFileLoadResult = {
  settings: Settings;
  originalSettings: Settings;
  rawJson?: string;
  rejected?: boolean;
};

/** Per-file load behavior (error severity + validation recovery). */
type SettingsFileLoadOptions = {
  validation: SettingsDefinition['validation'];
  recoverValidationIssues?: boolean;
  fatalFileErrors?: boolean;
  fatalValidationErrors?: boolean;
  inlineJson?: string;
};

/**
 * Parse a single settings file from disk.
 *
 * Shared by the initial full load (`_doLoadSettings`) and the focused
 * disk-refresh (`LoadedSettings.reload`) so both paths
 * apply identical normalization, sanitization, and validation. Any file or
 * validation problems are appended to `errorsSink`; a fatal-severity entry is
 * the caller's signal to abort. Missing files return empty settings.
 */
function loadSettingsFile(
  filePath: string,
  errorsSink: SettingsError[],
  options: SettingsFileLoadOptions,
  source?: UserSettingsSource,
): SettingsFileLoadResult {
  const { validation } = options;
  const validate = (data: unknown) => validation.safeParse(data);
  const fileErrorSeverity =
    options.fatalFileErrors === false ? 'warning' : 'error';
  const validationErrorSeverity =
    options.fatalValidationErrors === false ? 'warning' : 'error';

  try {
    const content =
      options.inlineJson ??
      (source
        ? source.read()
        : fs.existsSync(filePath)
          ? fs.readFileSync(filePath, 'utf-8')
          : undefined);
    if (content !== undefined) {
      const rawSettings: unknown = JSON.parse(
        stripJsonComments(stripBOM(content)),
      );

      if (
        typeof rawSettings !== 'object' ||
        rawSettings === null ||
        Array.isArray(rawSettings)
      ) {
        errorsSink.push({
          message: 'Settings file is not a valid JSON object.',
          path: filePath,
          severity: fileErrorSeverity,
        });
        return { settings: {}, originalSettings: {}, rejected: true };
      }

      const settingsObject = rawSettings as Record<string, unknown>;
      const originalSettingsObject = structuredClone(settingsObject);
      normalizeLegacySettingsShape(settingsObject);
      normalizeLegacySettingsShape(originalSettingsObject);
      // Invalid individual MCP servers are skipped so the rest of settings can
      // still load; the original file contents are preserved for persistence.
      if (options.recoverValidationIssues) {
        const skippedServers = skipInvalidMcpServerConfigs(
          settingsObject,
          validate,
        );
        for (const skipped of skippedServers) {
          errorsSink.push({
            message: skipped.reason,
            path: filePath,
            severity: 'warning',
          });
        }
      }

      const compatibilityValidation = options.recoverValidationIssues
        ? sanitizeRecoverableSettingsValidationIssues(settingsObject, validate)
        : {
            ignoredIssues: [],
            validationResult: validate(settingsObject),
          };
      for (const ignored of compatibilityValidation.ignoredIssues) {
        errorsSink.push({
          message: ignored.reason,
          path: filePath,
          severity: 'warning',
        });
      }

      const validationResult = compatibilityValidation.validationResult;
      if (!validationResult.success && validationResult.error) {
        const errorMessage = formatValidationError(
          validationResult.error,
          filePath,
        );
        errorsSink.push({
          message: errorMessage,
          path: filePath,
          severity: validationErrorSeverity,
        });
        if (validationErrorSeverity === 'warning') {
          return {
            settings: {} as Settings,
            originalSettings: originalSettingsObject as Settings,
            rawJson: content,
            rejected: true,
          };
        }
      }

      return {
        settings: settingsObject as Settings,
        originalSettings: originalSettingsObject as Settings,
        rawJson: content,
      };
    }
  } catch (error: unknown) {
    errorsSink.push({
      message: getErrorMessage(error),
      path: filePath,
      severity: fileErrorSeverity,
    });
    return {
      settings: {} as Settings,
      originalSettings: {} as Settings,
      rejected: true,
    };
  }
  return { settings: {}, originalSettings: {} };
}

/** Load options for the three persistable disk scopes (non-fatal recovery). */
const PERSISTABLE_DISK_LOAD_OPTIONS = {
  recoverValidationIssues: true,
  fatalFileErrors: false,
  fatalValidationErrors: false,
};

/**
 * Loads settings from user and project directories.
 * Project settings override user settings.
 */
/** CLI-owned defaults are resolved before crossing the Resource boundary. */
export function getSettingsResolveOptions(
  projectPath: string,
  sources?: readonly SettingSource[],
  flagSettings?: FlagSettingsInput,
): ResolveSettingsOptions {
  return {
    projectPath: path.resolve(projectPath),
    sources: normalizeSettingSources(
      sources ?? defaultSettingSourcesForProcess,
  ),
    flagSettings: flagSettings ?? getFlagSettingsInput(),
  };
}

/** Flag overrides were requested explicitly, so unrecoverable errors are fatal. */
const FLAG_LOAD_OPTIONS = {
  recoverValidationIssues: true,
  fatalFileErrors: true,
  fatalValidationErrors: true,
};

function throwIfFatalSettingsErrors(errors: readonly SettingsError[]): void {
  const fatalErrors = errors.filter((e) => e.severity === 'error');
  if (fatalErrors.length === 0) return;
  const errorMessages = fatalErrors.map(
    (error) => `Error in ${error.path}: ${error.message}`,
  );
  throw new FatalConfigError(
    `${errorMessages.join('\n')}\nPlease fix the configuration file(s) and try again.`,
  );
}

/**
 * Resolve a flag source on its own, for callers that replace only the
 * flag layer of an existing {@link LoadedSettings} (see `setFlagSettings`).
 */
export function loadFlagSettings(
  input: FlagSettingsInput,
  validation: SettingsDefinition['validation'],
): {
  flag: SettingsFile;
  errors: SettingsError[];
} {
  const errors: SettingsError[] = [];
  let inlineJson: string | undefined;
  if (typeof input !== 'string') {
    // Keep the wire payload's JSON semantics when reusing the flag loader.
    try {
      inlineJson = JSON.stringify(input, null, 2);
    } catch (error) {
      throw new Error(`Invalid settings payload: ${getErrorMessage(error)}`);
    }
    if (inlineJson === undefined) {
      throw new Error('Invalid settings payload: expected a JSON object');
    }
  }
  const flagPath = typeof input === 'string' ? input : '<flag>';
  const result = loadSettingsFile(flagPath, errors, {
    ...FLAG_LOAD_OPTIONS,
    validation,
    inlineJson,
  });
  throwIfFatalSettingsErrors(errors);
  return {
    flag: {
      path: flagPath,
      originalSettings: structuredClone(result.originalSettings),
      settings: resolveSettingsEnv(result.settings),
      rawJson: result.rawJson,
      readOnly: true,
    },
    errors,
  };
}

/**
 * Migrates deprecated settings to their new counterparts.
 *
 * Deprecated settings are removed from settings files by default.
 *
 * @returns true if any changes were made and need to be saved.
 */
export function migrateDeprecatedSettings(
  loadedSettings: Pick<
    LoadedSettings,
    'forScope' | 'isTrusted' | 'mutateScope'
  >,
  removeDeprecated = true,
): boolean {
  let anyModified = false;
  const migratedPaths = ['general', 'ui', 'context', 'tools', 'model'] as const;

  /**
   * Helper to migrate a boolean setting and track it if it's deprecated.
   */
  const migrateBoolean = (
    settings: Record<string, unknown>,
    oldKey: string,
    newKey: string,
  ): boolean => {
    let modified = false;
    const oldValue = settings[oldKey];
    const newValue = settings[newKey];

    if (typeof oldValue === 'boolean') {
      if (typeof newValue === 'boolean') {
        // Both exist, trust the new one
        if (removeDeprecated) {
          delete settings[oldKey];
          modified = true;
        }
      } else {
        // Only old exists, migrate to new (inverted)
        settings[newKey] = !oldValue;
        if (removeDeprecated) {
          delete settings[oldKey];
        }
        modified = true;
      }
    }
    return modified;
  };

  const processScope = (scope: LoadableSettingScope) => {
    const settingsFile = loadedSettings.forScope(scope);
    if (scope === SettingScope.Project && !loadedSettings.isTrusted) return;

    const applyMigrations = (settings: Settings) => {
      const generalSettings = settings.general as
        | Record<string, unknown>
        | undefined;
      if (generalSettings) {
        const next = { ...generalSettings };
        migrateBoolean(next, 'disableAutoUpdate', 'enableAutoUpdate');
        migrateBoolean(
          next,
          'disableUpdateNag',
          'enableAutoUpdateNotification',
        );
        settings.general = next;
      }

      const uiSettings = settings.ui as Record<string, unknown> | undefined;
      if (uiSettings) {
        const nextUi = { ...uiSettings };
        const accessibility = nextUi['accessibility'] as
          | Record<string, unknown>
          | undefined;
        if (accessibility) {
          const nextAccessibility = { ...accessibility };
          migrateBoolean(
            nextAccessibility,
            'disableLoadingPhrases',
            'enableLoadingPhrases',
          );
          nextUi['accessibility'] = nextAccessibility;
          if (
            nextAccessibility['enableLoadingPhrases'] === false &&
            nextUi['loadingPhrases'] === undefined
          ) {
            nextUi['loadingPhrases'] = 'off';
          }
        }
        settings.ui = nextUi;
      }

      const contextSettings = settings.context as
        | Record<string, unknown>
        | undefined;
      if (contextSettings) {
        const nextContext = { ...contextSettings };
        const fileFiltering = nextContext['fileFiltering'] as
          | Record<string, unknown>
          | undefined;
        if (fileFiltering) {
          const nextFileFiltering = { ...fileFiltering };
          migrateBoolean(
            nextFileFiltering,
            'disableFuzzySearch',
            'enableFuzzySearch',
          );
          nextContext['fileFiltering'] = nextFileFiltering;
        }
        settings.context = nextContext;
      }

      const toolsSettings = settings.tools as
        | Record<string, unknown>
        | undefined;
      if (toolsSettings?.['approvalMode'] !== undefined) {
        const nextGeneral = {
          ...((settings.general as Record<string, unknown> | undefined) ?? {}),
        };
        if (nextGeneral['defaultPermissionMode'] === undefined) {
          nextGeneral['defaultPermissionMode'] = toolsSettings['approvalMode'];
          settings.general = nextGeneral;
        }
        if (removeDeprecated) {
          const nextTools = { ...toolsSettings };
          delete nextTools['approvalMode'];
          settings.tools = nextTools;
        }
      }

      migrateModelPreferences(settings, removeDeprecated);
    };

    // 常见启动路径没有待迁移字段，先用已加载快照排除，避免每次启动都多拿三次写锁。
    const preview = structuredClone(settingsFile.settings);
    applyMigrations(preview);
    const previewRecord = preview as Record<string, unknown>;
    const currentRecord = settingsFile.settings as Record<string, unknown>;
    if (
      migratedPaths.every((key) =>
        isDeepStrictEqual(currentRecord[key], previewRecord[key]),
      )
    ) {
      return;
    }

    let scopeModified = false;
    const success = loadedSettings.mutateScope(scope, (editor) => {
      const settings = editor.get([]) as Settings;
      const before = structuredClone(settings) as Record<string, unknown>;

      applyMigrations(settings);

      const after = settings as Record<string, unknown>;
      for (const key of migratedPaths) {
        if (isDeepStrictEqual(before[key], after[key])) continue;
        scopeModified = true;
        if (after[key] === undefined) editor.delete(key);
        else editor.set(key, after[key]);
      }
    });

    if (success && scopeModified && !settingsFile.readOnly) {
      anyModified = true;
    }
  };

  processScope(SettingScope.User);
  processScope(SettingScope.Project);
  processScope(SettingScope.Local);

  return anyModified;
}

export function saveModelChange(
  loadedSettings: LoadedSettings,
  model: string,
): boolean {
  try {
    return loadedSettings.setValue(SettingScope.User, 'model.name', model);
  } catch (error) {
    const detailedErrorMessage = getFsErrorMessage(error);
    coreEvents.emitFeedback(
      'error',
      `Failed to save preferred model: ${detailedErrorMessage}`,
      error,
    );
    return false;
  }
}

/**
 * Model IDs can contain `.` or `/`, so the path is passed as explicit
 * segments and updated against the latest on-disk preferences map.
 */
function readPreferencesRecord(
  model: Record<string, unknown>,
): Record<string, ModelPreferenceEntry> {
  const existing = model['preferences'];
  return existing && typeof existing === 'object'
    ? (existing as Record<string, ModelPreferenceEntry>)
    : {};
}

/**
 * Migrates both legacy model-preference formats:
 *
 * - `model.preferences[modelId].generation` is flattened in place.
 * - `model.reasoningEffort` and `model.contextWindow` move under the current
 *   model preference; the retired `model.functionSwitchSelections` is dropped.
 *
 * Nested generation wrappers can migrate without `model.name` because they
 * are already keyed by model id. The older model-level fields still require a
 * non-empty `model.name`; otherwise the read-path fallback keeps honoring them.
 * Explicit flattened values always win over nested compatibility values.
 *
 * @returns true if the settings object was modified.
 */
function migrateModelPreferences(
  settings: Settings,
  removeDeprecated: boolean,
): boolean {
  const model = settings.model as Record<string, unknown> | undefined;
  if (!model || typeof model !== 'object') return false;

  const name = model['name'];
  const legacyEffort = model['reasoningEffort'];
  const legacyContextWindow = model['contextWindow'];

  const hasLegacy =
    legacyEffort !== undefined ||
    legacyContextWindow !== undefined ||
    model['functionSwitchSelections'] !== undefined;

  const nextModel = structuredClone(model);
  const preferences = readPreferencesRecord(nextModel);
  let modified = false;

  for (const [modelId, preference] of Object.entries(preferences)) {
    if (
      preference &&
      typeof preference === 'object' &&
      preference.generation !== undefined
    ) {
      preferences[modelId] = modelPreferenceWithGeneration(
        preference,
        generationConfigFromModelPreference(preference),
      );
      modified = true;
    }
  }

  const canMigrateModelFields =
    hasLegacy && typeof name === 'string' && name.length > 0;
  if (canMigrateModelFields) {
    const modelName = name;
    let entry: ModelPreferenceEntry = { ...(preferences[modelName] ?? {}) };

    if (
      entry.contextWindow === undefined &&
      typeof legacyContextWindow === 'number'
    ) {
      entry.contextWindow = legacyContextWindow;
      modified = true;
    }

    const legacyGeneration = generationConfigFromLegacyFields({
      reasoningEffort: legacyEffort,
    });
    const existingGeneration = generationConfigFromModelPreference(entry);
    const existingReasoning = existingGeneration?.reasoning;
    const hasExistingReasoningBehavior =
      existingReasoning?.enabled !== undefined ||
      existingReasoning?.effort !== undefined ||
      existingReasoning?.budgetTokens !== undefined;
    if (legacyGeneration?.reasoning && !hasExistingReasoningBehavior) {
      entry = modelPreferenceWithGeneration(entry, {
        ...(existingGeneration ?? {}),
        reasoning: {
          ...legacyGeneration.reasoning,
          ...(existingReasoning ?? {}),
        },
      });
      modified = true;
    }

    preferences[modelName] = entry;
  }

  if (modified) nextModel['preferences'] = preferences;

  if (removeDeprecated && canMigrateModelFields) {
    for (const key of [
      'reasoningEffort',
      'contextWindow',
      'functionSwitchSelections',
    ] as const) {
      if (nextModel[key] !== undefined) {
        delete nextModel[key];
        modified = true;
      }
    }
  }

  if (!modified) return false;
  settings.model = nextModel;
  return true;
}
