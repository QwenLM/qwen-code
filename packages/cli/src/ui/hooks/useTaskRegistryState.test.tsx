/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import {
  TaskRegistry,
  type BashUnifiedTask,
} from '@qwen-code/core';
import { renderHook } from '../../test-utils/render.js';
import {
  useTaskRegistryState,
  useTaskRegistryVersion,
} from './useTaskRegistryState.js';

function createBashTask(id: string, startTime: number): BashUnifiedTask {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    description: 'background command',
    startTime,
    notified: false,
    executionId: Number(id.replace('b-', '')),
    completionBehavior: 'notify',
    command: 'echo test',
    isBackgrounded: true,
    output: '',
  };
}

describe('useTaskRegistryState', () => {
  it('keeps derived state references stable when the registry has not changed', async () => {
    const registry = new TaskRegistry();
    registry.register(createBashTask('b-1', 1));

    const { result, rerender, unmount } = await renderHook(() =>
      useTaskRegistryState(registry),
    );

    const state = result.current;
    const tasks = result.current.tasks;

    rerender();

    expect(result.current).toBe(state);
    expect(result.current.tasks).toBe(tasks);
    unmount();
  });

  it('refreshes derived state when registry tasks change', async () => {
    const registry = new TaskRegistry();
    const { result, unmount } = await renderHook(() =>
      useTaskRegistryState(registry),
    );

    act(() => {
      registry.register(createBashTask('b-1', 1));
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.runningCount).toBe(1);
    unmount();
  });

  it('increments version when a viewed task changes', async () => {
    const registry = new TaskRegistry();
    const { result, unmount } = await renderHook(() =>
      useTaskRegistryVersion(registry),
    );
    const initialVersion = result.current;

    act(() => {
      registry.register(createBashTask('b-1', 1));
    });

    expect(result.current).toBeGreaterThan(initialVersion);
    unmount();
  });
});
