/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ProactiveTaskManager } from './task-manager.js';

describe('ProactiveTaskManager', () => {
  it('creates canonical event and narration tasks', () => {
    const manager = new ProactiveTaskManager(4);
    const event = manager.createMonitor({
      title: 'Tea',
      modalities: ['camera', 'mic', 'vision'],
      condition: 'The kettle boils',
      triggerResponse: 'Tell me to turn it off',
      repeat: false,
    });
    const narration = manager.createNarration({
      title: 'Narration',
      modalities: ['video'],
      narrationFocus: 'Describe new activity',
      narrationStyle: 'Brief Chinese',
    });
    expect(event.modalities).toEqual(['vision', 'audio']);
    expect(event.monitorMode).toBe('event');
    expect(narration).toMatchObject({ monitorMode: 'always', repeat: true });
  });

  it('ignores legacy capacity while preserving unique active titles', () => {
    const manager = new ProactiveTaskManager(1);
    manager.createMonitor({
      title: 'Tea',
      modalities: ['vision'],
      condition: 'boils',
      triggerResponse: 'notify',
      repeat: false,
    });
    expect(() =>
      manager.createMonitor({
        title: 'Other',
        modalities: ['audio'],
        condition: 'rings',
        triggerResponse: 'notify',
        repeat: false,
      }),
    ).not.toThrow();
    for (let index = 0; index < 40; index += 1)
      manager.createMonitor({
        title: `Monitor ${index}`,
        modalities: ['vision'],
        condition: 'change',
        triggerResponse: 'notify',
        repeat: true,
      });
    expect(manager.activePerceptionTasks()).toHaveLength(42);
    expect(() =>
      manager.createTimer({
        title: 'tea',
        durationSec: 1,
        reminderText: 'done',
      }),
    ).toThrow('already exists');
  });

  it('cancels by exact ID without stopping a same-title replacement', () => {
    const manager = new ProactiveTaskManager();
    const input = { title: 'Tea', durationSec: 10, reminderText: 'ready' };
    const original = manager.createTimer(input);
    expect(manager.cancelById(original.taskId)?.status).toBe('cancelled');
    const replacement = manager.createTimer(input);
    expect(manager.cancelById(original.taskId)?.status).toBe('cancelled');
    expect(manager.cancelById('missing')).toBeUndefined();
    expect(manager.get(replacement.taskId)?.status).toBe('provisioning');
  });

  it('updates and cancels only a unique active title', () => {
    const manager = new ProactiveTaskManager(4);
    const timer = manager.createTimer({
      title: 'Short timer',
      durationSec: 10,
      reminderText: 'First',
    });
    manager.mutate(timer.taskId, timer.generation, (current) => {
      current.status = 'running';
      return true;
    });
    const updated = manager.update({
      targetTitleContains: 'short',
      durationSec: 20,
      reminderText: 'Second',
    });
    expect(updated).toMatchObject({ durationSec: 20, reminderText: 'Second' });
    expect(manager.cancel({ targetTitle: 'Short timer' })[0]?.status).toBe(
      'cancelled',
    );
    expect(manager.listActive()).toEqual([]);
  });

  it('requires delivery acknowledgement before one-shot completion', () => {
    const manager = new ProactiveTaskManager(4);
    const task = manager.createMonitor({
      title: 'Tea',
      modalities: ['vision'],
      condition: 'boils',
      triggerResponse: 'notify',
      repeat: false,
    });
    manager.mutate(task.taskId, task.generation, (current) => {
      current.status = 'running';
      return true;
    });
    const delivering = manager.beginDelivery(task.taskId, task.generation);
    expect(delivering?.status).toBe('delivering');
    expect(manager.get(task.taskId)?.status).not.toBe('completed');
    manager.completeDelivery(task.taskId, task.generation);
    expect(manager.get(task.taskId)?.status).toBe('completed');
  });

  it('keeps repeated monitoring active when multiple events await delivery', () => {
    const manager = new ProactiveTaskManager(4);
    const task = manager.createMonitor({
      title: 'Tea',
      modalities: ['vision'],
      condition: 'boils',
      triggerResponse: 'notify',
      repeat: true,
    });
    manager.mutate(task.taskId, task.generation, (current) => {
      current.status = 'running';
      return true;
    });
    expect(
      manager.beginDelivery(task.taskId, task.generation, 'First occurrence'),
    ).toMatchObject({
      status: 'running',
      triggerCount: 1,
      lastSummary: 'First occurrence',
    });
    expect(
      manager.beginDelivery(task.taskId, task.generation, 'Second occurrence'),
    ).toMatchObject({
      status: 'running',
      triggerCount: 2,
      lastSummary: 'Second occurrence',
    });
    expect(
      manager.completeDelivery(task.taskId, task.generation),
    ).toBeUndefined();
    const updated = manager.update({
      targetTitle: 'Tea',
      condition: 'whistles',
    });
    expect(updated.generation).toBe(task.generation + 1);
    expect(manager.beginDelivery(task.taskId, task.generation)).toBeUndefined();
  });

  it('fails closed when a mutation or delivery transition is stale', () => {
    const manager = new ProactiveTaskManager(4);
    const task = manager.createMonitor({
      title: 'Tea',
      modalities: ['vision'],
      condition: 'boils',
      triggerResponse: 'notify',
      repeat: false,
    });
    const before = manager.get(task.taskId);

    expect(
      manager.mutate(task.taskId, task.generation + 1, (current) => {
        current.status = 'running';
        return true;
      }),
    ).toBeUndefined();
    expect(
      manager.mutate(task.taskId, task.generation, (current) => {
        current.status = 'running';
        return false;
      }),
    ).toBeUndefined();
    expect(manager.get(task.taskId)).toEqual(before);
    expect(manager.beginDelivery(task.taskId, task.generation)).toBeUndefined();

    expect(
      manager.mutate(task.taskId, task.generation, (current) => {
        if (current.status !== 'provisioning') return false;
        current.status = 'running';
        return true;
      })?.status,
    ).toBe('running');
    const delivering = manager.beginDelivery(task.taskId, task.generation);
    expect(delivering?.status).toBe('delivering');
    expect(manager.beginDelivery(task.taskId, task.generation)).toBeUndefined();
    expect(
      manager.completeDelivery(task.taskId, task.generation + 1),
    ).toBeUndefined();
    expect(manager.get(task.taskId)?.status).toBe('delivering');

    expect(manager.completeDelivery(task.taskId, task.generation)?.status).toBe(
      'completed',
    );
    expect(
      manager.fail(task.taskId, task.generation, 'late failure'),
    ).toBeUndefined();
  });

  it('does not partially apply an invalid update', () => {
    const manager = new ProactiveTaskManager(4);
    const timer = manager.createTimer({
      title: 'Tea timer',
      durationSec: 10,
      reminderText: 'First',
    });
    manager.mutate(timer.taskId, timer.generation, (current) => {
      current.status = 'running';
      return true;
    });

    expect(() =>
      manager.update({
        targetTitle: 'Tea timer',
        title: 'Changed too early',
        condition: 'not valid for a timer',
      }),
    ).toThrow('Fields do not apply');
    expect(manager.get(timer.taskId)).toMatchObject({
      title: 'Tea timer',
      generation: timer.generation,
      durationSec: 10,
      reminderText: 'First',
    });
  });
});
