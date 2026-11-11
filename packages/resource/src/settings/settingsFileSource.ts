/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createFileWatcher } from '../file-watcher/fileWatcher.js';
import type {
  FileChangeEvent,
  FileWatcher,
} from '../file-watcher/types.js';
import {
  mutateSettingsFile,
  type SettingsFileMutation,
  type SettingsMutationOptions,
  type SettingsWriteResult,
} from './settingsPersistence.js';
import {
  registerSettingsWriteObserver,
  type SettingsWriteObserver,
} from './settingsWriteEvents.js';

export interface SettingsFileChangeEvent extends FileChangeEvent {
  /** Present for a successful settings file mutation. */
  writeId?: string;
}

interface SettingsSubscription {
  listener: (event: SettingsFileChangeEvent) => void;
}

const sources = new Set<WeakRef<SettingsFileSource>>();

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

export function invalidateSettingsFileSources(filePath?: string): void {
  const target = filePath === undefined ? undefined : resolve(filePath);
  for (const reference of sources) {
    const source = reference.deref();
    if (!source) sources.delete(reference);
    else if (target === undefined || sameFile(source.path, target)) {
      source.invalidate();
    }
  }
}

/** Read a settings file exactly once; missing files are empty sources. */
export function readSettingsFileText(filePath: string): string | undefined {
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : undefined;
}

/** Raw file source; SettingsService and host sessions own interpretation/merging. */
export class SettingsFileSource implements SettingsWriteObserver {
  readonly path: string;
  private cached?: { text: string | undefined; expiresAt: number };

  constructor(filePath: string) {
    this.path = resolve(filePath);
    for (const reference of sources) {
      if (!reference.deref()) sources.delete(reference);
    }
    sources.add(new WeakRef(this));
    registerSettingsWriteObserver(this);
  }

  read(): string | undefined {
    const now = Date.now();
    if (this.cached && now < this.cached.expiresAt) return this.cached.text;
    const text = readSettingsFileText(this.path);
    this.cached = { text, expiresAt: now + 10_000 };
    return text;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  mutate(
    mutation: SettingsFileMutation,
    options?: SettingsMutationOptions,
  ): SettingsWriteResult {
    const result = mutateSettingsFile(this.path, mutation, options);
    this.setRawJson(fs.existsSync(this.path) ? result.rawJson : undefined);
    return result;
  }

  setRawJson(text: string | undefined): void {
    this.cached = { text, expiresAt: Date.now() + 10_000 };
  }

  onSettingsFileWritten(filePath: string, rawJson: string | undefined): void {
    if (sameFile(this.path, resolve(filePath))) this.setRawJson(rawJson);
  }

  onSettingsFileInvalidated(filePath: string): void {
    if (sameFile(this.path, resolve(filePath))) this.invalidate();
  }
}

/** Process-scoped user source; kept as a distinct type for its fixed root. */
export class UserSettingsSource extends SettingsFileSource {}

export function invalidateUserSettingsSources(filePath?: string): void {
  const target = filePath === undefined ? undefined : resolve(filePath);
  for (const reference of sources) {
    const source = reference.deref();
    if (!source) sources.delete(reference);
    else if (
      source instanceof UserSettingsSource &&
      (target === undefined || sameFile(source.path, target))
    ) {
      source.invalidate();
    }
  }
}

/** Process user source and project sources have separate ownership. */
export class SettingsSourceStore implements SettingsWriteObserver {
  private user?: UserSettingsSource;
  private readonly projects = new Map<
    string,
    { project: SettingsFileSource; local: SettingsFileSource }
  >();
  private watcher?: FileWatcher;
  private watcherStart?: Promise<void>;
  private reportedNoopWatcher = false;
  private readonly watchers = new Map<
    string,
    {
      listeners: Set<SettingsSubscription>;
      unwatch: () => void;
      cancelDeletion: () => void;
    }
  >();
  private readonly pendingStops = new Set<Promise<void>>();
  private readonly unregisterWriteObserver =
    registerSettingsWriteObserver(this);
  private readonly pendingWrittenTexts = new Map<
    string,
    { text: string; expiresAt: number }
  >();
  private disposed = false;
  private disposeRequested = false;

  /** Let the host report a degraded watch once, using its own logger. */
  takeWatchUnavailableWarning(): boolean {
    if (!this.watcher?.isNoop || this.reportedNoopWatcher) return false;
    this.reportedNoopWatcher = true;
    return true;
  }

