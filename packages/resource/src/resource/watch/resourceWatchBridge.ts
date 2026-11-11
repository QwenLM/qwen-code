/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { relative, sep } from 'node:path';
import type {
  ResourceChangeEvent,
  ResourceKind,
  ResourceSource,
} from '../core/types.js';
import {
  createFileWatcher,
  type FileWatcher,
} from '../../file-watcher/fileWatcher.js';

export interface WatchTarget {
  kind: ResourceKind;
  source?: ResourceSource;
  path: string;
  recursive?: boolean;
  depth?: number;
  preferNativeRecursive?: boolean;
  logicalRoot?: string;
  signal?: boolean;
  ignoredDirectoryNames?: readonly string[];
}

/**
 * Refresh policy for a set of resource kinds: file events are queued and
 * coalesced for `debounceMs` before refreshing the corresponding snapshot.
 */
export interface KindRefreshPolicy {
  /** Resource kinds this policy applies to. */
  kinds: ResourceKind[];
  /** Debounce window to coalesce bursts (e.g. git checkout) before refreshing. Default 0. */
  debounceMs?: number;
  /** Refresh the snapshot covering the batched events. */
  refresh(events: ResourceChangeEvent[]): void | Promise<void>;
}

export interface ResourceWatchBridgeOptions {
  targets: WatchTarget[];
  internalWriteWindowMs?: number;
  debounceMs?: number;
  /** Inject a custom file watcher (e.g. shared service or noop in tests). */
  fileWatcher?: FileWatcher;
  /** Per-kind refresh policies; kinds without a policy are ignored. */
  refreshPolicies?: KindRefreshPolicy[];
}

export function matchWatchTarget(
  filePath: string,
  targets: readonly WatchTarget[],
): WatchTarget | undefined {
  return targets.find((target) => {
    if (filePath === target.path) return true;
    const childPath = relative(target.path, filePath);
    return Boolean(
      childPath && !childPath.startsWith('..') && childPath !== sep,
    );
  });
}

interface PolicyState {
  policy: KindRefreshPolicy;
  queue: ResourceChangeEvent[];
  waiters: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Resource-layer change watcher: a subscriber of the generic file watcher
 * that translates raw path events into resource-semantic refresh batches.
 */
export class ResourceWatchBridge {
  private options: ResourceWatchBridgeOptions;
  private readonly fileWatcher: FileWatcher;
  private readonly unsubs = new Map<string, () => void>();
  private readonly policies = new Map<string, PolicyState>();
  private started = false;

  constructor(options: ResourceWatchBridgeOptions) {
    this.options = options;
    this.fileWatcher =
      options.fileWatcher ??
      createFileWatcher({
        debounceMs: options.debounceMs,
        internalWriteWindowMs: options.internalWriteWindowMs,
      });
    for (const policy of options.refreshPolicies ?? []) {
      const state: PolicyState = {
        policy,
        queue: [],
        waiters: [],
        timer: null,
      };
      for (const kind of policy.kinds) {
        this.policies.set(kind, state);
      }
    }
  }

  getTargets(): WatchTarget[] {
    return [...this.options.targets];
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const target of this.options.targets) {
      this.registerTarget(target);
    }
    await this.fileWatcher.start();
  }

  async setTargets(targets: WatchTarget[]): Promise<void> {
    const previousPaths = new Set(
      this.options.targets.map((target) => target.path),
    );
    const nextPaths = new Set(targets.map((target) => target.path));
    this.options = { ...this.options, targets };

    if (!this.started) return;

    for (const path of previousPaths) {
      if (!nextPaths.has(path)) {
        this.unsubs.get(path)?.();
        this.unsubs.delete(path);
      }
    }
    for (const target of targets) {
      if (!previousPaths.has(target.path)) {
        this.registerTarget(target);
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const unsub of this.unsubs.values()) unsub();
    this.unsubs.clear();
    for (const state of new Set(this.policies.values())) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.queue.length = 0;
      for (const resolve of state.waiters.splice(0)) resolve();
    }
    await this.fileWatcher.stop();
  }

  private registerTarget(target: WatchTarget): void {
    if (this.unsubs.has(target.path)) return;
    const unsub = this.fileWatcher.watch(
      {
        path: target.path,
        recursive: target.recursive,
        depth: target.depth,
        preferNativeRecursive: target.preferNativeRecursive,
        logicalRoot: target.logicalRoot,
        signal: target.signal,
        ignoredDirectoryNames: target.ignoredDirectoryNames,
      },
      (event) => {
        const change: ResourceChangeEvent = {
          kind: target.kind,
          source: target.source,
          path: event.path,
          operation: event.operation,
        };
        return this.scheduleRefresh(change);
      },
    );
    this.unsubs.set(target.path, unsub);
  }

  private scheduleRefresh(change: ResourceChangeEvent): Promise<void> {
    const state = this.policies.get(change.kind);
    if (!state) return Promise.resolve();

    state.queue.push(change);
    if (state.timer) clearTimeout(state.timer);
    return new Promise<void>((resolve) => {
      state.waiters.push(resolve);
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.flush(state).catch(() => undefined);
      }, state.policy.debounceMs ?? 0);
    });
  }

  private async flush(state: PolicyState): Promise<void> {
    const batch = state.queue.splice(0);
    const waiters = state.waiters.splice(0);
    if (batch.length === 0) {
      for (const resolve of waiters) resolve();
      return;
    }
    try {
      await state.policy.refresh(batch);
    } catch {
      // Keep the last complete snapshot. A later file event or explicit reload
      // can retry the refresh.
    } finally {
      for (const resolve of waiters) resolve();
    }
  }
}
