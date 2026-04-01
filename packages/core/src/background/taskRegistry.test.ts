/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BackgroundTaskRegistry } from './taskRegistry.js';

describe('BackgroundTaskRegistry', () => {
  it('registers and updates background tasks', () => {
    const registry = new BackgroundTaskRegistry();
    const task = registry.register({
      taskType: 'memory-extract',
      title: 'Extract memory',
      projectRoot: '/tmp/project',
    });

    expect(task.status).toBe('pending');

    const updated = registry.update(task.id, {
      status: 'running',
      progressText: 'Planning patches',
      metadata: { attempt: 1 },
    });

    expect(updated.status).toBe('running');
    expect(updated.progressText).toBe('Planning patches');
    expect(updated.metadata).toEqual({ attempt: 1 });
  });

  it('emits task snapshots to listeners', () => {
    const registry = new BackgroundTaskRegistry();
    const events: string[] = [];
    const unsubscribe = registry.subscribe((task) => {
      events.push(`${task.status}:${task.title}`);
    });

    const task = registry.register({
      taskType: 'memory-dream',
      title: 'Dream memory',
      projectRoot: '/tmp/project',
    });
    registry.update(task.id, { status: 'completed' });
    unsubscribe();
    registry.update(task.id, { progressText: 'ignored after unsubscribe' });

    expect(events).toEqual(['pending:Dream memory', 'completed:Dream memory']);
  });
});
