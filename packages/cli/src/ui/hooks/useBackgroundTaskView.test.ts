/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  TaskRegistry,
  agentRegister,
  monitorRegister,
  shellRegister,
  type Config,
} from '@qwen-code/qwen-code-core';
import { useBackgroundTaskView, entryId } from './useBackgroundTaskView.js';

interface FakeMemoryManager {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  /** Captured opts from the most recent subscribe() call (the dream
   * adapter passes `{ taskType: 'dream' }` to skip per-extract
   * notifies). */
  lastSubscribeOpts: { taskType?: 'extract' | 'dream' } | undefined;
  /** Test helper — invokes the currently-subscribed listener. */
  fire: () => void;
}

function makeFakeMemoryManager(
  listTasksByType: () => unknown[],
): FakeMemoryManager {
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
  return Object.assign(
    {
      subscribe,
      unsubscribe,
      get lastSubscribeOpts() {
        return ref.lastSubscribeOpts;
      },
      fire: () => listener?.(),
    },
    {
      listTasksByType,
    },
  ) as FakeMemoryManager & { listTasksByType: typeof listTasksByType };
}

function makeConfig(
  registry: TaskRegistry,
  dreams: () => unknown[] = () => [],
) {
  const memoryMgr = makeFakeMemoryManager(dreams);
  const config = {
    getTaskRegistry: () => registry,
    getMemoryManager: () => memoryMgr,
    getProjectRoot: () => '/test/project',
  } as unknown as Config;
  return { config, memoryMgr };
}

const agentReg = (id: string, startTime: number) => ({
  agentId: id,
  description: 'desc',
  isBackgrounded: true,
  status: 'running' as const,
  startTime,
  abortController: new AbortController(),
  outputFile: '/tmp/agent.jsonl',
});

const shellReg = (id: string, startTime: number) => ({
  shellId: id,
  command: 'sleep 60',
  cwd: '/tmp',
  status: 'running' as const,
  startTime,
  outputPath: '/tmp/x.out',
  abortController: new AbortController(),
});

const monitorReg = (id: string, startTime: number) => ({
  monitorId: id,
  description: 'watch logs',
  command: 'tail -f log',
  status: 'running' as const,
  startTime,
  abortController: new AbortController(),
  eventCount: 0,
  lastEventTime: 0,
  maxEvents: 1000,
  idleTimeoutMs: 300_000,
  droppedLines: 0,
  outputFile: '/tmp/monitor.log',
});

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

  it('merges agent, shell, and monitor entries from the unified registry on mount', () => {
    const registry = new TaskRegistry();
    agentRegister(registry, agentReg('a1', 100));
    shellRegister(registry, shellReg('s1', 50));
    monitorRegister(registry, monitorReg('m1', 200));
    const { config } = makeConfig(registry);
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toHaveLength(3);
    expect(result.current.entries.map(entryId)).toEqual(['s1', 'a1', 'm1']);
  });

  it('tags each merged entry with the right `kind` discriminator', () => {
    const registry = new TaskRegistry();
    agentRegister(registry, agentReg('a1', 0));
    shellRegister(registry, shellReg('s1', 0));
    monitorRegister(registry, monitorReg('m1', 0));
    const { config } = makeConfig(registry);
    const { result } = renderHook(() => useBackgroundTaskView(config));
    const kinds = result.current.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(['agent', 'monitor', 'shell']);
  });

  it('refreshes entries when the registry fires a change', () => {
    const registry = new TaskRegistry();
    const { config } = makeConfig(registry);
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toEqual([]);

    act(() => {
      agentRegister(registry, agentReg('a1', 100));
    });
    expect(result.current.entries.map(entryId)).toEqual(['a1']);

    act(() => {
      monitorRegister(registry, monitorReg('m1', 50));
    });
    expect(result.current.entries.map(entryId)).toEqual(['m1', 'a1']);
  });

  it('clears the registry subscription and the dream subscription on unmount', () => {
    const registry = new TaskRegistry();
    const { config, memoryMgr } = makeConfig(registry);
    const { unmount } = renderHook(() => useBackgroundTaskView(config));
    unmount();
    expect(memoryMgr.subscribe).toHaveBeenCalledTimes(1);
    expect(memoryMgr.unsubscribe).toHaveBeenCalledTimes(1);
    // After unmount, registry mutations must not throw or update state.
    // The hook's cleanup unregisters the listener; if it didn't, this
    // would log a "setState on unmounted component" warning.
    expect(() => agentRegister(registry, agentReg('a-late', 0))).not.toThrow();
  });

  it('surfaces dream tasks and skips pending/skipped records', () => {
    const registry = new TaskRegistry();
    const dreams = () => [
      dream('d-pending', 100, { status: 'pending' }),
      dream('d-running', 200),
      dream('d-skipped', 300, { status: 'skipped' }),
    ];
    const { config } = makeConfig(registry, dreams);
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toHaveLength(1);
    const [only] = result.current.entries;
    expect(only.kind).toBe('dream');
    expect(entryId(only)).toBe('d-running');
  });

  it('caps retained terminal dream entries at MAX_RETAINED_TERMINAL_DREAMS = 3', () => {
    const registry = new TaskRegistry();
    const dreams = () => [
      dream('d-1', 100, { status: 'completed' }),
      dream('d-2', 200, { status: 'completed' }),
      dream('d-3', 300, { status: 'completed' }),
      dream('d-4', 400, { status: 'completed' }),
      dream('d-5', 500, { status: 'completed' }),
    ];
    const { config } = makeConfig(registry, dreams);
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toHaveLength(3);
    // Most-recent-first by updatedAt → d-5, d-4, d-3 (sorted by
    // startTime ascending in the merged output).
    expect(result.current.entries.map(entryId).sort()).toEqual([
      'd-3',
      'd-4',
      'd-5',
    ]);
  });

  it('subscribes to MemoryManager dream events with `{ taskType: dream }`', () => {
    const registry = new TaskRegistry();
    const { config, memoryMgr } = makeConfig(registry);
    renderHook(() => useBackgroundTaskView(config));
    expect(memoryMgr.subscribe).toHaveBeenCalledWith(expect.any(Function), {
      taskType: 'dream',
    });
  });

  it('refreshes entries when MemoryManager dream subscription fires', () => {
    const registry = new TaskRegistry();
    let dreamRecords: Array<ReturnType<typeof dream>> = [];
    const { config, memoryMgr } = makeConfig(registry, () => dreamRecords);
    const { result } = renderHook(() => useBackgroundTaskView(config));
    expect(result.current.entries).toEqual([]);

    dreamRecords = [dream('d-1', 100)];
    act(() => memoryMgr.fire());
    expect(result.current.entries.map(entryId)).toEqual(['d-1']);
  });
});
