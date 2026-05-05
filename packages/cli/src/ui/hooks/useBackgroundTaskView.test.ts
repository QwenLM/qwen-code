/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import { useBackgroundTaskView, entryId } from './useBackgroundTaskView.js';

interface FakeRegistry {
  setStatusChangeCallback: ReturnType<typeof vi.fn>;
  /** Test helper — invokes the currently-set callback. */
  fire: () => void;
}

function makeFakeRegistry(): FakeRegistry {
  let cb: (() => void) | undefined;
  return {
    setStatusChangeCallback: vi.fn((next: (() => void) | undefined) => {
      cb = next;
    }),
    fire: () => cb?.(),
  };
}

interface FakeMemoryManager {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  /** Captured opts from the most recent subscribe() call (the hook
   * passes `{ taskType: 'dream' }` to skip per-extract notifies). */
  lastSubscribeOpts: { taskType?: 'extract' | 'dream' } | undefined;
  /** Test helper — invokes the currently-subscribed listener. */
  fire: () => void;
}

function makeFakeMemoryManager(): FakeMemoryManager {
  let listener: (() => void) | undefined;
  const ref: { lastSubscribeOpts: FakeMemoryManager['lastSubscribeOpts'] } = {
    lastSubscribeOpts: undefined,
  };
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const subscribe = vi.fn(
    (next: () => void, opts?: { taskType?: 'extract' | 'dream' }) => {
      listener = next;
      ref.lastSubscribeOpts = opts;
      return unsubscribe;
    },
  );
  return {
    subscribe,
    unsubscribe,
    get lastSubscribeOpts() {
      return ref.lastSubscribeOpts;
    },
    fire: () => listener?.(),
  };
}

function makeConfig(opts: {
  agents: () => unknown[];
  shells: () => unknown[];
  monitors: () => unknown[];
  dreams?: () => unknown[];
}) {
  const agentReg = makeFakeRegistry();
  const shellReg = makeFakeRegistry();
  const monitorReg = makeFakeRegistry();
  const memoryMgr = makeFakeMemoryManager();
  const dreams = opts.dreams ?? (() => []);

  const config = {
    getBackgroundTaskRegistry: () => ({
      ...agentReg,
      getAll: opts.agents,
    }),
    getBackgroundShellRegistry: () => ({
      ...shellReg,
      getAll: opts.shells,
    }),
    getMonitorRegistry: () => ({
      ...monitorReg,
      getAll: opts.monitors,
    }),
    getMemoryManager: () => ({
      subscribe: memoryMgr.subscribe,
      // Hook only ever requests dream-typed records; ignore the type arg
      // and return whatever the test provided.
      listTasksByType: (_type: string, _projectRoot?: string) => dreams(),
    }),
    getProjectRoot: () => '/test/project',
  } as unknown as Config;

  return { config, agentReg, shellReg, monitorReg, memoryMgr };
}

const agent = (id: string, startTime: number) => ({
  agentId: id,
  description: 'desc',
  status: 'running' as const,
  startTime,
  abortController: new AbortController(),
});

const shell = (id: string, startTime: number) => ({
  shellId: id,
  command: 'sleep 60',
  cwd: '/tmp',
  status: 'running' as const,
  startTime,
  outputPath: '/tmp/x.out',
  abortController: new AbortController(),
});

const monitor = (id: string, startTime: number) => ({
  monitorId: id,
  command: 'tail -f log',
  description: 'watch logs',
  status: 'running' as const,
  startTime,
  abortController: new AbortController(),
  eventCount: 0,
  lastEventTime: 0,
  maxEvents: 1000,
  idleTimeoutMs: 300_000,
  droppedLines: 0,
});

// Mirror the MemoryTaskRecord shape that MemoryManager.listTasksByType
// returns. Status defaults to 'running'; tests override to exercise the
// filter (`pending` / `skipped` records must be excluded; `cancelled`
// flows through the same terminal-cap path as `completed` / `failed`
// once the task_stop / dialog cancel keystroke lands one).
const dream = (
  id: string,
  startTimeMs: number,
  overrides: Partial<{
    status:
      | 'pending'
      | 'running'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'skipped';
    progressText: string;
    error: string;
    metadata: Record<string, unknown>;
  }> = {},
) => ({
  id,
  taskType: 'dream' as const,
  projectRoot: '/test/project',
  status: overrides.status ?? ('running' as const),
  createdAt: new Date(startTimeMs).toISOString(),
  updatedAt: new Date(startTimeMs).toISOString(),
  progressText: overrides.progressText,
  error: overrides.error,
  metadata: overrides.metadata,
});

