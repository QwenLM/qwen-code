/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch as watchFs, type FSWatcher } from 'chokidar';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { type LoadedSettings, SettingScope } from './settings.js';
import { getFlattenedSchema } from '../utils/settingsUtils.js';

const debugLogger = createDebugLogger('SETTINGS_WATCHER');

/**
 * Collects the dot-path of every leaf whose value differs between two settings
 * snapshots. Plain objects are recursed into; arrays and primitives are compared
 * whole (via `JSON.stringify`), matching the granularity of schema array keys
 * such as `permissions.allow`. Added/removed keys surface as changed leaves too,
 * so this also covers file creation/deletion.
 */
function collectChangedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = '',
): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const beforeValue = before[key];
    const afterValue = after[key];
    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
      changed.push(...collectChangedKeys(beforeValue, afterValue, keyPath));
    } else if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changed.push(keyPath);
    }
  }
  return changed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves whether a changed dot-path maps to a restart-required setting, using
 * the longest schema key that is a prefix of (or equal to) the path. Free-form
 * object settings (e.g. `env`, `modelProviders`) are leaf schema keys, so a
 * change to `env.FOO` resolves to the `env` definition. Unknown keys default to
 * NOT restart-required, so a change we cannot classify is never silently
 * suppressed.
 */
function isRestartRequiredKey(changedPath: string): boolean {
  const flattened = getFlattenedSchema();
  const parts = changedPath.split('.');
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('.');
    const definition = flattened[candidate];
    if (definition) return definition.requiresRestart === true;
  }
  return false;
}

export interface SettingsChangeEvent {
  scope: SettingScope;
  path: string;
  changeType: 'modified' | 'created' | 'deleted';
}

export type SettingsChangeListener = (
  events: SettingsChangeEvent[],
) => void | Promise<void>;

/**
 * Watches user and workspace settings.json files for changes and emits
 * change events when the resolved settings content differs from the
 * in-memory state.
 *
 * Uses chokidar to monitor the `.qwen` directory (depth: 0) with strict
 * basename filtering. Self-writes from `LoadedSettings.setValue()` are
 * naturally suppressed via a before/after semantic diff — `setValue()`
 * mutates memory before writing disk, so `reloadScopeFromDisk()` produces
 * no diff.
 *
 * Restart-required settings are filtered out before notifying: if every
 * changed key is `requiresRestart` in the schema (credentials, `env`,
 * providers, MCP servers, …), no event is emitted, since such values are read
 * once at startup and cannot take effect without a restart.
 *
 * The watcher never creates `.qwen` itself. When the directory is missing at
 * startup it bootstrap-watches the parent (depth: 0, `.qwen`-only filter) and
 * promotes to watching `.qwen` once it appears — so a `settings.json` added
 * later in the session is still detected without recursing the project tree.
 */
export class SettingsWatcher {
  private readonly settings: LoadedSettings;
  private readonly watchers: Map<SettingScope, FSWatcher> = new Map();
  /**
   * Per-scope watch stage. `bootstrap` watches the parent directory waiting
   * for the missing `.qwen` dir to appear; `target` watches `.qwen` itself.
   */
  private readonly watchStage: Map<SettingScope, 'bootstrap' | 'target'> =
    new Map();
  /**
   * Per-scope generation token. Bumped on every promote/demote so that a
   * stale `'all'` callback from a watcher being torn down (chokidar `close()`
   * is async) becomes a no-op instead of stacking watchers.
   */
  private readonly watchGeneration: Map<SettingScope, number> = new Map();
  private readonly changeListeners: Set<SettingsChangeListener> = new Set();
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly pendingScopeChanges: Set<SettingScope> = new Set();
  private processing: boolean = false;
  private started: boolean = false;

  static readonly DEBOUNCE_MS = 300;
  static readonly LISTENER_TIMEOUT_MS = 30_000;

  constructor(settings: LoadedSettings) {
    this.settings = settings;
  }

  startWatching(): void {
    if (this.started) return;
    this.started = true;

    for (const { scope, settingsPath } of this.getScopePaths()) {
      if (!settingsPath) continue;
      const dir = path.dirname(settingsPath);

      // Watch `.qwen` directly when it already exists; otherwise bootstrap on
      // the parent and promote once `.qwen` appears. We never create the
      // directory ourselves — settings persistence (`saveSettings`) does that
      // when the user actually writes settings.
      if (fs.existsSync(dir)) {
        this.watchTargetDir(scope, settingsPath);
      } else {
        this.watchParentForDir(scope, settingsPath);
      }
    }
  }

