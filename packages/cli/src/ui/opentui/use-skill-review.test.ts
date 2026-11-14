// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { MemoryTaskRecord } from '@qwen-code/qwen-code-core/memory/manager.js';
import { useSkillReview } from './use-skill-review.js';

function fixture() {
  let project = '/project';
  let session = 'A';
  let enabled = true;
  let notify = () => {};
  const tasks = [
    {
      id: 'task',
      projectRoot: project,
      metadata: {
        pendingSkills: [
          {
            name: 'alpha',
            description: 'A',
            stagedManifestPath: '/pending/alpha/SKILL.md',
          },
        ],
      },
    },
  ] as unknown as MemoryTaskRecord[];
  const unsubscribe = vi.fn();
  const manager = {
    listTasksByType: vi.fn(() => tasks),
    getTask: vi.fn((id: string) => tasks.find((task) => task.id === id)),
    subscribe: vi.fn((listener: () => void) => {
      notify = listener;
      return unsubscribe;
    }),
  };
  const config = {
    getMemoryManager: () => manager,
    getProjectRoot: () => project,
    getSessionId: () => session,
    getWorkingDir: () => project,
    getAutoSkillEnabled: () => enabled,
  } as unknown as Config;
  return {
    config,
    manager,
    tasks,
    unsubscribe,
    notify: () => act(() => notify()),
    project: (value: string) => {
      project = value;
    },
    session: (value: string) => {
      session = value;
    },
    enabled: (value: boolean) => {
      enabled = value;
    },
  };
}

