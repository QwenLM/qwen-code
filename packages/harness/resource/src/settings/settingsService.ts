/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
// Resource cannot depend on Core; CLI supplies its effective homeDir explicitly.
// eslint-disable-next-line no-restricted-imports
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LoadedSettings, type LoadedSettingsFile } from './loadedSettings.js';
import {
  createSettingsSchema,
  createSettingsSchemaDefinitions,
  type Settings,
  type MergedSettings,
  type SettingsSchema,
  type SettingsSchemaDefaults,
  type SettingsSchemaReferences,
  type SettingsSchemaType,
} from './settingsSchema.js';
import {
  SettingsSourceStore,
  type SettingsFileSource,
  type SettingsFileChangeEvent,
  type UserSettingsSource,
} from './settingsFileSource.js';
import stripJsonComments from 'strip-json-comments';
import { isSettingsObject, mergeDefinedSettings } from './mergeSettings.js';
import type {
  ResolveSettingsOptions,
  SettingsFile,
  SettingsValues,
  SettingsError,
  SettingsSource,
  SettingsDefinition,
  InitializeSettingsOptions,
  SettingsRuntimeContext,
} from './settingsTypes.js';

import {
  normalizeLegacySettingsShape,
  skipInvalidMcpServerConfigs,
  sanitizeRecoverableSettingsValidationIssues,
} from './settingsValidation.js';
import {
  resolveEnvVarsInObject,
  loadSettingsEnvironment,
} from './settingsEnvironment.js';
import { isProjectTrusted, isSameSettingsDirectory } from './projectTrust.js';

