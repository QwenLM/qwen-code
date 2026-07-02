/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch as watchFs, type FSWatcher } from 'chokidar';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('LSP_CONFIG_WATCHER');

export type LspConfigChangeEvent =
  | LspConfigRuntimeChangeEvent
  | LspConfigInvalidEvent;

export interface LspConfigRuntimeChangeEvent {
  path: string;
  changeType: 'modified' | 'created' | 'deleted';
}

export interface LspConfigInvalidEvent {
  path: string;
  changeType: 'invalid';
  /** User-facing message; invalid configs preserve the current LSP runtime. */
  error: string;
}

export type LspConfigChangeListener = (
  event: LspConfigChangeEvent,
) => void | Promise<void>;

interface LspConfigSnapshot {
  exists: boolean;
  /** Canonical JSON string. Undefined means the file exists but is invalid or unreadable. */
  canonical?: string;
  error?: string;
}

/**
 * Watches the workspace `.lsp.json` and reports semantic config changes.
 *
 * This watcher is intentionally narrow: it never creates files, only considers
 * the workspace-root `.lsp.json`, debounces noisy filesystem events, and
 * serializes listener calls so LSP reloads cannot overlap.
 */
export class LspConfigWatcher {
  private watcher?: FSWatcher;
  private listener?: LspConfigChangeListener;
  private refreshTimer: NodeJS.Timeout | null = null;
  private activeDrain?: Promise<void>;
  private processing = false;
  private pending = false;
  private started = false;
  private lastSnapshot: LspConfigSnapshot;
  private readonly configPath: string;

  static readonly DEBOUNCE_MS = 300;
  static readonly LISTENER_TIMEOUT_MS = 30_000;

  constructor(private readonly workspaceRoot: string) {
    this.configPath = path.join(workspaceRoot, '.lsp.json');
    this.lastSnapshot = this.readSnapshot();
  }

  startWatching(listener: LspConfigChangeListener): void {
    if (this.started) return;
    debugLogger.info(`Starting LSP config watcher for ${this.configPath}`);
    try {
      const watcher = watchFs(this.workspaceRoot, {
        ignoreInitial: true,
        depth: 0,
      })
        .on('all', (_event: string, changedPath: string) => {
          if (path.basename(changedPath) !== '.lsp.json') return;
          this.scheduleRefresh();
        })
        .on('error', (error: unknown) => {
          debugLogger.warn(
            `LSP config watcher error for ${this.workspaceRoot}:`,
            error,
          );
        });
      this.watcher = watcher;
      this.listener = listener;
      this.started = true;
    } catch (error) {
      this.watcher = undefined;
      this.listener = undefined;
      this.started = false;
      debugLogger.warn(
        `Failed to start LSP config watcher for ${this.workspaceRoot}:`,
        error,
      );
    }
  }

  async stopWatching(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    debugLogger.info(`Stopping LSP config watcher for ${this.configPath}`);
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pending = false;

    await this.activeDrain;
    this.listener = undefined;

    try {
      await this.watcher?.close();
    } catch (error) {
      debugLogger.warn('LSP config watcher close error:', error);
    }
    this.watcher = undefined;
  }

  private scheduleRefresh(): void {
    if (!this.started) return;
    this.pending = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const activeDrain = this.drainPendingChange().catch((error) => {
        debugLogger.warn('LSP config watcher refresh error:', error);
      });
      this.activeDrain = activeDrain;
      void activeDrain.finally(() => {
        if (this.activeDrain === activeDrain) {
          this.activeDrain = undefined;
        }
      });
    }, LspConfigWatcher.DEBOUNCE_MS);
    if (
      typeof this.refreshTimer === 'object' &&
      this.refreshTimer !== null &&
      'unref' in this.refreshTimer
    ) {
      this.refreshTimer.unref();
    }
  }

  /** Drains debounced changes one at a time while preserving a trailing update. */
  private async drainPendingChange(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pending) {
        this.pending = false;
        await this.handleChange();
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Compares the previous and current semantic snapshots.
   *
   * Invalid JSON emits an `invalid` event for user feedback but does not report
   * a runtime config change; the caller must keep the existing LSP state.
   */
  private async handleChange(): Promise<void> {
    const before = this.lastSnapshot;
    const after = this.readSnapshot();
    if (after.exists && after.canonical === undefined) {
      debugLogger.warn(
        `Invalid .lsp.json; keeping existing LSP runtime state.`,
      );
      const notified = await this.notifyListener({
        path: this.configPath,
        changeType: 'invalid',
        error:
          after.error ??
          'Invalid JSON in .lsp.json; existing LSP runtime state is unchanged.',
      });
      if (notified) {
        this.lastSnapshot = after;
      }
      return;
    }

    const changed =
      before.exists !== after.exists || before.canonical !== after.canonical;
    if (!changed) {
      this.lastSnapshot = after;
      return;
    }

    const event: LspConfigChangeEvent = {
      path: this.configPath,
      changeType:
        !before.exists && after.exists
          ? 'created'
          : before.exists && !after.exists
            ? 'deleted'
            : 'modified',
    };
    debugLogger.info(`LSP config changed: ${event.changeType} ${event.path}`);
    const notified = await this.notifyListener(event);
    if (notified) {
      this.lastSnapshot = after;
    }
  }

  /**
   * Reads `.lsp.json` as a single operation. ENOENT is treated as deletion so a
   * file removed during a filesystem race still reconciles servers to empty.
   */
  private readSnapshot(): LspConfigSnapshot {
    let raw: string;
    try {
      raw = fs.readFileSync(this.configPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false };
      }
      debugLogger.warn('Failed to read .lsp.json:', error);
      return {
        exists: true,
        error:
          'Failed to read .lsp.json; existing LSP runtime state is unchanged.',
      };
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return { exists: true, canonical: canonicalize(parsed) };
    } catch (error) {
      debugLogger.warn('Failed to parse .lsp.json:', error);
      return {
        exists: true,
        error:
          'Invalid JSON in .lsp.json; existing LSP runtime state is unchanged.',
      };
    }
  }

  /**
   * Runs the listener with timeout isolation so a hung reload cannot stall CLI.
   *
   * Returns whether the listener completed successfully; callers use this to
   * decide whether the semantic snapshot can advance or should be retried.
   */
  private async notifyListener(event: LspConfigChangeEvent): Promise<boolean> {
    if (!this.listener) return true;
    const TIMEOUT_MS = LspConfigWatcher.LISTENER_TIMEOUT_MS;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () =>
          reject(
            new Error(
              `LSP config change listener timeout after ${TIMEOUT_MS}ms`,
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
    const listenerPromise = Promise.resolve().then(() =>
      this.listener?.(event),
    );
    try {
      await Promise.race([listenerPromise, timeoutPromise]);
      return true;
    } catch (error) {
      debugLogger.warn('LSP config change listener error:', error);
      return false;
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
      void listenerPromise.catch(() => undefined);
    }
  }
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