describe('useSkillReview', () => {
  it('blocks a selected pending record synchronously before a React notification', () => {
    const f = fixture();
    f.tasks.length = 0;
    const view = renderHook(() => useSkillReview(f.config));
    expect(view.result.current.canDrain()).toBe(true);
    f.tasks.push({
      id: 'late',
      projectRoot: '/project',
      metadata: {
        pendingSkills: [
          {
            name: 'late',
            description: 'L',
            stagedManifestPath: '/pending/late/SKILL.md',
          },
        ],
      },
    } as unknown as MemoryTaskRecord);
    expect(view.result.current.pending).toBeNull();
    expect(view.result.current.canDrain()).toBe(false);
    f.notify();
    view.result.current.pending!.dismiss();
    expect(view.result.current.canDrain()).toBe(true);
    f.tasks[0]!.id = 'other';
    expect(view.result.current.canDrain()).toBe(false);
    f.enabled(false);
    expect(view.result.current.canDrain()).toBe(true);
  });
  it('keeps a preempting UI owner blocked after task completion and rejects stale UI setters', () => {
    const f = fixture();
    const view = renderHook(() => useSkillReview(f.config));
    const oldSetter = view.result.current.setUiBlocked;
    oldSetter(true);
    f.tasks.length = 0;
    f.notify();
    expect(view.result.current.canDrain()).toBe(false);
    view.result.current.setUiBlocked(false);
    expect(view.result.current.canDrain()).toBe(true);
    f.session('B');
    view.rerender();
    oldSetter(true);
    expect(view.result.current.canDrain()).toBe(true);
  });
  it('loads and subscribes only to the selected project and review task type', () => {
    const f = fixture();
    const view = renderHook(() => useSkillReview(f.config));
    expect(f.manager.listTasksByType).toHaveBeenCalledWith(
      'skill-review',
      '/project',
    );
    expect(f.manager.subscribe).toHaveBeenCalledWith(expect.any(Function), {
      taskType: 'skill-review',
    });
    expect(view.result.current.pending?.skills[0]?.name).toBe('alpha');
    view.unmount();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it('projects path changes with the same name and removes an emptied task', () => {
    const f = fixture();
    const view = renderHook(() => useSkillReview(f.config));
    f.tasks[0]!.metadata!['pendingSkills'] = [
      {
        name: 'alpha',
        description: 'changed',
        stagedManifestPath: '/new/SKILL.md',
      },
    ];
    f.notify();
    expect(view.result.current.pending?.skills[0]?.stagedManifestPath).toBe(
      '/new/SKILL.md',
    );
    f.tasks[0]!.metadata!['pendingSkills'] = [];
    f.notify();
    expect(view.result.current.pending).toBeNull();
  });
  it('dismisses a task for this owner without discarding a different task', () => {
    const f = fixture();
    const view = renderHook(() => useSkillReview(f.config));
    const first = view.result.current.pending!;
    first.dismiss();
    expect(first.isDismissed()).toBe(true);
    f.tasks.unshift({ ...f.tasks[0]!, id: 'next' });
    f.notify();
    expect(view.result.current.pending?.task.id).toBe('next');
    expect(view.result.current.pending?.isDismissed()).toBe(false);
    view.result.current.pending!.dismiss();
    f.tasks.reverse();
    f.notify();
    expect(view.result.current.pending?.task.id).toBe('task');
    expect(view.result.current.pending?.isDismissed()).toBe(true);
  });
  it('permanently revokes a getter-only ABA and old callbacks cannot dismiss the successor', () => {
    const f = fixture();
    const view = renderHook(() => useSkillReview(f.config));
    const old = view.result.current.pending!;
    f.session('B');
    expect(old.isCurrent()).toBe(false);
    f.session('A');
    expect(old.isCurrent()).toBe(false);
    view.rerender();
    expect(view.result.current.pending).toBeNull();
    f.session('B');
    view.rerender();
    const successor = view.result.current.pending!;
    old.dismiss();
    expect(successor.isDismissed()).toBe(false);
    expect(successor.isCurrent()).toBe(true);
  });
  it('revokes a subscriber-observed record ABA without sampling the old getter during B', () => {
    const f = fixture();
    const view = renderHook(() => useSkillReview(f.config));
    const original = f.tasks[0]!;
    const oldA = view.result.current.pending!;
    const authority = view.result.current.canDrain;
    f.tasks[0] = { ...original };
    f.notify();
    f.tasks[0] = original;
    f.notify();
    const newA = view.result.current.pending!;
    expect(oldA.isCurrent()).toBe(false);
    oldA.dismiss();
    expect(newA.isCurrent()).toBe(true);
    expect(newA.isDismissed()).toBe(false);
    expect(view.result.current.canDrain).toBe(authority);
    original.metadata!['pendingSkills'] = [
      {
        name: 'alpha',
        description: 'same record update',
        stagedManifestPath: '/pending/alpha/SKILL.md',
      },
    ];
    f.notify();
    expect(newA.isCurrent()).toBe(true);
    expect(view.result.current.pending?.isCurrent()).toBe(true);
    expect(view.result.current.canDrain).toBe(authority);
  });
  it('gives a batched record ABA a fresh generation without changing queue authority', () => {
    const f = fixture();
    const view = renderHook(() => useSkillReview(f.config));
    const oldA = view.result.current.pending!;
    const original = f.tasks[0]!;
    const authority = view.result.current.canDrain;
    act(() => {
      f.tasks[0] = { ...original };
      f.notify();
      f.tasks[0] = original;
      f.notify();
    });
    const newA = view.result.current.pending!;
    expect(newA.generation).toBeGreaterThan(oldA.generation);
    expect(oldA.isCurrent()).toBe(false);
    expect(newA.isCurrent()).toBe(true);
    f.notify();
    expect(view.result.current.pending?.generation).toBe(newA.generation);
    expect(view.result.current.canDrain).toBe(authority);
    f.session('new owner');
    view.rerender();
    expect(view.result.current.pending!.generation).toBeGreaterThan(
      newA.generation,
    );
  });
  it('rejects a replaced record even with the same task id', () => {
    const f = fixture();
    const view = renderHook(() => useSkillReview(f.config));
    const old = view.result.current.pending!;
    const original = f.tasks[0]!;
    f.tasks[0] = { ...original };
    expect(old.isCurrent()).toBe(false);
    f.tasks[0] = original;
    expect(old.isCurrent()).toBe(false);
    f.tasks[0] = { ...original };
    f.notify();
    expect(view.result.current.pending).not.toBe(old);
    expect(view.result.current.pending?.isCurrent()).toBe(true);
  });
});
