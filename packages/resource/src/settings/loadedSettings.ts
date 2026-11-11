/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Settings, MergedSettings } from './settingsSchema.js';

import * as path from 'node:path';
import {
  mutateSettingsFile,
  type SettingsMutationOptions,
} from './settingsPersistence.js';
import {
  deleteCommentJsonProperty,
  getCommentJsonProperty,
  setCommentJsonProperty,
  toPlainJsonValue,
  type CommentJsonPath,
} from './commentJson.js';
import type { SettingsService } from './settingsService.js';
import type {
  SettingsFileSource,
  UserSettingsSource,
} from './settingsFileSource.js';
import type { SettingsMutationEditor, SettingsScope } from './settingsTypes.js';

export enum SettingScope {
  User = 'User',
  Project = 'Project',
  Local = 'Local',
  Session = 'Session',
}
export type LoadableSettingScope =
  | SettingScope.User
  | SettingScope.Project
  | SettingScope.Local;
export type SettingsPath = CommentJsonPath;
export type SessionSettingsScope =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings';
export interface LoadedSettingsError {
  message: string;
  path: string;
  severity: 'error' | 'warning';
}
type SettingsError = LoadedSettingsError;
export interface LoadedSettingsFile {
  settings: Settings;
  originalSettings: Settings;
  path: string;
  rawJson?: string;
  readOnly?: boolean;
  /** Existing loader rejected this layer; diagnostics consumers must not treat it as empty. */
  loadRejected?: boolean;
}
export interface LoadedSettingsSnapshot {
  user: LoadedSettingsFile;
  project: LoadedSettingsFile;
  local: LoadedSettingsFile;
  flag: LoadedSettingsFile;
  isTrusted: boolean;
  errors: SettingsError[];
  merged: MergedSettings;
}
export interface SettingsFileSources {
  user?: UserSettingsSource;
  project?: SettingsFileSource;
  local?: SettingsFileSource;
}

/** Product rules and host effects; no Core or CLI dependency is retained. */
export interface LoadedSettingsHost {
  merge(
    user: Settings,
    project: Settings,
    trusted: boolean,
    local: Settings,
    flag: Settings,
  ): MergedSettings;
  runtimeValues(original: Settings): Settings;
  normalizeOriginal(original: Record<string, unknown>): void;
  resolveEnvironment(settings: Settings): Settings;
  normalizeDisplaySettings(settings: Settings): void;
  readFile(
    path: string,
    errors: SettingsError[],
    source?: SettingsFileSource,
  ): {
    settings: Settings;
    originalSettings: Settings;
    rawJson?: string;
    loadRejected?: boolean;
  };
  /** Command projections recompute user-derived trust after mutations. Sessions adopt trust explicitly. */
  resolveTrust?(user: Settings): boolean;
  /** Raw command views predate the session's hidden-project view. */
  hideUntrustedProject?: boolean;
  onChanged?(): void;
  onPersisted?(): void;
  onReload?(): void;
  /** Return true if attaching the service changes the projection's merge rules. */
  onServiceAttached?(service: SettingsService): boolean;
  onWriteError?(operation: 'save' | 'update', error: unknown): void;
  onWarning?(message: string): void;
  onError?(message: string): void;
  onInfrastructureError?: SettingsMutationOptions['onInfrastructureError'];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A context's adopted settings, independent of the host's runtime Config. */
export class LoadedSettings {
  constructor(
    private host: LoadedSettingsHost,
    user: LoadedSettingsFile,
    project: LoadedSettingsFile,
    local: LoadedSettingsFile,
    isTrusted: boolean,
    errors: SettingsError[] = [],
    flag?: LoadedSettingsFile,
    userSettingsLoadRejected: boolean = false,
    private fileSources?: SettingsFileSources,
    private settingsService?: SettingsService,
    initialMerged?: MergedSettings,
    private resolveWithRules?: () => LoadedSettings,
  ) {
    this.user = user;
    this._projectFile = project;
    this.local = local;
    this.flag = flag ?? {
      path: '',
      settings: {} as Settings,
      originalSettings: {} as Settings,
      readOnly: true,
    };
    this.isTrusted = isTrusted;
    this.project =
      isTrusted || host.hideUntrustedProject === false
        ? project
        : this.createEmptyProject(project);
    this.errors = errors;
    this._userSettingsLoadRejected = userSettingsLoadRejected;
    this._merged = initialMerged ?? this.computeMergedSettings();
    this._snapshot = this.computeSnapshot();
  }

