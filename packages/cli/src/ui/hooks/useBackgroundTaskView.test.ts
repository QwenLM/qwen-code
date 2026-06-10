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
  setApprovalChangeCallback: ReturnType<typeof vi.fn>;
  /** Test helper — invokes the currently-set status callback. */
  fire: () => void;
  /** Test helper — invokes the currently-set approval callback. */
  fireApproval: () => void;
}

function makeFakeRegistry(): FakeRegistry {
  let cb: (() => void) | undefined;
  let approvalCb: (() => void) | undefined;
  return {
    setStatusChangeCallback: vi.fn((next: (() => void) | undefined) => {
      cb = next;
    }),
    setApprovalChangeCallback: vi.fn((next: (() => void) | undefined) => {
      approvalCb = next;
    }),
    fire: () => cb?.(),
    fireApproval: () => approvalCb?.(),
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

type StatusOverride = {
  status?: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  endTime?: number;
};

const agent = (
  id: string,
  startTime: number,
  overrides: StatusOverride = {},
) => ({
  id,
  kind: 'agent' as const,
  agentId: id,
  description: 'desc',
  isBackgrounded: true,
  status: overrides.status ?? ('running' as const),
  startTime,
  endTime: overrides.endTime,
  abortController: new AbortController(),
  outputFile: '/tmp/agent.jsonl',
  outputOffset: 0,
  notified: false,
});

const shell = (
  id: string,
  startTime: number,
  overrides: Omit<StatusOverride, 'status'> & {
    status?: 'running' | 'completed' | 'failed' | 'cancelled';
  } = {},
) => ({
  id,
  kind: 'shell' as const,
  shellId: id,
  command: 'sleep 60',
  description: 'sleep 60',
  cwd: '/tmp',
  status: overrides.status ?? ('running' as const),
  startTime,
  endTime: overrides.endTime,
  outputPath: '/tmp/x.out',
  outputFile: '/tmp/x.out',
  outputOffset: 0,
  notified: false,
  abortController: new AbortController(),
});

const monitor = (
  id: string,
  startTime: number,
  overrides: Omit<StatusOverride, 'status'> & {
    status?: 'running' | 'completed' | 'failed' | 'cancelled';
  } = {},
) => ({
  id,
  kind: 'monitor' as const,
  monitorId: id,
  command: 'tail -f log',
  description: 'watch logs',
  status: overrides.status ?? ('running' as const),
  startTime,
  endTime: overrides.endTime,
  abortController: new AbortController(),
  eventCount: 0,
  lastEventTime: 0,
  maxEvents: 1000,
  idleTimeoutMs: 300_000,
  droppedLines: 0,
  outputFile: '/tmp/monitor.log',
  outputOffset: 0,
  notified: false,
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
    // Sort order is by startTime descending — newest first: monitor
    // (200) → agent (100) → shell (50). The dialog opens with the
    // cursor on row 0, so the most recently launched task is the one
    // immediately selected.
    expect(result.current.entries.map(entryId)).toEqual(['m1', 'a1', 's1']);
  });

  it('orders entries newest-first across all kinds', () => {
    // Pin the descending sort so a future refactor that flips the
    // comparator silently re-introduces the "new task buried at the
    // bottom of a long list" UX. Mix all four kinds at varying
    // startTimes to exercise the merge path end-to-end.
    const { config } = makeConfig({
      agents: () => [agent('a-old', 10), agent('a-new', 400)],
      shells: () => [shell('s-mid', 200)],
      monitors: () => [monitor('m-second-newest', 300)],
      dreams: () => [dream('d-oldest', 5)],
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries.map(entryId)).toEqual([
      'a-new',
      'm-second-newest',
      's-mid',
      'a-old',
      'd-oldest',
    ]);
  });

  it('puts active (running + paused) entries above terminal entries even when terminals are newer', () => {
    // The literal phrasing of the issue is "new OR running tasks
    // should appear at the top". A pure startTime DESC sort handles
    // the "new" half but lets a long-running entry get buried under a
    // batch of newer terminals (a quick agent that started AND
    // finished after the long one). Pin the bucket order so the user
    // opening the dialog to check on running work doesn't have to
    // scroll past stale completed rows to find it.
    const { config } = makeConfig({
      agents: () => [
        // Old running agent — must NOT be pushed below newer terminals.
        agent('a-running-old', 100),
        // Recently-completed agent — newer startTime than the running
        // one, but should still sort below it because it's terminal.
        agent('a-done-fresh', 500, { status: 'completed', endTime: 600 }),
        // Paused agent — same bucket as running (user can resume /
        // abandon), ranks by startTime DESC inside the bucket.
        agent('a-paused', 300, { status: 'paused' }),
      ],
      shells: () => [
        // Failed shell launched in between the two active agents —
        // belongs in the terminal bucket regardless of startTime.
        shell('s-failed', 400, { status: 'failed', endTime: 450 }),
      ],
      monitors: () => [],
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries.map(entryId)).toEqual([
      // Active bucket (startTime DESC): paused (300), running (100).
      'a-paused',
      'a-running-old',
      // Terminal bucket (endTime DESC): a-done-fresh (600), s-failed (450).
      'a-done-fresh',
      's-failed',
    ]);
  });

  it('orders the terminal bucket by endTime DESC (not startTime)', () => {
    // A long-running task that just settled is more "interesting" to
    // a returning user than an old quick task that finished hours
    // ago, even if the latter has a higher startTime.
    const { config } = makeConfig({
      agents: () => [
        // Started early, just finished — most recent terminal event.
        agent('a-just-finished', 100, {
          status: 'completed',
          endTime: 1_000,
        }),
        // Started later, finished early — older terminal event.
        agent('a-quick-and-old', 500, {
          status: 'completed',
          endTime: 600,
        }),
      ],
      shells: () => [],
      monitors: () => [],
    });
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries.map(entryId)).toEqual([
      'a-just-finished',
      'a-quick-and-old',
    ]);
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
    // Sort is descending by startTime: agent (100) sits above monitor
    // (50) because the user wants the newest entry on top.
    expect(result.current.entries.map(entryId)).toEqual(['a1', 'm1']);
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
