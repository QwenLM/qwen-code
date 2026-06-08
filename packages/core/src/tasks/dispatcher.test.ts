/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  registerTaskKind,
  getTaskByType,
  _resetTaskKindsForTest,
  type Task,
  type TaskKind,
} from './dispatcher.js';

function makeTask(kind: TaskKind, name = `${kind}-task`): Task {
  return { kind, name, kill: vi.fn() };
}

describe('dispatcher', () => {
  afterEach(() => {
    _resetTaskKindsForTest();
  });

  it('getTaskByType returns the Task registered for a kind', () => {
    const task = makeTask('agent');
    registerTaskKind(task);
    expect(getTaskByType('agent')).toBe(task);
  });

  it('routes each kind to its own Task independently', () => {
    const tasks: Record<TaskKind, Task> = {
      agent: makeTask('agent'),
      shell: makeTask('shell'),
      monitor: makeTask('monitor'),
      dream: makeTask('dream'),
    };
    for (const task of Object.values(tasks)) registerTaskKind(task);

    expect(getTaskByType('agent')).toBe(tasks.agent);
    expect(getTaskByType('shell')).toBe(tasks.shell);
    expect(getTaskByType('monitor')).toBe(tasks.monitor);
    expect(getTaskByType('dream')).toBe(tasks.dream);
  });

  it('throws a descriptive error for an unregistered kind', () => {
    expect(() => getTaskByType('agent')).toThrowError(
      /no Task registered for kind 'agent'/,
    );
  });

  it('re-registering a kind overwrites the prior Task (idempotent swap)', () => {
    const first = makeTask('monitor', 'first');
    const second = makeTask('monitor', 'second');
    registerTaskKind(first);
    registerTaskKind(second);
    expect(getTaskByType('monitor')).toBe(second);
  });

  it('_resetTaskKindsForTest clears every registered kind', () => {
    registerTaskKind(makeTask('agent'));
    registerTaskKind(makeTask('shell'));

    _resetTaskKindsForTest();

    expect(() => getTaskByType('agent')).toThrow();
    expect(() => getTaskByType('shell')).toThrow();
  });
});