  readonly user: LoadedSettingsFile;
  project: LoadedSettingsFile;
  readonly local: LoadedSettingsFile;
  flag: LoadedSettingsFile;
  isTrusted: boolean;
  readonly errors: SettingsError[];

  private _projectFile: LoadedSettingsFile;
  private _userSettingsLoadRejected: boolean;
  private _merged: MergedSettings;
  private _snapshot: LoadedSettingsSnapshot;
  private settingsRulesOnly = false;
  private readonly _subscribers = new Set<() => void>();
  private readonly ownWriteIds = new Set<string>();
  private changeQueue = Promise.resolve();
  private readonly _notifySubscribers = () => {
    for (const listener of [...this._subscribers]) {
      listener();
    }
  };

  /** The service that resolved or was attached to this settings projection. */
  getSettingsService(): SettingsService | undefined {
    return this.settingsService;
  }

  /** Refresh a projection resolved before its service had validation rules. */
  refreshSettingsRules(): void {
    if (!this.resolveWithRules || !this.settingsService?.getDefinition()) return;
    const refreshed = this.resolveWithRules();
    this.host = refreshed.host;
    for (const [file, next] of [
      [this.user, refreshed.user],
      [this._projectFile, refreshed._projectFile],
      [this.local, refreshed.local],
    ]) {
      Object.assign(file, next, {
        rawJson: next.rawJson,
        loadRejected: next.loadRejected,
      });
    }
    this.project =
      refreshed.project === refreshed._projectFile
        ? this._projectFile
        : refreshed.project;
    this.flag = refreshed.flag;
    this.isTrusted = refreshed.isTrusted;
    this.errors.splice(0, this.errors.length, ...refreshed.errors);
    this.fileSources = refreshed.fileSources;
    this._userSettingsLoadRejected = refreshed._userSettingsLoadRejected;
    this._merged = refreshed._merged;
    this._snapshot = refreshed._snapshot;
    this.resolveWithRules = undefined;
    this._notifySubscribers();
  }

  /** Adopt the service's rules and optionally share its file sources. */
  attachSettingsService(
    service: SettingsService,
    { bindFileSources = true } = {},
  ): void {
    if (this.settingsService) return;
    let fileSources = this.fileSources;
    if (bindFileSources) {
      fileSources = {};
      if (!this.user.readOnly && this.user.path) {
        fileSources.user = service.getCompatibleUserSettingsSource(
          this.user.path,
        );
      }
      if (
        (!this._projectFile.readOnly && this._projectFile.path) ||
        (!this.local.readOnly && this.local.path)
      ) {
        const sources = service.getProjectSettingsSources(
          this._projectFile.path,
          this.local.path,
        );
        if (!this._projectFile.readOnly) fileSources.project = sources.project;
        if (!this.local.readOnly) fileSources.local = sources.local;
      }
    }
    const rulesChanged = this.host.onServiceAttached?.(service);
    this.fileSources = fileSources;
    this.settingsService = service;
    this.settingsRulesOnly = !bindFileSources;
    if (rulesChanged) {
      this._merged = this.computeMergedSettings();
      this._snapshot = this.computeSnapshot();
      this._notifySubscribers();
    }
  }

  get merged(): MergedSettings {
    return this._merged;
  }

  setTrusted(isTrusted: boolean): void {
    if (this.isTrusted === isTrusted) {
      return;
    }
    this.isTrusted = isTrusted;
    this.project = isTrusted
      ? this._projectFile
      : this.createEmptyProject(this._projectFile);
    this._merged = this.computeMergedSettings();
    this._snapshot = this.computeSnapshot();
    this.notifyChanged();
  }

