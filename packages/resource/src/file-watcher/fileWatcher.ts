/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  anchorKey,
  isUnder,
  registrationAnchors as planRegistrationAnchors,
  resolveWatchTarget,
  signalRegistrationAnchors as planSignalRegistrationAnchors,
  type RegistrationAnchor,
  type ResolvedWatchTarget,
} from './anchorPlanner.js';
import { ChokidarBackendPool } from './chokidarBackend.js';
import { shouldUseNativeSignals } from './watchBackendPolicy.js';
import { canonicalPath, consumeInternalWrite } from './internalWrites.js';
import {
  NativeSignalBackend,
  type NativeSignalAnchor,
} from './nativeSignalBackend.js';
import type {
  FileChangeListener,
  FileChangeOperation,
  FileWatcher,
  FileWatcherOptions,
  WatchRequest,
} from './types.js';

export type {
  FileChangeEvent,
  FileChangeListener,
  FileChangeOperation,
  FileWatcher,
  FileWatcherOptions,
  WatchRequest,
} from './types.js';

interface Registration extends ResolvedWatchTarget {
  id: number;
  request: WatchRequest;
  listener: FileChangeListener;
  /** Native signal watching failed; use the chokidar anchor model instead. */
  nativeSignalDisabled: boolean;
  timers: Map<string, ReturnType<typeof setTimeout>>;
}

type ChokidarEventSource = 'default' | 'fallback-polling';

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_INTERNAL_WRITE_WINDOW_MS = 5000;

/** Match only descendants, so a target inside an excluded directory still works. */
function isIgnoredDescendant(
  path: string,
  root: string,
  names: readonly string[] | undefined,
  depth?: number,
): boolean {
  if (!names?.length && depth === undefined) return false;
  const child = relative(root, path);
  if (
    !child ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    return false;
  }
  const segments = child.split(sep);
  return (
    (depth !== undefined && segments.length > depth + 1) ||
    segments.some((segment) => names?.includes(segment))
  );
}

/**
 * Coordinates native signals and Chokidar backends behind FileWatcher.
 * Owns registrations, backend fallback and debounced event delivery;
 * backend classes own OS/library watcher handles. No resource semantics.
 *
 * Anchor model (chosen so huge directories like ~ or a workspace root are
 * never scanned recursively):
 * - Existing file targets watch the file itself. On unlink they demote to a
 *   flat watch of their parent directory and wait for recreation.
 * - Existing directory targets watch themselves. On unlinkDir they demote to
 *   a flat watch of their parent and wait for recreation.
 * - Missing targets anchor at the nearest existing ancestor with a FLAT
 *   (depth 0) watch and wait for creation events.
 * - Canonical content anchors observe changes below symlink targets. Flat
 *   entry guards observe deletion/recreation of caller-visible symlink
 *   ancestors, bounded by `logicalRoot`.
 * - Special files (sockets, FIFOs, devices) and .git trees are ignored;
 *   watching them throws on some platforms and would break the scan.
 *
 * Chokidar backends are shared by depth, with a separate flat (depth 0)
 * backend for entry guards. Depth is per-instance, not per-path.
 * Native signal mode mirrors the same narrow anchors on supported platforms.
 */
export class FileSystemWatcher implements FileWatcher {
  readonly isNoop = false;

  private readonly options: FileWatcherOptions;
  private readonly debounceMs: number;
  private readonly internalWriteWindowMs: number;
  private readonly registrations = new Map<number, Registration>();
  private readonly defaultChokidarBackend: ChokidarBackendPool;
  private readonly fallbackPollingBackend: ChokidarBackendPool;
  private readonly nativeSignalBackend: NativeSignalBackend;
  private nextId = 1;
  private started = false;