  onSettingsFileWritten(
    filePath: string,
    rawJson: string | undefined,
    changed: boolean,
    writeId?: string,
  ): void {
    if (this.disposed) return;
    const writtenPath = resolve(filePath);
    for (const source of this.sourcesForPath(writtenPath)) {
      source.setRawJson(rawJson);
    }
    if (!changed || rawJson === undefined) return;
    const watchedPaths = [...this.watchers.keys()].filter((watchedPath) =>
      sameFile(watchedPath, writtenPath),
    );
    for (const watchedPath of watchedPaths) {
      this.pendingWrittenTexts.set(watchedPath, {
        text: rawJson,
        expiresAt: Date.now() + 5000,
      });
      queueMicrotask(() => {
        const registration = this.watchers.get(watchedPath);
        if (this.disposed) return;
        for (const subscription of registration?.listeners ?? []) {
          try {
            subscription.listener({
              path: watchedPath,
              operation: 'change',
              writeId,
            });
          } catch {
            // One session cannot prevent another from receiving the change.
          }
        }
      });
    }
  }

  onSettingsFileInvalidated(filePath: string): void {
    if (!this.disposed) this.invalidateFile(resolve(filePath));
  }

  getUser(filePath: string): UserSettingsSource {
    this.assertAcceptingAccess();
    const resolved = resolve(filePath);
    if (this.user && this.user.path !== resolved)
      throw new Error('User settings root is already fixed for this process');
    return (this.user ??= new UserSettingsSource(resolved));
  }

  /** Return the bound process user source without fixing a root. */
  peekUser(): UserSettingsSource | undefined {
    this.assertAcceptingAccess();
    return this.user;
  }

  /** Read-only peek: return the user source only if already bound to this path; never bind. */
  tryGetUser(filePath: string): UserSettingsSource | undefined {
    this.assertAcceptingAccess();
    const resolved = resolve(filePath);
    return this.user && this.user.path === resolved ? this.user : undefined;
  }

  getProject(
    projectPath: string,
    localPath: string,
  ): { project: SettingsFileSource; local: SettingsFileSource } {
    this.assertAcceptingAccess();
    const key = JSON.stringify([resolve(projectPath), resolve(localPath)]);
    let sources = this.projects.get(key);
    if (!sources) {
      sources = {
        project: new SettingsFileSource(projectPath),
        local: new SettingsFileSource(localPath),
      };
      this.projects.set(key, sources);
    }
    return sources;
  }

  invalidateAll(): void {
    this.user?.invalidate();
    for (const { project, local } of this.projects.values()) {
      project.invalidate();
      local.invalidate();
    }
  }

  /** Watch every target. FileWatcher anchors missing paths at an existing parent. */
  async watchFiles(
    filePaths: readonly string[],
    listener: (event: SettingsFileChangeEvent) => void,
  ): Promise<() => void> {
    const paths = [...new Set(filePaths.map((filePath) => resolve(filePath)))];
    const results = await Promise.allSettled(
      paths.map((filePath) => this.watchFile(filePath, listener)),
    );
    const stops = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      for (const stop of stops) stop();
      throw failure.reason;
    }
    return () => {
      for (const stop of stops) stop();
    };
  }