  /** Update the flag projection without replacing the Config-bound manager. */
  setFlagSettings(
    flag: LoadedSettingsFile,
    flagErrors: readonly SettingsError[] = [],
  ): void {
    const flagPaths = new Set(
      [this.flag.path, flag.path]
        .filter((filePath) => filePath.length > 0)
        .map((filePath) => path.resolve(filePath)),
    );
    const retainedErrors = this.errors.filter(
      (error) => !flagPaths.has(path.resolve(error.path)),
    );
    this.errors.splice(0, this.errors.length, ...retainedErrors, ...flagErrors);
    this.flag = flag;
    this._merged = this.computeMergedSettings();
    this._snapshot = this.computeSnapshot();
    this.notifyChanged();
  }

  private createEmptyProject(project: LoadedSettingsFile): LoadedSettingsFile {
    return {
      ...project,
      settings: {} as Settings,
      originalSettings: {} as Settings,
    };
  }

  private computeMergedSettings(): MergedSettings {
    if (this.host.resolveTrust) {
      this.isTrusted = this.host.resolveTrust(this.user.settings);
      this.project =
        this.isTrusted || this.host.hideUntrustedProject === false
          ? this._projectFile
          : this.createEmptyProject(this._projectFile);
    }
    return this.host.merge(
      this.user.settings,
      this.project.settings,
      this.isTrusted,
      this.local.settings,
      this.flag.settings,
    );
  }

  private computeSnapshot(): LoadedSettingsSnapshot {
    const cloneSettingsFile = (
      file: LoadedSettingsFile,
    ): LoadedSettingsFile => ({
      path: file.path,
      rawJson: file.rawJson,
      loadRejected: file.loadRejected,
      settings: structuredClone(file.settings),
      originalSettings: structuredClone(file.originalSettings),
    });
    return {
      user: cloneSettingsFile(this.user),
      project: cloneSettingsFile(this.project),
      local: cloneSettingsFile(this.local),
      flag: cloneSettingsFile(this.flag),
      isTrusted: this.isTrusted,
      errors: [...this.errors],
      merged: structuredClone(this._merged),
    };
  }

  // Passing this along with getSnapshot to useSyncExternalStore allows for idiomatic reactivity on settings changes
  // React will pass a listener fn into this subscribe fn
  // that listener fn will perform an object identity check on the snapshot and trigger a React re render if the snapshot has changed
  subscribe(listener: () => void): () => void {
    this._subscribers.add(listener);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this._subscribers.delete(listener);
    };
  }

  private notifyChanged(): void {
    this._notifySubscribers();
    this.host.onChanged?.();
  }

  getSnapshot(): LoadedSettingsSnapshot {
    return this._snapshot;
  }

  isUserSettingsLoadRejected(): boolean {
    return this._userSettingsLoadRejected;
  }

  forScope(scope: LoadableSettingScope | SettingsScope): LoadedSettingsFile {
    switch (scope) {
      case 'user':
      case SettingScope.User:
        return this.user;
      case 'project':
      case SettingScope.Project:
        return this.project;
      case 'local':
      case SettingScope.Local:
        return this.local;
      default:
        throw new Error(`Invalid scope: ${scope}`);
    }
  }

  private isPersistable(settingsFile: LoadedSettingsFile): boolean {
    return !settingsFile.readOnly && settingsFile.path.length > 0;
  }

  private mutableFileForScope(
    scope: LoadableSettingScope | SettingsScope,
  ): LoadedSettingsFile {
    return scope === SettingScope.Project || scope === 'project'
      ? this._projectFile
      : this.forScope(scope);
  }