  /**
   * Watches the resolved `.qwen` directory for changes to `settings.json`.
   * If `.qwen` itself is removed, demotes back to a parent bootstrap watcher
   * so a later re-creation is still caught.
   */
  private watchTargetDir(scope: SettingScope, settingsPath: string): void {
    const dir = path.dirname(settingsPath);
    const targetBasename = path.basename(settingsPath);
    const gen = this.bumpGeneration(scope);

    try {
      const watcher = watchFs(dir, {
        ignoreInitial: true,
        depth: 0,
        ignored: (filePath: string, stats?: fs.Stats) => {
          if (stats && !stats.isFile() && !stats.isDirectory()) return true;
          return false;
        },
      })
        .on('all', (event: string, changedPath: string) => {
          if (this.watchGeneration.get(scope) !== gen) return;
          // The `.qwen` directory itself was removed — demote so we can catch
          // a later re-create instead of holding a stale watcher.
          if (event === 'unlinkDir' && changedPath === dir) {
            void this.demoteScope(scope, settingsPath);
            return;
          }
          if (path.basename(changedPath) !== targetBasename) return;
          this.scheduleRefresh(scope);
        })
        .on('error', (error: unknown) => {
          debugLogger.warn(`Settings watcher error for ${dir}:`, error);
        });

      this.watchers.set(scope, watcher);
      this.watchStage.set(scope, 'target');
    } catch (error) {
      debugLogger.warn(
        `Failed to start settings watcher for ${scope} (${dir}):`,
        error,
      );
    }
  }

  /**
   * Bootstrap watcher: monitors the parent directory (depth 0) with a strict
   * predicate that only allows the `.qwen` entry through, so unrelated
   * top-level churn is suppressed and the project tree is never recursed.
   * Promotes to a target watcher once `.qwen` appears.
   */
  private watchParentForDir(scope: SettingScope, settingsPath: string): void {
    const dir = path.dirname(settingsPath);
    const parentDir = path.dirname(dir);
    const dirBasename = path.basename(dir);
    const gen = this.bumpGeneration(scope);

    try {
      const watcher = watchFs(parentDir, {
        ignoreInitial: true,
        depth: 0,
        ignored: (filePath: string) =>
          filePath !== parentDir && path.basename(filePath) !== dirBasename,
      })
        .on('all', (_event: string, changedPath: string) => {
          if (this.watchGeneration.get(scope) !== gen) return;
          if (path.basename(changedPath) !== dirBasename) return;
          void this.promoteScope(scope, settingsPath);
        })
        .on('error', (error: unknown) => {
          debugLogger.warn(
            `Settings bootstrap watcher error for ${parentDir}:`,
            error,
          );
        });

      this.watchers.set(scope, watcher);
      this.watchStage.set(scope, 'bootstrap');
    } catch (error) {
      debugLogger.warn(
        `Failed to start settings bootstrap watcher for ${scope} (${parentDir}):`,
        error,
      );
      return;
    }

    // Close the TOCTOU gap: `.qwen` may have been created between the
    // existence check and the watcher arming (bootstrap uses ignoreInitial).
    if (fs.existsSync(dir)) {
      void this.promoteScope(scope, settingsPath);
    }
  }

  /** Swaps a scope's bootstrap watcher for a target watcher on `.qwen`. */
  private async promoteScope(
    scope: SettingScope,
    settingsPath: string,
  ): Promise<void> {
    if (this.watchStage.get(scope) !== 'bootstrap') return;
    await this.replaceWatcher(scope);
    if (!this.started) return;
    this.watchTargetDir(scope, settingsPath);
    // Pick up a settings.json that already exists inside the new `.qwen`.
    this.scheduleRefresh(scope);
  }

  /** Swaps a scope's target watcher back to a parent bootstrap watcher. */
  private async demoteScope(
    scope: SettingScope,
    settingsPath: string,
  ): Promise<void> {
    if (this.watchStage.get(scope) !== 'target') return;
    await this.replaceWatcher(scope);
    if (!this.started) return;
    this.watchParentForDir(scope, settingsPath);
    // Surface the deletion (rawJson goes undefined) to listeners.
    this.scheduleRefresh(scope);
  }

  /**
   * Bumps the scope generation and closes its current watcher, clearing the
   * map entries before the caller opens the next watcher. Bumping first makes
   * any in-flight callback from the closing watcher a no-op.
   */
  private async replaceWatcher(scope: SettingScope): Promise<void> {
    this.bumpGeneration(scope);
    const watcher = this.watchers.get(scope);
    this.watchers.delete(scope);
    this.watchStage.delete(scope);
    if (watcher) {
      try {
        await watcher.close();
      } catch (err) {
        debugLogger.warn('Settings watcher close error:', err);
      }
    }
  }