describe('useBackgroundTaskView', () => {
  it('returns empty entries when config is null', () => {
    const { result } = renderHook(() => useBackgroundTaskView(null));
    expect(result.current.entries).toEqual([]);
  });

  it('merges entries from all three registries on mount', () => {
    const { config } = makeConfig({
      agents: () => [agent('a1', 100)],
      shells: () => [shell('s1', 50)],
      monitors: () => [monitor('m1', 200)],
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toHaveLength(3);
    // Sort order is by startTime ascending — shell (50) → agent (100) → monitor (200).
    expect(result.current.entries.map(entryId)).toEqual(['s1', 'a1', 'm1']);
  });

  it('tags each merged entry with the right `kind` discriminator', () => {
    const { config } = makeConfig({
      agents: () => [agent('a1', 0)],
      shells: () => [shell('s1', 0)],
      monitors: () => [monitor('m1', 0)],
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    const kinds = result.current.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(['agent', 'monitor', 'shell']);
  });

  it('subscribes to all three registries on mount', () => {
    const { config, agentReg, shellReg, monitorReg } = makeConfig({
      agents: () => [],
      shells: () => [],
      monitors: () => [],
    });
    renderHook(() => useBackgroundTaskView(config));
    expect(agentReg.setStatusChangeCallback).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(shellReg.setStatusChangeCallback).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(monitorReg.setStatusChangeCallback).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });

  it('refreshes entries when any registry fires statusChange', () => {
    const agents: Array<ReturnType<typeof agent>> = [];
    const monitors: Array<ReturnType<typeof monitor>> = [];
    const { config, agentReg, monitorReg } = makeConfig({
      agents: () => agents,
      shells: () => [],
      monitors: () => monitors,
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toEqual([]);

    // Simulate registry mutation + statusChange fire from each registry.
    agents.push(agent('a1', 100));
    act(() => agentReg.fire());
    expect(result.current.entries.map(entryId)).toEqual(['a1']);

    monitors.push(monitor('m1', 50));
    act(() => monitorReg.fire());
    // monitor's startTime (50) sorts before agent's (100).
    expect(result.current.entries.map(entryId)).toEqual(['m1', 'a1']);
  });

  it('clears all three subscriptions on unmount', () => {
    const { config, agentReg, shellReg, monitorReg, memoryMgr } = makeConfig({
      agents: () => [],
      shells: () => [],
      monitors: () => [],
    });
    const { unmount } = renderHook(() => useBackgroundTaskView(config));
    unmount();
    // Each setStatusChangeCallback should have been called twice — once
    // with the refresh function on mount, once with `undefined` on
    // cleanup. Failing this check would mean stale subscribers can fire
    // into an unmounted component (warning + state-update on unmounted
    // tree, sometimes crashes the next render).
    expect(agentReg.setStatusChangeCallback.mock.calls).toEqual([
      [expect.any(Function)],
      [undefined],
    ]);
    expect(shellReg.setStatusChangeCallback.mock.calls).toEqual([
      [expect.any(Function)],
      [undefined],
    ]);
    expect(monitorReg.setStatusChangeCallback.mock.calls).toEqual([
      [expect.any(Function)],
      [undefined],
    ]);
    // MemoryManager uses subscribe()/unsubscribe rather than the
    // setCallback pattern; the unsubscribe returned from subscribe must
    // run on cleanup or stale dream listeners leak across remounts.
    expect(memoryMgr.subscribe).toHaveBeenCalledTimes(1);
    expect(memoryMgr.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('surfaces dream tasks with kind=dream and skips pending/skipped records', () => {
    const { config } = makeConfig({
      agents: () => [],
      shells: () => [],
      monitors: () => [],
      // Three dream records covering: a pre-fire pending record (must
      // not surface — would flood the dialog with one row per
      // UserQuery), a running fire (must surface), and a skipped
      // gate-miss (must not surface — same flood concern).
      dreams: () => [
        dream('d-pending', 100, { status: 'pending' }),
        dream('d-running', 200),
        dream('d-skipped', 300, { status: 'skipped' }),
      ],
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toHaveLength(1);
    const [only] = result.current.entries;
    expect(only.kind).toBe('dream');
    expect(only.status).toBe('running');
    expect(entryId(only)).toBe('d-running');
  });

  it('caps retained terminal dream entries at 3 most-recent (by updatedAt) plus all running', () => {
    // MemoryManager has no eviction; without the cap, accumulating
    // completed dreams across a long session would blow up the dialog.
    // The cap keeps the dialog glanceable while still surfacing the
    // most recent outcomes (mirrors MonitorRegistry's terminal cap).
    const baseMs = Date.parse('2026-05-04T12:00:00.000Z');
    const completed = (id: string, mtime: number) => ({
      id,
      taskType: 'dream' as const,
      projectRoot: '/test/project',
      status: 'completed' as const,
      createdAt: new Date(baseMs + mtime - 1000).toISOString(),
      updatedAt: new Date(baseMs + mtime).toISOString(),
    });
    const { config } = makeConfig({
      agents: () => [],
      shells: () => [],
      monitors: () => [],
      dreams: () => [
        completed('d-old-1', 1_000),
        completed('d-old-2', 2_000),
        completed('d-mid', 3_000),
        completed('d-recent', 4_000),
        completed('d-newest', 5_000),
        // Plus a running entry that must always survive the cap (caps
        // only trim terminals; running dreams are uncapped).
        dream('d-running-now', baseMs + 6_000, { status: 'running' }),
      ],
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    const ids = result.current.entries.map(entryId).sort();
    // Surviving terminal entries: d-newest, d-recent, d-mid (top 3 by
    // updatedAt desc). The two oldest (d-old-1, d-old-2) get dropped.
    // The running dream survives unconditionally.
    expect(ids).toEqual(
      ['d-mid', 'd-newest', 'd-recent', 'd-running-now'].sort(),
    );
  });

  it('surfaces a cancelled dream with kind=dream so the dialog can render the terminal status', () => {
    // `'cancelled'` arrives via the dialog `x stop` / `task_stop` path
    // which routes through `MemoryManager.cancelTask`. The view-model
    // must accept it the same way it accepts `'completed'` / `'failed'`,
    // because the dialog's terminal-cap window depends on showing the
    // user the outcome of the abort they just triggered.
    const { config } = makeConfig({
      agents: () => [],
      shells: () => [],
      monitors: () => [],
      dreams: () => [dream('d-stopped', 100, { status: 'cancelled' })],
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toHaveLength(1);
    const [only] = result.current.entries;
    expect(only.kind).toBe('dream');
    expect(only.status).toBe('cancelled');
  });

  it('subscribes to MemoryManager with a dream taskType filter so extract notifies are skipped at the source', () => {
    // The taskType filter on MemoryManager.subscribe() is the
    // primary perf guard — it prevents the per-UserQuery extract
    // notify from waking the bg-tasks UI listener at all (avoids the
    // O(n) dream-snapshot fetch + signature compare that would
    // otherwise run on every extract transition). Pin the filter so
    // a future refactor that drops the opts arg fails the test
    // rather than silently re-introducing the wakeups.
    const { config, memoryMgr } = makeConfig({
      agents: () => [],
      shells: () => [],
      monitors: () => [],
    });
    renderHook(() => useBackgroundTaskView(config));
    expect(memoryMgr.subscribe).toHaveBeenCalledTimes(1);
    expect(memoryMgr.lastSubscribeOpts).toEqual({ taskType: 'dream' });
  });

  it('skips setEntries when the memory listener fires with unchanged dream content', () => {
    // MemoryManager.subscribe() fires for ALL task transitions, including
    // extract task records that have no dialog surface. Without the
    // dream-signature dedup, every extract notify would trigger a full
    // re-merge + a fresh array reference into setEntries — re-rendering
    // the dialog and pill on entries that are byte-identical to the
    // previous snapshot. This test pins the dedup by firing the memory
    // listener while the dream snapshot stays unchanged and asserting
    // that the entries reference is preserved.
    const dreams: Array<ReturnType<typeof dream>> = [dream('d-only', 100)];
    const { config, memoryMgr } = makeConfig({
      agents: () => [],
      shells: () => [],
      monitors: () => [],
      dreams: () => dreams,
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    const before = result.current.entries;
    expect(before.map(entryId)).toEqual(['d-only']);

    // Fire the memory listener without mutating `dreams`. With the
    // signature-dedup in place, this must NOT call setEntries; React
    // will then preserve the existing array reference.
    act(() => memoryMgr.fire());
    expect(result.current.entries).toBe(before);

    // Sanity check the inverse path: when dreams DO change, the
    // listener must propagate. A flipped status should change the
    // signature and force a fresh setEntries.
    dreams.splice(0, 1, dream('d-only', 100, { status: 'completed' }));
    act(() => memoryMgr.fire());
    expect(result.current.entries).not.toBe(before);
    expect(result.current.entries[0]?.status).toBe('completed');
  });

  it('refreshes entries when the memory manager fires its subscribe listener', () => {
    const dreams: Array<ReturnType<typeof dream>> = [];
    const { config, memoryMgr } = makeConfig({
      agents: () => [],
      shells: () => [],
      monitors: () => [],
      dreams: () => dreams,
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toEqual([]);

    dreams.push(dream('d-1', 100));
    act(() => memoryMgr.fire());
    expect(result.current.entries.map(entryId)).toEqual(['d-1']);

    // A subsequent terminal state update must propagate the new status
    // (running → completed) and survive the filter (only pending /
    // skipped get dropped).
    dreams.splice(0, dreams.length, dream('d-1', 100, { status: 'completed' }));
    act(() => memoryMgr.fire());
    const [only] = result.current.entries;
    expect(only.kind).toBe('dream');
    expect(only.status).toBe('completed');
  });
});