  private createMutationEditor(root: Record<string, unknown>): {
    editor: SettingsMutationEditor;
    changed: () => boolean;
    touchedPaths: SettingsPath[];
  } {
    let didChange = false;
    const touchedPaths: SettingsPath[] = [];
    // 即使磁盘值未变，也要用最新值刷新本次操作涉及的运行时字段。
    const touch = (path: SettingsPath) => {
      touchedPaths.push(typeof path === 'string' ? path : [...path]);
    };
    const editor: SettingsMutationEditor = {
      get: (path) => toPlainJsonValue(getCommentJsonProperty(root, path)),
      set: (path, value) => {
        touch(path);
        const changed = setCommentJsonProperty(root, path, value);
        didChange ||= changed;
        return changed;
      },
      delete: (path) => {
        touch(path);
        const changed = deleteCommentJsonProperty(root, path);
        didChange ||= changed;
        return changed;
      },
      update: (path, updater) => {
        touch(path);
        const current = toPlainJsonValue(getCommentJsonProperty(root, path));
        const next = updater(current);
        const changed =
          next === undefined
            ? deleteCommentJsonProperty(root, path)
            : setCommentJsonProperty(root, path, next);
        didChange ||= changed;
        return changed;
      },
    };
    return { editor, changed: () => didChange, touchedPaths };
  }

  private runtimeSettingsFromOriginal(original: Settings): Settings {
    return this.host.runtimeValues(original);
  }

  private applyTouchedRuntimePaths(
    target: LoadedSettingsFile,
    runtimeSource: Settings,
    touchedPaths: readonly SettingsPath[],
  ): boolean {
    let changed = false;
    const targetRoot = target.settings as Record<string, unknown>;
    const sourceRoot = runtimeSource as Record<string, unknown>;
    for (const path of touchedPaths) {
      const value = getCommentJsonProperty(sourceRoot, path);
      if (value === undefined) {
        changed = deleteCommentJsonProperty(targetRoot, path) || changed;
      } else {
        changed = setCommentJsonProperty(targetRoot, path, value) || changed;
      }
    }
    return changed;
  }

  mutateScope(
    scope: LoadableSettingScope | SettingsScope,
    mutation: (editor: SettingsMutationEditor) => void,
  ): boolean {
    const settingsFile = this.mutableFileForScope(scope);

    if (!this.isPersistable(settingsFile)) {
      const runtimeRoot = structuredClone(settingsFile.settings) as Record<
        string,
        unknown
      >;
      const { editor, touchedPaths } = this.createMutationEditor(runtimeRoot);
      try {
        mutation(editor);
      } catch (error) {
        this.host.onWriteError?.('update', error);
        return false;
      }
      const runtimeChanged = this.applyTouchedRuntimePaths(
        settingsFile,
        runtimeRoot as Settings,
        touchedPaths,
      );
      if (!settingsFile.readOnly && !settingsFile.path) {
        settingsFile.originalSettings = structuredClone(
          runtimeRoot,
        ) as Settings;
      }
      this._merged = this.computeMergedSettings();
      this._snapshot = this.computeSnapshot();
      if (runtimeChanged) this.notifyChanged();
      return true;
    }

    try {
      let touchedPaths: SettingsPath[] = [];
      const result = mutateSettingsFile(
        settingsFile.path,
        (latest) => {
          const editorState = this.createMutationEditor(
            latest as Record<string, unknown>,
          );
          mutation(editorState.editor);
          touchedPaths = editorState.touchedPaths;
          return editorState.changed();
        },
        {
          ...(scope === SettingScope.User || scope === 'user'
            ? { newFileMode: 0o600 }
            : {}),
          onInfrastructureError: this.host.onInfrastructureError,
        },
      );

      const finalOriginal = result.originalSettings as Record<string, unknown>;
      this.host.normalizeOriginal(finalOriginal);
      settingsFile.originalSettings = finalOriginal as Settings;
      settingsFile.rawJson = result.rawJson;
      if (scope === SettingScope.User || scope === 'user')
        this._userSettingsLoadRejected = false;

      const runtimeChanged = this.applyTouchedRuntimePaths(
        settingsFile,
        this.runtimeSettingsFromOriginal(finalOriginal as Settings),
        touchedPaths,
      );
      if (result.changed) {
        if (result.writeId) {
          // IDs are unique, so retaining only a bounded recent set cannot make
          // a later external edit look internal.
          if (this.ownWriteIds.size >= 128) {
            const oldest = this.ownWriteIds.values().next().value;
            if (oldest) this.ownWriteIds.delete(oldest);
          }
          this.ownWriteIds.add(result.writeId);
        }
        this.host.onPersisted?.();
      }
      this._merged = this.computeMergedSettings();
      this._snapshot = this.computeSnapshot();
      if (runtimeChanged) this.notifyChanged();
      return true;
    } catch (error) {
      this.host.onWriteError?.('save', error);
      return false;
    }
  }

