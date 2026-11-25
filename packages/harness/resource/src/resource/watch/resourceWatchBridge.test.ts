/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  matchWatchTarget,
  ResourceWatchBridge,
  type KindRefreshPolicy,
  type WatchTarget,
} from './resourceWatchBridge.js';
import type {
  FileChangeEvent,
  FileChangeListener,
  FileWatcher,
} from '../../file-watcher/fileWatcher.js';
import type { ResourceChangeEvent } from '../core/types.js';

class StubFileWatcher implements FileWatcher {
  readonly isNoop = false;
  private readonly listeners = new Map<string, FileChangeListener>();

  watch(
    request: { path: string; recursive?: boolean },
    listener: FileChangeListener,
  ): () => void {
    this.listeners.set(request.path, listener);
    return () => this.listeners.delete(request.path);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async emit(
    path: string,
    operation: FileChangeEvent['operation'],
  ): Promise<void> {
    for (const [watchedPath, listener] of this.listeners) {
      if (path === watchedPath || path.startsWith(watchedPath + '/')) {
        await listener({ path, operation });
      }
    }
  }
}

describe('matchWatchTarget', () => {
  const targets: WatchTarget[] = [
    { kind: 'agent', source: 'user', path: '/home/.qwen/agents/review.md' },
    { kind: 'skill', source: 'project', path: '/repo/.qwen/skills' },
  ];

  it('matches exact file targets', () => {
    expect(matchWatchTarget('/home/.qwen/agents/review.md', targets)).toEqual(
      targets[0],
    );
  });

  it('matches files under directory targets', () => {
    expect(
      matchWatchTarget('/repo/.qwen/skills/review/SKILL.md', targets),
    ).toEqual(targets[1]);
  });

  it('does not match sibling prefixes', () => {
    expect(
      matchWatchTarget('/repo/.qwen/skills-extra/SKILL.md', targets),
    ).toBe(undefined);
  });
});

describe('refresh policies', () => {
  function makeBridge(policies: KindRefreshPolicy[]) {
    const fileWatcher = new StubFileWatcher();
    const bridge = new ResourceWatchBridge({
      targets: [
        { kind: 'skill', source: 'project', path: '/repo/.qwen/skills' },
      ],
      fileWatcher,
      refreshPolicies: policies,
    });
    return { bridge, fileWatcher };
  }

  it('coalesces bursts into one refresh batch', async () => {
    const refreshed: ResourceChangeEvent[][] = [];
    const policy: KindRefreshPolicy = {
      kinds: ['skill'],
      debounceMs: 50,
      refresh: (events) => {
        refreshed.push(events);
      },
    };
    const { bridge, fileWatcher } = makeBridge([policy]);
    await bridge.start();

    // Fire-and-forget like the real file watcher — events must coalesce.
    void fileWatcher.emit('/repo/.qwen/skills/a/SKILL.md', 'add');
    void fileWatcher.emit('/repo/.qwen/skills/b/SKILL.md', 'add');
    void fileWatcher.emit('/repo/.qwen/skills/c/SKILL.md', 'add');
    await new Promise((r) => setTimeout(r, 150));

    // One coalesced refresh covers all three file events.
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toHaveLength(3);
    await bridge.stop();
  });

  it('ignores kinds without a refresh policy', async () => {
    const { bridge, fileWatcher } = makeBridge([]);
    await bridge.start();

    await fileWatcher.emit('/repo/.qwen/skills/a/SKILL.md', 'change');

    await bridge.stop();
  });

  it('contains refresh failures so file watching can continue', async () => {
    const refresh = vi.fn(() => {
      throw new Error('boom');
    });
    const policy: KindRefreshPolicy = {
      kinds: ['skill'],
      refresh,
    };
    const { bridge, fileWatcher } = makeBridge([policy]);
    await bridge.start();

    await fileWatcher.emit('/repo/.qwen/skills/a/SKILL.md', 'change');

    expect(refresh).toHaveBeenCalledOnce();
    await bridge.stop();
  });

  it('resolves every coalesced watcher callback', async () => {
    const policy: KindRefreshPolicy = {
      kinds: ['skill'],
      debounceMs: 25,
      refresh: () => undefined,
    };
    const { bridge, fileWatcher } = makeBridge([policy]);
    await bridge.start();

    await Promise.all([
      fileWatcher.emit('/repo/.qwen/skills/a/SKILL.md', 'add'),
      fileWatcher.emit('/repo/.qwen/skills/b/SKILL.md', 'add'),
    ]);

    await bridge.stop();
  });
});
