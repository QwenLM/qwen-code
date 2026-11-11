/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionStateStore,
  getCommittedWorkspace,
  runLogger,
  type SDKArtifactInfo,
} from '@qwen-code/core';
import { cloneArtifactEntry } from './artifactProtocol.js';
import {
  ArtifactRegistry,
  type ArtifactPresentationOptions,
  type ArtifactRegistryOptions,
  type ArtifactRegistryObservation,
} from './artifactRegistry.js';
import { SessionStateArtifactRegistryPersistence } from './artifactRegistryStore.js';

export interface SessionArtifactRuntimeConfig {
  getWorkingDir(): string;
  getSessionArtifactProjectRoot(): string;
  getSessionId(): string;
  getSessionPersistence(): boolean;
  getWorkspaceContext(): {
    getDirectories(): readonly string[];
  };
}

export type ArtifactSnapshotSubscriber = (
  snapshot: readonly SDKArtifactInfo[],
  observation?: ArtifactRegistryObservation,
) => void;

function sameArtifactInfo(
  left: SDKArtifactInfo,
  right: SDKArtifactInfo,
): boolean {
  const sameMetadata =
    left.path === right.path &&
    left.display_path === right.display_path &&
    left.name === right.name &&
    left.group?.key === right.group?.key &&
    left.group?.name === right.group?.name &&
    left.relative_path === right.relative_path &&
    left.size === right.size &&
    left.mime === right.mime &&
    left.mtime === right.mtime;
  if (!sameMetadata || left.kind !== right.kind) return false;
  if (left.kind === 'changed' && right.kind === 'changed') {
    return (
      left.additions === right.additions &&
      left.deletions === right.deletions &&
      left.is_new === right.is_new
    );
  }
  return true;
}

function sameSnapshot(
  left: readonly SDKArtifactInfo[],
  right: readonly SDKArtifactInfo[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return other !== undefined && sameArtifactInfo(entry, other);
    })
  );
}

export type HostArtifactRefresh = () => Promise<readonly SDKArtifactInfo[]>;

const HOST_RECOVERY_DELAYS_MS = [0, 250, 750, 2000, 4000, 8000];
type HostRefreshResult = {
  snapshot: SDKArtifactInfo[] | null;
  retryable: boolean;
};