  setValue(
    scope: LoadableSettingScope | SettingsScope,
    path: SettingsPath,
    value: unknown,
  ): boolean {
    const isMcpServers =
      path === 'mcpServers' ||
      (Array.isArray(path) && path.length === 1 && path[0] === 'mcpServers');
    // Reject malformed maps before cloning or opening a write transaction.
    // Undefined retains the existing delete semantics.
    if (isMcpServers && value !== undefined) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
      }
      if (
        Object.values(value).some(
          (config) =>
            !config || typeof config !== 'object' || Array.isArray(config),
        )
      ) {
        return false;
      }
    }
    let valueToSet =
      typeof value === 'object' && value !== null
        ? structuredClone(value)
        : value;
    if (isMcpServers && valueToSet && typeof valueToSet === 'object') {
      valueToSet = Object.fromEntries(
        Object.entries(valueToSet).map(([name, config]) => {
          if (config.scope === undefined) return [name, config];
          const { scope: _scope, ...rest } = config;
          return [name, rest];
        }),
      );
    }

    return valueToSet === undefined
      ? this.deleteValue(scope, path)
      : this.mutateScope(scope, (editor) => {
          editor.set(path, valueToSet);
        });
  }

  deleteValue(
    scope: LoadableSettingScope | SettingsScope,
    path: SettingsPath,
  ): boolean {
    return this.mutateScope(scope, (editor) => {
      editor.delete(path);
    });
  }

  updateValue(
    scope: LoadableSettingScope | SettingsScope,
    path: SettingsPath,
    updater: (current: unknown) => unknown,
  ): boolean {
    return this.mutateScope(scope, (editor) => {
      editor.update(path, updater);
    });
  }

  /** Keep this session's projection current using the SettingsService watcher. */
  async watchChanges(callbacks: {
    acceptChange: (
      source: 'user_settings' | 'project_settings' | 'local_settings',
      filePath: string,
    ) => Promise<boolean | { accepted: boolean; refreshSource: boolean }>;
    onChange: (source: SessionSettingsScope) => void;
  }): Promise<() => void> {
    if (!this.settingsService || this.settingsRulesOnly) return () => undefined;
    const files = [
      {
        file: this.user,
        source: 'userSettings' as const,
        hook: 'user_settings' as const,
        raw: this.fileSources?.user,
      },
      {
        file: this._projectFile,
        source: 'projectSettings' as const,
        hook: 'project_settings' as const,
        raw: this.fileSources?.project,
      },
      {
        file: this.local,
        source: 'localSettings' as const,
        hook: 'local_settings' as const,
        raw: this.fileSources?.local,
      },
    ].filter(({ file }) => !file.readOnly && file.path);
    const byPath = new Map(
      files.map((entry) => [path.resolve(entry.file.path), entry]),
    );
    let active = true;
    const stop = await this.settingsService.watchFiles(
      [...byPath.keys()],
      (event) => {
        const eventPath = path.resolve(event.path);
        const entry = byPath.get(eventPath);
        if (!active || !entry) return;
        if (event.writeId && this.ownWriteIds.delete(event.writeId)) return;
        this.changeQueue = this.changeQueue
          .then(async () => {
            if (!active) return;
            let decision:
              | boolean
              | { accepted: boolean; refreshSource: boolean } = true;
            try {
              decision = await callbacks.acceptChange(entry.hook, eventPath);
            } catch (error) {
              this.host.onError?.(
                `[Settings] ConfigChange hook failed: ${getErrorMessage(error)}`,
              );
            }
            const accepted =
              typeof decision === 'boolean' ? decision : decision.accepted;
            if (!active || !accepted) return;
            if (typeof decision !== 'boolean' && decision.refreshSource) {
              entry.raw?.invalidate();
            }
            this.reloadFiles([{ file: entry.file, source: entry.raw }]);
            this.notifyChanged();
            callbacks.onChange(entry.source);
          })
          .catch((error) => {
            this.host.onError?.(
              `[Settings] Failed to apply settings change: ${getErrorMessage(error)}`,
            );
          });
      },
    );
    if (this.settingsService.takeWatchUnavailableWarning()) {
      this.host.onWarning?.(
        '[Settings] File watcher unavailable; external settings changes will not reload automatically.',
      );
    }
    return () => {
      active = false;
      stop();
    };
  }

  private reloadFiles(
    files: ReadonlyArray<{
      file: LoadedSettingsFile;
      source?: SettingsFileSource;
    }>,
    rejectInvalid = false,
  ): void {
    // Prepare every layer before publishing any of them. Strict consumers
    // must not lose a working snapshot when one file cannot be read.
    const candidates = files
      .filter(({ file }) => !file.readOnly && file.path)
      .map(({ file, source }) => {
        const errors: SettingsError[] = [];
        const result = this.host.readFile(file.path, errors, source);
        for (const error of errors) {
          this.host.onWarning?.(
            `[Settings] Reload issue in ${error.path}: ${error.message}`,
          );
        }
        if (rejectInvalid && result.loadRejected) {
          throw new Error(`Failed to reload settings from ${file.path}`);
        }
        const settings = this.host.resolveEnvironment(result.settings);
        if (file === this.user || file === this._projectFile) {
          this.host.normalizeDisplaySettings(settings);
        }
        return {
          file,
          settings,
          originalSettings: structuredClone(result.originalSettings),
          rawJson: result.rawJson,
          loadRejected: result.loadRejected,
          errors,
        };
      });
    for (const {
      file,
      settings,
      originalSettings,
      rawJson,
      loadRejected,
      errors,
    } of candidates) {
      file.settings = settings;
      file.originalSettings = originalSettings;
      file.rawJson = rawJson;
      file.loadRejected = loadRejected;
      const retained = this.errors.filter((error) => error.path !== file.path);
      this.errors.splice(0, this.errors.length, ...retained, ...errors);
    }
    this.project =
      this.isTrusted || this.host.hideUntrustedProject === false
        ? this._projectFile
        : this.createEmptyProject(this._projectFile);
    this._merged = this.computeMergedSettings();
    this._snapshot = this.computeSnapshot();
  }

  /**
   * Re-read the persistable disk scopes (user/project/local) from disk and
   * refresh the in-memory view, then recompute merged settings.
   * Explicit reload does not run ConfigChange hooks; watcher changes retain
   * their separate approval flow.
   *
   * This is the "manual reload = disk changed, re-read it" path: it lets an
   * already-running session observe settings written by a *separate* process
   * (e.g. a standalone `qwen plugins install` that appends to
   * `enabledPlugins`) without restarting.
   *
   * Deliberately narrow in scope:
   * - Only the three persistable scopes are re-read. The `flag` scope
   *   (`--settings` / headless `apply_flag_settings`) is readOnly and lives
   *   only in memory, so it is preserved untouched.
   * - Trust state, readOnly flags, and file paths are preserved. Untrusted
   *   workspaces keep their empty-project projection.
   * - One-time / startup side effects (`migrateDeprecatedSettings`,
   *   `loadEnvironment`) are intentionally skipped — this is a focused refresh,
   *   not a full reload.
   *
   * Persistable scopes are safe to fully re-read because `setValue` persists to
   * disk on every write, so disk is the source of truth (no unsaved in-memory
   * state to lose).
   * `rejectInvalid` rejects a failed disk layer before adopting any layer;
   * ordinary reloads retain the existing warning-and-recovery behavior.
   */
  reload(options: { rejectInvalid?: boolean } = {}): void {
    // A manual reload can refresh one session while other callers still hold
    // ordinary loadSettings() entries for the same user file under another
    // project key. Clear the process cache so those callers cannot keep the
    // stale user snapshot until its TTL expires.
    this.host.onReload?.();
    this.reloadFiles(
      [
        { file: this.user, source: this.fileSources?.user },
        { file: this._projectFile, source: this.fileSources?.project },
        { file: this.local, source: this.fileSources?.local },
      ],
      options.rejectInvalid,
    );
    this.notifyChanged();
  }
}