interface ReadResult {
  file: SettingsFile;
  errors: SettingsError[];
}
function empty(path: string): ReadResult {
  return { file: { path, settings: {}, originalSettings: {} }, errors: [] };
}
function readSettings(path: string, source?: SettingsFileSource): ReadResult {
  const result = empty(path);
  try {
    const rawJson = source ? source.read() : readFileSync(path, 'utf8');
    if (rawJson === undefined) return result;
    const text = rawJson.replace(/^\uFEFF/, '');
    const value: unknown = JSON.parse(stripJsonComments(text));
    if (!isSettingsObject(value))
      throw new Error('Settings must be a JSON object.');
    result.file.settings = value;
    result.file.rawJson = rawJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.file.loadRejected = true;
      result.errors.push({
        path,
        severity: 'warning',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

const defaultSchemas = new WeakMap<SettingsSchemaDefaults, SettingsSchemaType>();
const defaultReferences = new WeakMap<
  SettingsSchemaDefaults,
  SettingsSchemaReferences
>();

/** Scoped settings reader; product rules are shared schema data, not a loader. */
export class SettingsService {
  /** Share the base schema across callers that use the same defaults object. */
  static getDefaultSchema(defaults: SettingsSchemaDefaults): SettingsSchemaType {
    let schema = defaultSchemas.get(defaults);
    if (!schema) {
      schema = createSettingsSchema(defaults);
      defaultSchemas.set(defaults, schema);
    }
    return schema;
  }

  /** Product extension point used when configuring a service without rules. */
  getSchema(defaults: SettingsSchemaDefaults): SettingsSchema {
    return SettingsService.getDefaultSchema(defaults);
  }

  /** Reference definitions and field validators for the product schema. */
  getSchemaReferences(
    defaults: SettingsSchemaDefaults,
  ): SettingsSchemaReferences {
    return SettingsService.getDefaultSchemaReferences(defaults);
  }

  static getDefaultSchemaReferences(
    defaults: SettingsSchemaDefaults,
  ): SettingsSchemaReferences {
    let references = defaultReferences.get(defaults);
    if (!references) {
      references = {
        definitions: createSettingsSchemaDefinitions(defaults.getCliName),
      };
      defaultReferences.set(defaults, references);
    }
    return references;
  }

  constructor(
    private definition?: SettingsDefinition,
    private context: SettingsRuntimeContext = {},
  ) {}

  private readonly store = new SettingsSourceStore();
  private user?: UserSettingsSource;
  private initialized = false;
  private disposed = false;
  private projectConfigDirName = '.qwen';
  private policySettingsPath?: string;

  get isInitialized(): boolean {
    this.assertAvailable();
    return this.initialized;
  }

  /** Bind a process user file independently of parsed-settings initialization. */
  getUserSettingsSource(filePath: string): UserSettingsSource {
    this.assertAvailable();
    return this.store.getUser(filePath);
  }

  /** Bind on first use; an already fixed, different user root is incompatible. */
  getCompatibleUserSettingsSource(
    filePath: string,
  ): UserSettingsSource | undefined {
    this.assertAvailable();
    return this.store.peekUser()
      ? this.store.tryGetUser(filePath)
      : this.store.getUser(filePath);
  }

  /** Never bind a root. An optional path additionally requires an exact match. */
  peekUserSettingsSource(filePath?: string): UserSettingsSource | undefined {
    this.assertAvailable();
    return filePath === undefined
      ? this.store.peekUser()
      : this.store.tryGetUser(filePath);
  }

  /** Reuse a project/local pair by file paths, never by session policy. */
  getProjectSettingsSources(
    projectPath: string,
    localPath: string,
  ): { project: SettingsFileSource; local: SettingsFileSource } {
    this.assertAvailable();
    return this.store.getProject(projectPath, localPath);
  }

  watchFiles(
    paths: readonly string[],
    listener: (event: SettingsFileChangeEvent) => void,
  ): Promise<() => void> {
    this.assertAvailable();
    return this.store.watchFiles(paths, listener);
  }

  takeWatchUnavailableWarning(): boolean {
    return this.store.takeWatchUnavailableWarning();
  }

  invalidateAll(): void {
    this.store.invalidateAll();
  }

  /** Fill missing product rules independently of directory initialization.
   * Existing host rules win, and repeated calls cannot replace adopted rules.
   */
  configureDefaults(
    rules:
      | SettingsDefinition
      | {
          defaults: SettingsSchemaDefaults;
          createValidation: (
            schema: SettingsSchema,
            references: SettingsSchemaReferences,
          ) => SettingsDefinition['validation'];
        },
    context: SettingsRuntimeContext,
  ): void {
    this.assertAvailable();
    if (!this.definition) {
      if ('schema' in rules) {
        this.definition = rules;
      } else {
        const schema = this.getSchema(rules.defaults);
        this.definition = {
          schema,
          validation: rules.createValidation(
            schema,
            this.getSchemaReferences(rules.defaults),
          ),
        };
      }
    }
    this.context = { ...context, ...this.context };
  }

  /** The rules actually used for validation and merge, including explicit rules. */
  getDefinition(): Readonly<SettingsDefinition> | undefined {
    return this.definition;
  }

  /** Prime the shared user source; repeated initialization never rereads it. */
  initialize(options: InitializeSettingsOptions): void {
    this.assertAvailable();
    const settingsPath = options.userSettingsPath
      ? resolve(options.userSettingsPath)
      : join(resolve(options.userConfigDir), 'settings.json');
    const projectConfigDirName = options.projectConfigDirName ?? '.qwen';
    const policySettingsPath = options.policySettingsPath
      ? resolve(options.policySettingsPath)
      : undefined;
    if (this.initialized) {
      if (
        pathKey(this.user!.path) !== pathKey(settingsPath) ||
        this.projectConfigDirName !== projectConfigDirName ||
        this.policySettingsPath !== policySettingsPath
      ) {
        throw new Error(
          'Settings directories are already fixed for this service',
        );
      }
      return;
    }
    const user = this.getUserSettingsSource(settingsPath);
    // Keep startup tolerant of unreadable files; resolve reports read warnings.
    try {
      user.read();
    } catch {
      // A failed read is not cached by the source and can recover on resolve.
    }
    this.projectConfigDirName = projectConfigDirName;
    this.policySettingsPath = policySettingsPath;
    this.user = user;
    this.initialized = true;
  }

  /**
   * 企业托管策略的只读投影。策略文件与普通设置文件形状不同，不参与 merge；
   * 读取失败按“无策略”处理，坏文件不会放宽限制（由调用方保留 last-known）。
   */
  getPolicySettings(): { path: string; value: Record<string, unknown> } | undefined {
    this.assertAvailable();
    if (!this.policySettingsPath) return undefined;
    const result = readSettings(this.policySettingsPath);
    if (result.file.loadRejected || !result.file.rawJson) return undefined;
    return {
      path: this.policySettingsPath,
      value: result.file.settings as Record<string, unknown>,
    };
  }

  private resolveEnvironment(values: SettingsValues): SettingsValues {
    return resolveEnvVarsInObject(values, {
      rootSkipKeys: new Set(['hooks']),
      customEnv: this.context.environment as Record<string, string> | undefined,
    });
  }

  private fatalError(message: string): Error {
    return this.context.createFatalError?.(message) ?? new Error(message);
  }

  private validateFile(layer: ReadResult, fatal = false, preserveValidValues = false): void {
    normalizeLegacySettingsShape(layer.file.settings);
    layer.file.originalSettings = structuredClone(layer.file.settings);
    if (!this.definition) return;
    const schema = this.definition.validation;
    const issues = skipInvalidMcpServerConfigs(layer.file.settings, schema);
    const { ignoredIssues, validationResult } =
      sanitizeRecoverableSettingsValidationIssues(layer.file.settings, schema);
    for (const issue of [...issues, ...ignoredIssues])
      layer.errors.push({
        path: layer.file.path,
        message: issue.reason,
        severity: 'warning',
      });
    if (!validationResult.success) {
      if (fatal)
        throw this.fatalError(
          `Invalid settings in ${layer.file.path}: ${validationResult.error.message}`,
        );
      layer.errors.push({
        path: layer.file.path,
        message: validationResult.error.message,
        severity: 'warning',
      });
      if (!preserveValidValues) {
        layer.file.loadRejected = true;
        layer.file.settings = {};
      }
    }
  }

  resolve(options: ResolveSettingsOptions): LoadedSettings {
    this.assertAvailable();
    if (!this.initialized || !this.user)
      throw new Error('SettingsService is not initialized');
    const sources = new Set<SettingsSource>(
      options.sources ?? ['user', 'project', 'local'],
    );
    const projectSettingsPath = resolve(
      options.projectPath,
      join(this.projectConfigDirName, 'settings.json'),
    );
    const localSettingsPath = resolve(
      options.projectPath,
      join(this.projectConfigDirName, 'settings.local.json'),
    );
    // HOME is not a project, even when the user config directory is overridden.
    const skipProject =
      pathKey(projectSettingsPath) === pathKey(this.user.path) ||
      isSameSettingsDirectory(
        options.projectPath,
        this.context.homeDir ?? homedir(),
      );
    const user = sources.has('user')
      ? readSettings(this.user.path, this.user)
      : empty(this.user.path);
    const projectSources =
      !skipProject && (sources.has('project') || sources.has('local'))
        ? this.getProjectSettingsSources(projectSettingsPath, localSettingsPath)
        : undefined;
    const readProject = (source: SettingsFileSource): ReadResult => {
      // resolve promises fresh project/local contents even without a watcher.
      if (this.context.refreshProjectSources !== false) source.invalidate();
      return readSettings(source.path, source);
    };
    const project =
      sources.has('project') && projectSources
        ? readProject(projectSources.project)
        : empty(projectSettingsPath);
    const local =
      sources.has('local') && projectSources
        ? readProject(projectSources.local)
        : empty(localSettingsPath);
    user.file.readOnly = !sources.has('user');
    project.file.readOnly = skipProject || !sources.has('project');
    local.file.readOnly = skipProject || !sources.has('local');
    const flagPath =
      typeof options.flagSettings === 'string'
        ? options.flagSettings
        : undefined;
    const flagResult =
      flagPath !== undefined
        ? readSettings(resolve(options.projectPath, flagPath))
        : empty('<flag>');
    if (flagPath !== undefined && !existsSync(flagResult.file.path))
      throw this.fatalError(`Settings file not found: ${flagResult.file.path}`);
    if (flagResult.errors.length)
      throw this.fatalError(
        flagResult.errors
          .map((error) => `${error.path}: ${error.message}`)
          .join('\n'),
      );
    const flag = flagResult.file;
    flag.readOnly = true;
    if (
      options.flagSettings !== undefined &&
      typeof options.flagSettings !== 'string'
    ) {
      if (!isSettingsObject(options.flagSettings))
        throw new Error('flagSettings must be a JSON object.');
      flag.settings = structuredClone(options.flagSettings);
    }
    const pendingRulesOptions = this.definition
      ? undefined
      : {
          ...options,
          projectPath: resolve(options.projectPath),
          sources: [...sources],
          flagSettings: structuredClone(options.flagSettings),
        };
    for (const layer of [user, project, local, flagResult]) {
      this.validateFile(layer, layer === flagResult);
      layer.file.settings = this.resolveEnvironment(layer.file.settings);
    }
    this.context.normalizeDisplaySettings?.(user.file.settings as Settings);
    this.context.normalizeDisplaySettings?.(project.file.settings as Settings);
    const headless =
      options.headless ??
      (typeof this.context.headless === 'function'
        ? this.context.headless()
        : this.context.headless) ??
      (!process.stdin.isTTY || !process.stdout.isTTY);
    const resolveTrust = (user: Settings): boolean => {
      const effectiveUser = mergeDefinedSettings(
        this.definition,
        user as SettingsValues,
      );
      return (
        this.context.resolveTrust?.(
          effectiveUser as Settings,
          options.projectPath,
          headless,
        ) ?? isProjectTrusted(effectiveUser, options.projectPath, headless)
      );
    };
    const isTrusted = resolveTrust(user.file.settings as Settings);
    const merge =
      this.context.mergeSettings ??
      ((user, project, trusted, local, flag) =>
        mergeDefinedSettings(
          this.definition,
          user as SettingsValues,
          trusted ? (project as SettingsValues) : {},
          trusted ? (local as SettingsValues) : {},
          flag as SettingsValues,
        ) as unknown as MergedSettings);
    const merged = merge(
      user.file.settings as Settings,
      project.file.settings as Settings,
      isTrusted,
      local.file.settings as Settings,
      flag.settings as Settings,
    );
    if (this.context.loadEnvironment) {
      this.context.loadEnvironment(
        merged,
        options.projectPath,
        options.headless === true ? isTrusted : undefined,
      );
    } else if (this.context.environment) {
      loadSettingsEnvironment(
        !skipProject &&
          isTrusted &&
          (sources.has('project') || sources.has('local'))
          ? join(dirname(projectSettingsPath), '.env')
          : undefined,
        join(dirname(this.user.path), '.env'),
        this.context.environment,
      );
    }
    if (skipProject) {
      project.file.path = '';
      local.file.path = '';
    }
    // Keep the logical source for inline overrides so their warnings can be
    // matched to the flag layer, including after a session updates it.
    if (options.flagSettings === undefined) flag.path = '';
    const settings = new LoadedSettings(
      {
        merge,
        hideUntrustedProject: this.context.hideUntrustedProject ?? false,
        ...(this.context.recomputeTrust !== false ? { resolveTrust } : {}),
        runtimeValues: (original) => {
          const layer: ReadResult = {
            file: {
              path: '',
              settings: structuredClone(original) as SettingsValues,
              originalSettings: {},
            },
            errors: [],
          };
          // A committed mutation must retain its valid touched values even if
          // unrelated disk fields exceed the recovery limit, as legacy writes did.
          this.validateFile(layer, false, true);
          for (const error of layer.errors) this.context.onWarning?.(error.message);
          return this.resolveEnvironment(layer.file.settings) as Settings;
        },
        normalizeOriginal: normalizeLegacySettingsShape,
        resolveEnvironment: (values) =>
          this.resolveEnvironment(values as SettingsValues) as Settings,
        normalizeDisplaySettings:
          this.context.normalizeDisplaySettings ?? (() => {}),
        readFile: (path, errors, source) => {
          const layer = readSettings(path, source);
          this.validateFile(layer);
          errors.push(...layer.errors);
          return layer.file as LoadedSettingsFile;
        },
        onChanged: this.context.onSettingsChanged,
        onPersisted: this.context.onSettingsPersisted,
        onReload: () => this.invalidateAll(),
        onWriteError: this.context.onWriteError,
        onWarning: this.context.onWarning,
        onError: this.context.onError,
        onInfrastructureError: this.context.onInfrastructureError,
      },
      user.file as LoadedSettingsFile,
      project.file as LoadedSettingsFile,
      local.file as LoadedSettingsFile,
      isTrusted,
      [
        ...user.errors,
        ...project.errors,
        ...local.errors,
        ...flagResult.errors,
      ],
      flag as LoadedSettingsFile,
      user.file.loadRejected === true,
      { user: sources.has('user') ? this.user : undefined, ...projectSources },
      this,
      merged,
      pendingRulesOptions && (() => this.resolve(pendingRulesOptions)),
    );
    this.context.onResolved?.(settings);
    return settings;
  }

  /** Reject new access while allowing active watch subscriptions to detach. */
  requestDispose(): Promise<void> | undefined {
    this.disposed = true;
    this.user = undefined;
    return this.store.requestDispose();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.user = undefined;
    return this.store.dispose();
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error('SettingsService is disposed');
  }
}