  /** Share one physical watch per settings file while sessions handle hooks. */
  async watchFile(
    filePath: string,
    listener: (event: SettingsFileChangeEvent) => void,
  ): Promise<() => void> {
    this.assertAcceptingAccess();
    const key = resolve(filePath);
    let registration = this.watchers.get(key);
    if (!registration) {
      const watcher = (this.watcher ??= createFileWatcher());
      const listeners = new Set<SettingsSubscription>();
      let deletionTimer: ReturnType<typeof setTimeout> | undefined;
      let creationPoll: ReturnType<typeof setInterval> | undefined;
      let polledCreationText: string | undefined;
      let hasPolledSnapshot = false;
      const stopCreationPoll = () => {
        if (!creationPoll) return;
        clearInterval(creationPoll);
        creationPoll = undefined;
      };
      const deliver = (event: FileChangeEvent) => {
        this.invalidateFile(key);
        // Refresh the shared raw snapshot before notifying sessions.
        const sources = this.sourcesForPath(key);
        for (const source of sources) {
          try {
            source.read();
          } catch {
            source.invalidate();
          }
        }
        const pendingWrite = this.pendingWrittenTexts.get(key);
        if (pendingWrite !== undefined) {
          let currentText: string | undefined;
          try {
            currentText = sources[0]?.read() ?? readSettingsFileText(key);
          } catch {
            // A failed read must not hide the file event from sessions.
          }
          if (
            Date.now() <= pendingWrite.expiresAt &&
            currentText === pendingWrite.text
          ) {
            return;
          }
          this.pendingWrittenTexts.delete(key);
        }
        for (const subscription of [...listeners]) {
          try {
            subscription.listener({ ...event, path: key });
          } catch {
            // One session cannot prevent another from receiving the change.
          }
        }
      };
      const dispatch = (event: FileChangeEvent) => {
        if (event.operation === 'unlink') {
          if (deletionTimer) clearTimeout(deletionTimer);
          deletionTimer = setTimeout(() => {
            deletionTimer = undefined;
            deliver(event);
          }, 1700);
          return;
        }
        if (deletionTimer) {
          clearTimeout(deletionTimer);
          deletionTimer = undefined;
        }
        deliver(event);
      };
      const handleFileEvent = (event: FileChangeEvent) => {
        if (
          creationPoll &&
          event.operation !== 'unlink' &&
          fs.existsSync(key)
        ) {
          stopCreationPoll();
        }
        if (hasPolledSnapshot) {
          let currentText: string | undefined;
          try {
            currentText = readSettingsFileText(key);
          } catch {
            // Continue with the event so the session can report the read error.
          }
          const duplicateCreation = currentText === polledCreationText;
          hasPolledSnapshot = false;
          if (duplicateCreation) return;
        }
        dispatch(event);
      };
      const unwatchFile = watcher.watch(
        { path: key, logicalRoot: dirname(dirname(key)) },
        handleFileEvent,
      );
      // Creating a missing config directory and its file back-to-back can race
      // FileWatcher's fallback-anchor promotion. Poll only during that narrow
      // initial state until a physical event confirms that the file watch has
      // adopted the path. Stopping on the first polled read can lose an edit or
      // deletion while fallback-anchor promotion is still in flight.
      const configDirectory = dirname(key);
      if (!fs.existsSync(configDirectory)) {
        creationPoll = setInterval(() => {
          let currentText: string | undefined;
          try {
            currentText = readSettingsFileText(key);
          } catch {
            // Wait for the next read or a physical event to report read errors.
            return;
          }
          if (currentText === polledCreationText) return;
          const existed = polledCreationText !== undefined;
          polledCreationText = currentText;
          hasPolledSnapshot = true;
          dispatch({
            path: key,
            operation: currentText === undefined ? 'unlink' : existed ? 'change' : 'add',
          });
        }, 250);
        creationPoll.unref?.();
      }
      registration = {
        listeners,
        unwatch: () => {
          unwatchFile();
          stopCreationPoll();
        },
        cancelDeletion: () => {
          if (deletionTimer) clearTimeout(deletionTimer);
        },
      };
      this.watchers.set(key, registration);
    }
    const subscription = { listener };
    registration.listeners.add(subscription);
    try {
      const watcher = this.watcher!;
      await (this.watcherStart ??= Promise.resolve().then(() =>
        watcher.start(),
      ));
      if (
        this.disposed ||
        this.watchers.get(key) !== registration ||
        !registration.listeners.has(subscription)
      ) {
        throw new Error('Settings source store was disposed while starting');
      }
    } catch (error) {
      this.removeListener(key, subscription);
      throw error;
    }
    return () => this.removeListener(key, subscription);
  }

  private invalidateFile(filePath: string): void {
    if (this.user && sameFile(this.user.path, filePath)) this.user.invalidate();
    for (const { project, local } of this.projects.values()) {
      if (sameFile(project.path, filePath)) project.invalidate();
      if (sameFile(local.path, filePath)) local.invalidate();
    }
  }

  private sourcesForPath(filePath: string): SettingsFileSource[] {
    const sources: SettingsFileSource[] = [];
    if (this.user && sameFile(this.user.path, filePath))
      sources.push(this.user);
    for (const { project, local } of this.projects.values()) {
      if (sameFile(project.path, filePath)) sources.push(project);
      if (sameFile(local.path, filePath)) sources.push(local);
    }
    return sources;
  }

  private assertAcceptingAccess(): void {
    if (this.disposed || this.disposeRequested) {
      throw new Error('Settings source store is disposing or disposed');
    }
  }

  private removeListener(
    key: string,
    subscription: SettingsSubscription,
  ): void {
    const registration = this.watchers.get(key);
    if (!registration) return;
    registration.listeners.delete(subscription);
    if (registration.listeners.size > 0) return;
    registration.cancelDeletion();
    registration.unwatch();
    this.watchers.delete(key);
    if (this.watchers.size > 0 || !this.watcher) return;
    const watcher = this.watcher;
    this.watcher = undefined;
    this.watcherStart = undefined;
    const stopping = watcher.stop();
    this.pendingStops.add(stopping);
    void stopping
      .finally(() => this.pendingStops.delete(stopping))
      .catch(() => undefined);
    if (this.disposeRequested) void this.dispose();
  }

  /** Defer teardown until active session subscriptions have detached. */
  requestDispose(): Promise<void> | undefined {
    this.disposeRequested = true;
    return this.watchers.size === 0 ? this.dispose() : undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterWriteObserver();
    this.pendingWrittenTexts.clear();
    for (const registration of this.watchers.values()) {
      registration.cancelDeletion();
      registration.unwatch();
    }
    this.watchers.clear();
    this.projects.clear();
    this.user = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    this.watcherStart = undefined;
    await Promise.allSettled([watcher?.stop(), ...this.pendingStops]);
  }
}