  private bumpGeneration(scope: SettingScope): number {
    const next = (this.watchGeneration.get(scope) ?? 0) + 1;
    this.watchGeneration.set(scope, next);
    return next;
  }

  stopWatching(): void {
    if (!this.started) return;
    this.started = false;
    for (const [, watcher] of this.watchers) {
      watcher.close().catch((err) => {
        debugLogger.warn('Settings watcher close error:', err);
      });
    }
    this.watchers.clear();
    this.watchStage.clear();
    // Bump every scope so any in-flight promote/demote becomes a no-op.
    for (const scope of this.watchGeneration.keys()) {
      this.bumpGeneration(scope);
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pendingScopeChanges.clear();
  }

  addChangeListener(listener: SettingsChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private getScopePaths(): Array<{
    scope: SettingScope;
    settingsPath: string;
  }> {
    const paths: Array<{
      scope: SettingScope;
      settingsPath: string;
    }> = [
      {
        scope: SettingScope.User,
        settingsPath: this.settings.user.path,
      },
    ];

    if (this.settings.workspaceSettingsActive) {
      paths.push({
        scope: SettingScope.Workspace,
        settingsPath: this.settings.workspace.path,
      });
    }

    return paths;
  }

  private scheduleRefresh(scope: SettingScope): void {
    this.pendingScopeChanges.add(scope);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.drainPendingChanges().catch((err) => {
        debugLogger.warn('Settings watcher refresh error:', err);
      });
    }, SettingsWatcher.DEBOUNCE_MS);
  }

  private async drainPendingChanges(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pendingScopeChanges.size > 0) {
        const scopes = new Set(this.pendingScopeChanges);
        this.pendingScopeChanges.clear();
        await this.handleChange(scopes);
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleChange(changedScopes: Set<SettingScope>): Promise<void> {
    const events: SettingsChangeEvent[] = [];

    for (const scope of changedScopes) {
      const file = this.settings.forScope(scope);

      // Snapshot the in-memory state before reload (already includes any
      // setValue() self-write, so self-writes diff to nothing below).
      const before = structuredClone(file.settings ?? {}) as Record<
        string,
        unknown
      >;
      const existedBefore = file.rawJson !== undefined;

      this.settings.reloadScopeFromDisk(scope);

      const after = (file.settings ?? {}) as Record<string, unknown>;
      const existsNow = file.rawJson !== undefined;

      // Which leaf keys actually changed. Empty => self-write, no-op, or a
      // parse failure that preserved the old state — nothing to notify.
      const changedKeys = collectChangedKeys(before, after);
      if (changedKeys.length === 0) {
        continue;
      }

      // Suppress hot-reload when every changed key is restart-required (e.g.
      // credentials, `env`, providers, MCP servers). These are read once at
      // startup, so emitting an event would mislead listeners into "refreshing"
      // a value that cannot actually take effect without a restart. We reuse the
      // schema's `requiresRestart` flag as the single source of truth — notify
      // only when at least one changed key is genuinely hot-reloadable.
      const hasHotReloadableChange = changedKeys.some(
        (key) => !isRestartRequiredKey(key),
      );
      if (!hasHotReloadableChange) {
        continue;
      }

      events.push({
        scope,
        path: file.path,
        changeType:
          !existedBefore && existsNow
            ? 'created'
            : existedBefore && !existsNow
              ? 'deleted'
              : 'modified',
      });
    }

    if (events.length > 0) {
      await this.notifyListeners(events);
    }
  }

  private async notifyListeners(events: SettingsChangeEvent[]): Promise<void> {
    const TIMEOUT_MS = SettingsWatcher.LISTENER_TIMEOUT_MS;
    const withTimeout = (p: Promise<unknown>): Promise<unknown> => {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(
          () =>
            reject(
              new Error(
                `settings change listener timeout after ${TIMEOUT_MS}ms`,
              ),
            ),
          TIMEOUT_MS,
        );
        if (
          typeof timerId === 'object' &&
          timerId !== null &&
          'unref' in timerId
        ) {
          (timerId as { unref: () => void }).unref();
        }
      });
      return Promise.race([p, timeoutPromise]).finally(() => {
        if (timerId !== undefined) clearTimeout(timerId);
      });
    };

    const results = await Promise.allSettled(
      Array.from(this.changeListeners).map((listener) =>
        withTimeout(Promise.resolve().then(() => listener(events))),
      ),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        debugLogger.warn('Settings change listener error:', result.reason);
      }
    }
  }
}