function waitForRecovery(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

export class SessionArtifactRuntime {
  private readonly registry: ArtifactRegistry;
  private readonly subscribers = new Set<ArtifactSnapshotSubscriber>();
  private lastPublishedSnapshot: SDKArtifactInfo[] | undefined;
  private externalSnapshot: Map<string, SDKArtifactInfo> | undefined;
  private hostRefresh?: HostArtifactRefresh;
  private refreshChain: Promise<void> = Promise.resolve();
  private hostRefreshGeneration = 0;
  private hostSnapshotAcquired = false;
  private lastRefreshSucceeded = false;
  private hostRecovery?: {
    controller: AbortController;
    promise: Promise<void>;
  };

  constructor(options: ArtifactRegistryOptions) {
    this.registry = new ArtifactRegistry(options);
  }

  setHostRefresh(refresh: HostArtifactRefresh): void {
    this.cancelHostRecovery();
    this.hostRefreshGeneration++;
    this.hostRefresh = refresh;
    this.hostSnapshotAcquired = false;
    this.lastRefreshSucceeded = false;
    this.externalSnapshot = undefined;
  }

  clearHostRefresh(): void {
    this.cancelHostRecovery();
    this.hostRefreshGeneration++;
    this.hostRefresh = undefined;
    this.hostSnapshotAcquired = false;
    this.lastRefreshSucceeded = false;
    this.clearExternalSnapshot();
  }

  hasHostRefresh(): boolean {
    return this.hostRefresh !== undefined;
  }

  publishableSnapshot(): SDKArtifactInfo[] | null {
    if (this.hostRefresh && !this.hostSnapshotAcquired) {
      return null;
    }
    return this.snapshot();
  }

  refreshEffectiveSnapshot(): Promise<void> {
    return this.queueHostRefresh().then(() => undefined);
  }

  async refreshHostSnapshot(): Promise<SDKArtifactInfo[] | null> {
    return (await this.queueHostRefresh()).snapshot;
  }

  /** Recovery sleeps never occupy the refresh queue or block SDK/Bridge readiness. */
  recoverHostSnapshot(): Promise<void> {
    if (!this.hostRefresh) return Promise.resolve();
    if (this.hostRecovery) return this.hostRecovery.promise;
    const controller = new AbortController();
    const generation = this.hostRefreshGeneration;
    const recover = async () => {
      for (const [attempt, waitMs] of HOST_RECOVERY_DELAYS_MS.entries()) {
        if (waitMs) await waitForRecovery(waitMs, controller.signal);
        if (
          controller.signal.aborted ||
          generation !== this.hostRefreshGeneration
        )
          return;
        // A normal turn refresh can satisfy recovery while its timer is pending.
        if (attempt > 0 && this.lastRefreshSucceeded) return;
        const result = await this.queueHostRefresh();
        if (
          controller.signal.aborted ||
          generation !== this.hostRefreshGeneration
        )
          return;
        if (result.snapshot !== null || !result.retryable) return;
        runLogger.debug(
          `[artifacts] Host recovery pending attempt=${attempt + 1}/${HOST_RECOVERY_DELAYS_MS.length}`,
        );
      }
    };
    const promise = recover()
      .catch((error) => {
        if (!controller.signal.aborted) {
          runLogger.debug('[artifacts] Host recovery stopped', error);
        }
      })
      .finally(() => {
        if (this.hostRecovery?.controller === controller)
          this.hostRecovery = undefined;
      });
    this.hostRecovery = { controller, promise };
    return promise;
  }

  cancelHostRecovery(): void {
    this.hostRecovery?.controller.abort();
    this.hostRecovery = undefined;
  }

  async waitForPendingRefresh(): Promise<void> {
    await this.refreshChain;
  }

  snapshot(): SDKArtifactInfo[] {
    if (this.externalSnapshot) {
      return [...this.externalSnapshot.values()].map(cloneArtifactEntry);
    }
    return this.registry.snapshot();
  }

  cliSnapshot(): SDKArtifactInfo[] {
    return this.registry.snapshot();
  }

  async useExternalSnapshot(
    artifacts: readonly SDKArtifactInfo[],
  ): Promise<SDKArtifactInfo[]> {
    const resolved = await this.registry.validateExternalSnapshot(artifacts);
    this.externalSnapshot = new Map(
      resolved.map((entry) => [entry.path, cloneArtifactEntry(entry)]),
    );
    return this.snapshot();
  }

  clearExternalSnapshot(): void {
    this.externalSnapshot = undefined;
  }

  subscribe(subscriber: ArtifactSnapshotSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async initialize(
    historicalEvents: readonly unknown[] = [],
    options: { readonly forcePublish?: boolean } = {},
  ): Promise<SDKArtifactInfo[] | null> {
    const snapshot = await this.registry.initialize(historicalEvents);
    if (snapshot === null) return null;
    if (!this.hostRefresh) {
      this.publish(snapshot, options.forcePublish ?? true);
    }
    return snapshot;
  }

  async observeEvent(
    event: unknown,
  ): Promise<ArtifactRegistryObservation | null> {
    const observation = await this.registry.observeEvent(event);
    if (observation?.snapshot) {
      if (this.hostRefresh) {
        this.enqueueRefresh(observation);
      } else {
        this.publish(observation.snapshot, false, observation);
      }
    }
    return observation;
  }

  async present(
    paths: readonly string[],
    options: ArtifactPresentationOptions = {},
  ): Promise<ArtifactRegistryObservation> {
    const observation = await this.registry.present(paths, options);
    if (observation.snapshot) {
      if (this.hostRefresh) {
        this.enqueueRefresh(observation);
      } else {
        this.publish(observation.snapshot, false, observation);
      }
    }
    return observation;
  }

  get(pathname: string): ReturnType<ArtifactRegistry['get']> {
    if (this.externalSnapshot) {
      const entry = this.externalSnapshot.get(pathname);
      return entry ? { entry: cloneArtifactEntry(entry) } : undefined;
    }
    return this.registry.get(pathname);
  }

  async revalidate(
    pathname: string,
  ): ReturnType<ArtifactRegistry['revalidate']> {
    if (this.externalSnapshot) {
      const existing = this.externalSnapshot.get(pathname);
      if (!existing) return { status: 'not_registered' };
      try {
        const [refreshed] = await this.registry.validateExternalSnapshot([
          existing,
        ]);
        if (!refreshed) {
          this.externalSnapshot.delete(pathname);
          return { status: 'unavailable', snapshot: this.snapshot() };
        }
        if (sameArtifactInfo(existing, refreshed)) {
          return { status: 'unchanged' };
        }
        this.externalSnapshot.delete(pathname);
        this.externalSnapshot.set(refreshed.path, refreshed);
        return { status: 'changed', snapshot: this.snapshot() };
      } catch {
        this.externalSnapshot.delete(pathname);
        return { status: 'unavailable', snapshot: this.snapshot() };
      }
    }
    const result = await this.registry.revalidate(pathname);
    if ('snapshot' in result) {
      this.publish(result.snapshot);
    }
    return result;
  }

  private enqueueRefresh(observation: ArtifactRegistryObservation): void {
    void this.queueHostRefresh(observation);
  }

  private queueHostRefresh(
    observation?: ArtifactRegistryObservation,
  ): Promise<HostRefreshResult> {
    const generation = this.hostRefreshGeneration;
    const p = this.refreshChain.then(() =>
      this.performRefresh(generation, observation),
    );
    this.refreshChain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  private async performRefresh(
    generation: number,
    observation?: ArtifactRegistryObservation,
  ): Promise<HostRefreshResult> {
    const unavailable = { snapshot: null, retryable: false };
    if (!this.hostRefresh || generation !== this.hostRefreshGeneration)
      return unavailable;
    try {
      const artifacts = await this.hostRefresh();
      if (this.hostRefreshGeneration !== generation) return unavailable;
      const resolved = await this.registry.validateExternalSnapshot(artifacts);
      if (this.hostRefreshGeneration !== generation) return unavailable;
      this.externalSnapshot = new Map(
        resolved.map((entry) => [entry.path, cloneArtifactEntry(entry)]),
      );
      this.hostSnapshotAcquired = true;
      this.lastRefreshSucceeded = true;
    } catch (error) {
      if (this.hostRefreshGeneration !== generation) return unavailable;
      this.lastRefreshSucceeded = false;
      const message = error instanceof Error ? error.message : '';
      const reason = message.match(
        /REMOTE_CONTROL_ARTIFACT_(UNAVAILABLE|STALE|READ_FAILED|TIMEOUT)\b/,
      )?.[0];
      const retryable =
        reason !== undefined ||
        /resolve_session_artifacts timed out/.test(message);
      runLogger.debug(
        `[artifacts] Host refresh failed reason=${reason ?? (retryable ? 'timeout' : 'non_retryable')} retained=${this.hostSnapshotAcquired}`,
      );
      // Preserve existing observation delivery for current-turn candidates. This
      // is the last Host directory, never a CLI fallback or fresh authorization.
      const retained = this.publishableSnapshot();
      if (retained !== null) this.publish(retained, true, observation);
      return { snapshot: null, retryable };
    }
    const publishable = this.publishableSnapshot();
    if (publishable !== null) {
      this.publish(publishable, true, observation);
    }
    return { snapshot: publishable, retryable: false };
  }

  private publish(
    snapshot: readonly SDKArtifactInfo[],
    force = false,
    observation?: ArtifactRegistryObservation,
  ): void {
    if (
      !force &&
      this.lastPublishedSnapshot !== undefined &&
      sameSnapshot(this.lastPublishedSnapshot, snapshot)
    ) {
      return;
    }
    this.lastPublishedSnapshot = snapshot.map(cloneArtifactEntry);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(snapshot.map(cloneArtifactEntry), observation);
      } catch {
        continue;
      }
    }
  }
}

export function createSessionArtifactRuntime(
  config: SessionArtifactRuntimeConfig,
): SessionArtifactRuntime {
  return new SessionArtifactRuntime({
    workingDirectory: config.getWorkingDir(),
    initialWorkspaceRoots: [
      ...config.getWorkspaceContext().getDirectories(),
    ],
    getWorkspace: () => {
      const workspace = getCommittedWorkspace(config);
      return {
        workingDirectory: workspace.cwd,
        initialWorkspaceRoots: workspace.directories,
      };
    },
    persistence: new SessionStateArtifactRegistryPersistence(
      new SessionStateStore({
        projectRoot: config.getSessionArtifactProjectRoot(),
        sessionId: config.getSessionId(),
        persist: config.getSessionPersistence(),
      }),
    ),
  });
}