  constructor(options: FileWatcherOptions = {}) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.internalWriteWindowMs =
      options.internalWriteWindowMs ?? DEFAULT_INTERNAL_WRITE_WINDOW_MS;
    this.defaultChokidarBackend = new ChokidarBackendPool(
      options,
      (operation, path) => this.handleChokidarEvent(operation, path),
      (path) => this.isIgnoredByChokidarRequests(path, 'default'),
    );
    this.fallbackPollingBackend = new ChokidarBackendPool(
      { ...options, usePolling: true },
      (operation, path) =>
        this.handleChokidarEvent(operation, path, 'fallback-polling'),
      (path) => this.isIgnoredByChokidarRequests(path, 'fallback-polling'),
    );
    this.nativeSignalBackend = new NativeSignalBackend(
      (signal, eventPath) => this.handleNativeEvent(signal, eventPath),
      (registrationIds, error) =>
        this.handleNativeError(registrationIds, error),
    );
  }

  watch(request: WatchRequest, listener: FileChangeListener): () => void {
    if (
      request.depth !== undefined &&
      (!Number.isInteger(request.depth) || request.depth < 0)
    ) {
      request = { ...request, depth: 2 };
    }
    const target = resolveWatchTarget(request.path, request.logicalRoot);
    const registration: Registration = {
      id: this.nextId++,
      request,
      ...target,
      listener,
      nativeSignalDisabled: false,
      timers: new Map(),
    };
    this.registrations.set(registration.id, registration);
    if (this.started) this.attachRegistration(registration);
    return () => this.unwatch(registration.id);
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.started = true;
    this.defaultChokidarBackend.start();
    this.fallbackPollingBackend.start();
    try {
      for (const registration of this.registrations.values()) {
        this.refreshWatchTarget(registration);
        this.attachRegistration(registration);
      }
      await Promise.all([
        this.defaultChokidarBackend.ready(),
        this.fallbackPollingBackend.ready(),
      ]);
    } catch (error) {
      // Release sibling backends too. Do not delay the startup error while
      // waiting for OS handles to close, or leave started=true after failure.
      void this.stop().catch((closeError) => this.options.onError?.(closeError));
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const registration of this.registrations.values()) {
      for (const timer of registration.timers.values()) clearTimeout(timer);
      registration.timers.clear();
    }
    this.started = false;
    this.nativeSignalBackend.stop();
    await Promise.all([
      this.defaultChokidarBackend.stop(),
      this.fallbackPollingBackend.stop(),
    ]);
  }

  private unwatch(id: number): void {
    const registration = this.registrations.get(id);
    if (!registration) return;
    for (const timer of registration.timers.values()) clearTimeout(timer);
    this.registrations.delete(id);
    if (this.usesNativeSignals(registration)) {
      this.detachNativeRegistration(registration);
    } else {
      this.detachChokidarRegistration(registration);
    }
  }

  /**
   * Picks the narrowest anchor that still observes the requested path:
   * existing paths watch themselves; missing paths anchor at the nearest
   * existing ancestor (flat) and wait for creation.
   */
  private refreshWatchTarget(registration: Registration): void {
    Object.assign(
      registration,
      resolveWatchTarget(
        registration.requested,
        registration.request.logicalRoot,
      ),
    );
  }

  private usesNativeSignals(registration: Registration): boolean {
    return shouldUseNativeSignals(
      registration.request,
      this.options,
      registration.nativeSignalDisabled,
    );
  }

  private attachRegistration(registration: Registration): void {
    if (this.usesNativeSignals(registration)) {
      this.attachNativeRegistration(registration);
    } else {
      this.attachChokidarRegistration(registration);
    }
  }

  private attachNativeRegistration(registration: Registration): void {
    // FSEvents does not follow descendant symlinks. Preserve Chokidar's
    // followSymlinks behavior with bounded polling for these targets.
    if (
      registration.request.preferNativeRecursive &&
      this.hasDescendantSymlink(registration)
    ) {
      this.fallbackToChokidar(registration);
      return;
    }
    for (const anchor of planSignalRegistrationAnchors(registration)) {
      if (!this.retainNativeAnchor(registration, anchor)) return;
    }
  }

  private hasDescendantSymlink(registration: Registration): boolean {
    const scan = (directory: string, level: number): boolean => {
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (this.isIgnoredForRegistration(registration, path)) continue;
          if (entry.isSymbolicLink()) return true;
          if (
            entry.isDirectory() &&
            (registration.request.depth === undefined ||
              level < registration.request.depth) &&
            scan(path, level + 1)
          ) {
            return true;
          }
        }
      } catch (error) {
        // A file target or a concurrent deletion needs no subtree traversal.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
      }
      return false;
    };
    return !registration.fallback && scan(registration.matched, 0);
  }

  private detachNativeRegistration(registration: Registration): void {
    this.nativeSignalBackend.release(
      registration.id,
      planSignalRegistrationAnchors(registration),
    );
  }

  private retainNativeAnchor(
    registration: Registration,
    anchor: RegistrationAnchor,
  ): boolean {
    const result = this.nativeSignalBackend.retain(registration.id, anchor);
    if (result.ok) return true;
    this.fallbackToChokidar(registration, result.error);
    return false;
  }

  private handleNativeError(
    registrationIds: readonly number[],
    error: unknown,
  ): void {
    const registrations = registrationIds
      .map((id) => this.registrations.get(id))
      .filter((item): item is Registration => item !== undefined);
    this.options.onError?.(error);
    for (const registration of registrations) {
      this.fallbackToChokidar(registration);
    }
  }

  private fallbackToChokidar(
    registration: Registration,
    error?: unknown,
  ): void {
    if (registration.nativeSignalDisabled) return;
    if (error !== undefined) this.options.onError?.(error);
    this.detachNativeRegistration(registration);
    registration.nativeSignalDisabled = true;
    this.attachChokidarRegistration(registration);
    // One conservative refresh closes the gap while switching backends. Do
    // not retry native watching: persistent OS failures must not cause a
    // periodic full resource reload loop.
    this.scheduleNotification(registration, 'change', registration.requested);
  }

  private handleNativeEvent(
    signal: NativeSignalAnchor,
    eventPath: string,
  ): void {
    if (!this.started) return;
    // Native recursion also reports excluded/deep descendants. Reject them
    // before internal-write lookup: canonicalPath() performs synchronous
    // filesystem I/O, which becomes expensive during dependency churn.
    const relevant = [...signal.registrations].some((id) => {
      const registration = this.registrations.get(id);
      return (
        registration &&
        this.matchesNativeEvent(registration, signal, eventPath) &&
        !this.isIgnoredForRegistration(registration, eventPath)
      );
    });
    if (!relevant) return;
    if (consumeInternalWrite(eventPath, this.internalWriteWindowMs)) return;
    this.invalidateNativeRegistrations(signal, eventPath);
  }

  private invalidateNativeRegistrations(
    signal: NativeSignalAnchor,
    eventPath: string = signal.anchor,
  ): void {
    for (const id of [...signal.registrations]) {
      const registration = this.registrations.get(id);
      if (!registration) continue;
      if (!this.matchesNativeEvent(registration, signal, eventPath)) continue;
      if (this.isIgnoredForRegistration(registration, eventPath)) continue;
      if (registration.request.preferNativeRecursive) {
        try {
          const stats = lstatSync(eventPath);
          if (
            (stats.isSymbolicLink() &&
              isUnder(eventPath, registration.matched)) ||
            (stats.isDirectory() && this.hasDescendantSymlink(registration))
          ) {
            this.fallbackToChokidar(registration);
            continue;
          }
        } catch {
          // Deleted entries are handled by rebinding below.
        }
      }
      this.scheduleNotification(registration, 'change', registration.requested);
      if (
        registration.fallback ||
        (signal.flat && eventPath === signal.anchor) ||
        !existsSync(registration.requested) ||
        registration.entryGuards.some(
          (guard) =>
            eventPath === guard.entry || eventPath === guard.matchedEntry,
        )
      ) {
        this.rebindNativeRegistration(registration);
      }
    }
  }

  private rebindNativeRegistration(registration: Registration): void {
    this.detachNativeRegistration(registration);
    this.refreshWatchTarget(registration);
    if (this.usesNativeSignals(registration)) {
      this.attachNativeRegistration(registration);
    } else {
      this.attachChokidarRegistration(registration);
    }
  }

  private matchesNativeEvent(
    registration: Registration,
    signal: NativeSignalAnchor,
    eventPath: string,
  ): boolean {
    if (!signal.flat) return true;
    if (
      eventPath === registration.requested ||
      eventPath === registration.matched ||
      isUnder(eventPath, registration.requested) ||
      isUnder(registration.requested, eventPath) ||
      isUnder(eventPath, registration.matched) ||
      isUnder(registration.matched, eventPath)
    ) {
      return true;
    }
    return registration.entryGuards.some(
      (guard) =>
        guard.anchor === signal.anchor &&
        (eventPath === guard.entry || eventPath === guard.matchedEntry),
    );
  }

  private attachChokidarRegistration(registration: Registration): void {
    for (const anchor of planRegistrationAnchors(registration)) {
      this.getChokidarBackend(registration).retain(
        anchor.anchor,
        anchor.flat,
        registration.request.depth,
      );
    }
  }

  private getChokidarBackend(registration: Registration): ChokidarBackendPool {
    return registration.nativeSignalDisabled &&
      registration.request.preferNativeRecursive
      ? this.fallbackPollingBackend
      : this.defaultChokidarBackend;
  }

  private detachChokidarRegistration(registration: Registration): void {
    for (const anchor of planRegistrationAnchors(registration)) {
      this.getChokidarBackend(registration).release(
        anchor.anchor,
        anchor.flat,
        registration.request.depth,
      );
    }
  }

  private rebindChokidarRegistration(registration: Registration): void {
    const previous = new Map(
      planRegistrationAnchors(registration).map((anchor) => [
        anchorKey(anchor.anchor, anchor.flat),
        anchor,
      ]),
    );
    this.refreshWatchTarget(registration);
    const next = new Map(
      planRegistrationAnchors(registration).map((anchor) => [
        anchorKey(anchor.anchor, anchor.flat),
        anchor,
      ]),
    );
    for (const [key, anchor] of previous) {
      if (!next.has(key)) {
        this.getChokidarBackend(registration).release(
          anchor.anchor,
          anchor.flat,
          registration.request.depth,
        );
      }
    }
    for (const [key, anchor] of next) {
      if (!previous.has(key)) {
        this.getChokidarBackend(registration).retain(
          anchor.anchor,
          anchor.flat,
          registration.request.depth,
        );
      }
    }
  }

  private handleChokidarEvent(
    operation: FileChangeOperation,
    rawPath: string,
    source: ChokidarEventSource = 'default',
  ): void {
    const path = resolve(rawPath);
    if (consumeInternalWrite(path, this.internalWriteWindowMs)) return;
    const canonical = canonicalPath(path);
    for (const registration of this.registrations.values()) {
      // Shared services can have native, ordinary Chokidar and fallback
      // polling targets at once. Never feed one backend's events to another.
      if (this.started && this.usesNativeSignals(registration)) continue;
      if (
        (this.getChokidarBackend(registration) === this.fallbackPollingBackend) !==
        (source === 'fallback-polling')
      ) continue;
      this.deliverChokidarEvent(registration, operation, path, canonical);
    }
  }

  private isIgnoredForRegistration(
    registration: Registration,
    path: string,
  ): boolean {
    const { ignoredDirectoryNames, depth } = registration.request;
    return [registration.matched, registration.requested].some((root) =>
      isIgnoredDescendant(
        path, root, ['.git', ...(ignoredDirectoryNames ?? [])], depth,
      ),
    );
  }

  /** Shared backends may prune a subtree only when every matching target excludes it. */
  private isIgnoredByChokidarRequests(
    rawPath: string,
    source: ChokidarEventSource,
  ): boolean {
    const path = resolve(rawPath);
    let ignored = false;
    for (const registration of this.registrations.values()) {
      if (this.usesNativeSignals(registration)) continue;
      if (
        (this.getChokidarBackend(registration) === this.fallbackPollingBackend) !==
        (source === 'fallback-polling')
      ) continue;
      for (const root of new Set([
        registration.matched,
        registration.requested,
      ])) {
        // Keep target ancestors observable, including missing targets and symlink guards.
        if (path === root || isUnder(root, path)) return false;
        if (!isUnder(path, root)) continue;
        if (
          !isIgnoredDescendant(
            path,
            root,
            registration.request.ignoredDirectoryNames,
          )
        ) {
          return false;
        }
        ignored = true;
      }
    }
    return ignored;
  }

  private deliverChokidarEvent(
    registration: Registration,
    operation: FileChangeOperation,
    path: string,
    canonical: string,
  ): void {
    const { requested, matched } = registration;
    const recursive = registration.request.recursive ?? true;
    if (
      this.isIgnoredForRegistration(registration, path) ||
      this.isIgnoredForRegistration(registration, canonical)
    )
      return;

    // The content watcher uses the canonical target and cannot see deletion
    // of an ancestor symlink. A flat guard on the symlink parent reports that
    // directory entry change; normalize it into removal of the requested
    // logical target.
    if (
      operation === 'unlink' &&
      registration.entryGuards.some(
        (guard) => path === guard.entry || path === guard.matchedEntry,
      )
    ) {
      this.rebindChokidarRegistration(registration);
      this.scheduleNotification(registration, 'unlink', requested);
      return;
    }

    // Flat anchors only observe their direct children.
    if (
      registration.flat &&
      dirname(canonical) !== registration.anchorMatched &&
      canonicalPath(dirname(path)) !== registration.anchorMatched
    )
      return;

    if (registration.fallback) {
      // Waiting for the missing target to appear: only react to creation
      // events on the path to it.
      if (operation !== 'add') return;
      const reachesMatched =
        canonical === matched || isUnder(matched, canonical);
      const reachesRequested =
        path === requested || isUnder(requested, path);
      if (!reachesMatched && !reachesRequested) return;

      if (existsSync(requested)) {
        // Target appeared: promote to a direct/parent anchor.
        this.rebindChokidarRegistration(registration);
        this.scheduleNotification(registration, 'add', requested);
      } else if (existsSync(path)) {
        // Intermediate directory created: move the flat anchor one level
        // deeper so the next segment becomes visible.
        this.rebindChokidarRegistration(registration);
      }
      return;
    }

    // The directly-watched target disappeared: demote to a flat watch of
    // its parent so recreation is detected, and report the unlink.
    // Once a symlink target disappears, canonicalPath(path) can no longer
    // resolve into the namespace captured in `matched`. Chokidar still reports
    // the unlink using the requested alias, so match that namespace as well.
    if (
      operation === 'unlink' &&
      (canonical === matched || path === requested)
    ) {
      this.rebindChokidarRegistration(registration);
      this.scheduleNotification(registration, operation, requested);
      return;
    }

    if (canonical === matched) {
      this.scheduleNotification(registration, operation, requested);
      return;
    }
    // Chokidar follows descendant symlinks and reports their logical path.
    // Their canonical target may be outside `matched`, but still belongs to
    // this registration through the requested namespace.
    const matches = recursive
      ? isUnder(canonical, matched) || isUnder(path, requested)
      : dirname(canonical) === matched || dirname(path) === requested;
    if (matches) {
      this.scheduleNotification(
        registration,
        operation,
        this.toReportedPath(registration, canonical, path),
      );
    }
  }

  /**
   * Report events in the caller's requested namespace: canonical
   * (symlink-resolved) event paths are mapped back onto the requested
   * prefix so consumers never see canonicalization artifacts.
   */
  private toReportedPath(
    registration: Registration,
    canonical: string,
    rawPath: string,
  ): string {
    if (isUnder(canonical, registration.matched)) {
      return join(
        registration.requested,
        canonical.slice(registration.matched.length + 1),
      );
    }
    return rawPath;
  }

  private scheduleNotification(
    registration: Registration,
    operation: FileChangeOperation,
    path: string,
  ): void {
    const key = `${operation}:${path}`;
    const previous = registration.timers.get(key);
    if (previous) clearTimeout(previous);
    registration.timers.set(
      key,
      setTimeout(() => {
        registration.timers.delete(key);
        void Promise.resolve(
          registration.listener({ path, operation }),
        ).catch(() => undefined);
      }, this.debounceMs),
    );
  }
}

/** @deprecated Use FileSystemWatcher or createFileWatcher(). */
export const ChokidarFileWatcher = FileSystemWatcher;
/** @deprecated Use FileSystemWatcher. */
export type ChokidarFileWatcher = FileSystemWatcher;

export class NoopFileWatcher implements FileWatcher {
  readonly isNoop = true;

  watch(): () => void {
    return () => undefined;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

export function createNoopFileWatcher(): FileWatcher {
  return new NoopFileWatcher();
}

/**
 * Creates a file watcher, degrading to a no-op watcher when initialization
 * fails so watch unavailability never blocks the caller's main flow.
 */
export function createFileWatcher(options: FileWatcherOptions = {}): FileWatcher {
  try {
    return new FileSystemWatcher(options);
  } catch {
    return createNoopFileWatcher();
  }
}
