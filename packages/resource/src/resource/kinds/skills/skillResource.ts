/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillDefinition, SkillLoadError, SkillSource } from './types.js';
import { logger } from './internal.js';
import type { ResourceChangeEvent } from '../../core/types.js';
import type { SkillProviderContribution } from './providers/skillProvider.js';
import type {
  SkillResourceView,
  SkillResourceSnapshot,
  SkillResourceChangeListener,
} from '../../core/resourceViews.js';

/**
 * Normalizes one scope's freshly loaded candidates: entries are copied and
 * tagged with the scope's source, a canonical file is loaded once (symlink
 * loops, the same directory reached through multiple roots), and exact
 * re-registrations of the same name and location are skipped. Name
 * collisions between different locations are preserved as-is; shadow
 * bookkeeping and winner selection belong to the host.
 */
export function normalizeSkillCandidates(
  skills: readonly SkillDefinition[],
  source: SkillSource,
): SkillDefinition[] {
  const loadedResolvedPaths = new Set<string>();
  const registered = new Set<string>();
  const discovered: SkillDefinition[] = [];
  for (const skill of skills) {
    if (skill.resolvedPath) {
      if (loadedResolvedPaths.has(skill.resolvedPath)) {
        logger.debug(
          `Skill "${skill.name}" at ${skill.location} skipped: same file already loaded (resolvedPath=${skill.resolvedPath}).`,
        );
        continue;
      }
      loadedResolvedPaths.add(skill.resolvedPath);
    }
    const identity = `${skill.name}\u0000${skill.location}`;
    if (registered.has(identity)) {
      logger.debug(
        `Skill "${skill.name}" from "${skill.location}" skipped: identical skill already loaded.`,
      );
      continue;
    }
    registered.add(identity);
    // Copy before tagging: shared contributions must not be mutated.
    discovered.push({ ...skill, source });
  }
  return discovered;
}

export type { SkillDirectorySet } from './providers/skillProvider.js';

export class SkillCandidateView implements SkillResourceView {
  private readonly listeners = new Set<SkillResourceChangeListener>();
  snapshot: SkillResourceSnapshot = {
    discoveredSkills: [],
    loadErrors: [],
  };

  replace(snapshot: SkillResourceSnapshot): void {
    this.snapshot = cloneSkillSnapshot(snapshot);
  }

  getAllDiscoveredSkills(): SkillDefinition[] {
    return this.snapshot.discoveredSkills.map(cloneSkillDefinition);
  }

  getLoadErrors(): readonly SkillLoadError[] {
    return this.snapshot.loadErrors.map((error) => ({ ...error }));
  }

  onDidChange(listener: SkillResourceChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async notifyDidChange(
    snapshot: SkillResourceSnapshot,
    events?: readonly ResourceChangeEvent[],
  ): Promise<void> {
    // A failed subscriber must not let disposal outlive another subscriber.
    const results = await Promise.allSettled(
      [...this.listeners].map(async (listener) =>
        listener(
          events?.map((event) => ({ ...event })),
          cloneSkillSnapshot(snapshot),
        ),
      ),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

export interface SkillResourceOptions {
  load: (reload: boolean) => Promise<SkillProviderContribution>;
  reloadMode: 'join' | 'queue';
  disposedError?: string;
  retainContribution?: boolean;
}

/** One scope's Skill snapshot and refresh notifications. Paths and watch policy belong to its owner. */
export class SkillResource extends SkillCandidateView {
  private queue: Promise<void> = Promise.resolve();
  private readonly notifications = new Set<Promise<void>>();
  private committedContribution?: SkillProviderContribution;
  private stopped = false;

  constructor(private readonly options: SkillResourceOptions) {
    super();
  }

  /** Raw candidates corresponding to the committed normalized snapshot. */
  getCommittedContribution(): SkillProviderContribution | undefined {
    return this.committedContribution;
  }

  initialize(): Promise<void> {
    return this.refresh({ notify: false, reload: false });
  }

  reload(
    options: { notify?: boolean; events?: readonly ResourceChangeEvent[] } = {},
  ): Promise<void> {
    return this.refresh({ ...options, reload: true });
  }

  /** The shared source already scanned the changed directory. */
  refreshFromSource(events: readonly ResourceChangeEvent[]): Promise<void> {
    return this.refresh({ events, reload: false });
  }

  private refresh(options: {
    notify?: boolean;
    events?: readonly ResourceChangeEvent[];
    reload: boolean;
  }): Promise<void> {
    if (this.stopped) {
      return Promise.reject(
        new Error(this.options.disposedError ?? 'SkillResource is disposed'),
      );
    }
    const read = async () => {
      const contribution = await this.options.load(options.reload);
      this.replace({
        discoveredSkills: normalizeSkillCandidates(
          contribution.skills,
          contribution.source,
        ),
        loadErrors: contribution.loadErrors,
      });
      if (this.options.retainContribution) this.committedContribution = contribution;
      return this.snapshot;
    };
    const refresh =
      this.options.reloadMode === 'queue' ? this.queue.then(read) : read();
    this.queue = refresh.then(
      () => undefined,
      () => undefined,
    );
    if (options.notify === false) return refresh.then(() => undefined);
    const notification = refresh.then((snapshot) =>
      this.notifyDidChange(snapshot, options.events),
    );
    const tracked = notification.then(
      () => undefined,
      () => undefined,
    );
    this.notifications.add(tracked);
    void tracked.then(() => this.notifications.delete(tracked));
    return notification;
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.queue, ...this.notifications]);
  }
}

export function cloneSkillDefinition(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    allowedTools: skill.allowedTools ? [...skill.allowedTools] : undefined,
    arguments: skill.arguments?.map((argument) => ({ ...argument })),
    // hooks values are unknown-typed and loader-produced plain data; a
    // shallow copy preserves the previous defensive-copy boundary without
    // guessing a deep structure. Nested mutation of a hook value remains
    // possible, as it was before the split.
    hooks: skill.hooks ? { ...skill.hooks } : undefined,
    paths: skill.paths ? [...skill.paths] : undefined,
    alsoDefinedAt: skill.alsoDefinedAt ? [...skill.alsoDefinedAt] : undefined,
  };
}

function cloneSkillSnapshot(
  snapshot: SkillResourceSnapshot,
): SkillResourceSnapshot {
  return {
    discoveredSkills: snapshot.discoveredSkills.map(cloneSkillDefinition),
    loadErrors: snapshot.loadErrors.map((error) => ({ ...error })),
  };
}
