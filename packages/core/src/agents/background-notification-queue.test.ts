/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AdmissibleNotification } from './background-notification-queue.js';
import {
  DroppedNotificationTally,
  MAX_BACKGROUND_NOTIFICATION_QUEUE,
  decideNotificationAdmission,
} from './background-notification-queue.js';

interface TestItem extends AdmissibleNotification {
  label?: string;
}

function shell(taskId: string): TestItem {
  return { kind: 'shell', taskId };
}

function pulse(taskId: string): TestItem {
  return { kind: 'monitor', taskId, interim: true };
}

function agent(taskId: string): TestItem {
  return { kind: 'agent', taskId };
}

function fill(count: number, make: (index: number) => TestItem): TestItem[] {
  return Array.from({ length: count }, (_value, index) => make(index));
}

describe('decideNotificationAdmission', () => {
  it('pushes while the queue is below the cap', () => {
    const queue = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE - 1, (i) =>
      shell(`bg_${i}`),
    );
    expect(decideNotificationAdmission(queue, shell('bg_new'))).toEqual({
      action: 'push',
    });
  });

  it('evicts the oldest interim pulse before any other queued item', () => {
    const queue = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE, (i) =>
      i === 5 ? pulse('mon_5') : i === 9 ? pulse('mon_9') : shell(`bg_${i}`),
    );

    const admission = decideNotificationAdmission(queue, shell('bg_new'));

    expect(admission).toEqual({
      action: 'evict',
      index: 5,
      evicted: pulse('mon_5'),
    });
  });

  it('evicts the oldest queued item when no pulse is queued', () => {
    const queue = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE, (i) =>
      shell(`bg_${i}`),
    );

    const admission = decideNotificationAdmission(queue, shell('bg_new'));

    expect(admission).toEqual({
      action: 'evict',
      index: 0,
      evicted: shell('bg_0'),
    });
  });

  it('skips protected items and evicts the first unprotected one', () => {
    const queue = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE, (i) =>
      i === MAX_BACKGROUND_NOTIFICATION_QUEUE - 1
        ? shell('bg_last')
        : agent(`a_${i}`),
    );

    const admission = decideNotificationAdmission(queue, shell('bg_new'), {
      isProtected: (item) => item.kind === 'agent',
    });

    expect(admission).toEqual({
      action: 'evict',
      index: MAX_BACKGROUND_NOTIFICATION_QUEUE - 1,
      evicted: shell('bg_last'),
    });
  });

  it('never lets pulse priority override protection', () => {
    const queue = [
      pulse('mon_protected'),
      ...fill(MAX_BACKGROUND_NOTIFICATION_QUEUE - 1, (i) => shell(`bg_${i}`)),
    ];

    expect(
      decideNotificationAdmission(queue, shell('bg_new'), {
        isProtected: (item) => item.kind === 'monitor',
      }),
    ).toEqual({ action: 'evict', index: 1, evicted: shell('bg_0') });
  });

  it('passes the queue index to the protection predicate', () => {
    const queue = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE, (i) =>
      shell(`bg_${i}`),
    );
    const seen: number[] = [];

    const admission = decideNotificationAdmission(queue, shell('bg_new'), {
      isProtected: (_item, index) => {
        seen.push(index);
        return index < 3;
      },
    });

    expect(seen).toHaveLength(MAX_BACKGROUND_NOTIFICATION_QUEUE);
    expect(admission).toEqual({
      action: 'evict',
      index: 3,
      evicted: shell('bg_3'),
    });
  });

  it('drops the incoming item when every queued item is protected', () => {
    const queue = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE, (i) =>
      agent(`a_${i}`),
    );
    const isProtected = () => true;

    expect(
      decideNotificationAdmission(queue, shell('bg_new'), { isProtected }),
    ).toEqual({ action: 'drop', reason: 'all-protected' });
    // A protected incoming item is dropped too: evicting a protected peer
    // would trade one irreplaceable result for another.
    expect(
      decideNotificationAdmission(queue, agent('a_new'), { isProtected }),
    ).toEqual({ action: 'drop', reason: 'all-protected' });
  });

  it('drops an arriving pulse rather than displace a terminal result', () => {
    const queue = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE, (i) =>
      shell(`bg_${i}`),
    );

    // A pulse is superseded by the monitor's next poll, so evicting the only
    // copy of a shell result to make room for one trades the wrong way.
    expect(decideNotificationAdmission(queue, pulse('mon_new'))).toEqual({
      action: 'drop',
      reason: 'superseded-pulse',
    });
    // But a queued pulse is still the first thing an arriving pulse displaces.
    const withPulse = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE, (i) =>
      i === 4 ? pulse('mon_old') : shell(`bg_${i}`),
    );
    expect(decideNotificationAdmission(withPulse, pulse('mon_new'))).toEqual({
      action: 'evict',
      index: 4,
      evicted: pulse('mon_old'),
    });
  });

  it('honours an explicit max over the shared cap', () => {
    const queue = fill(3, (i) => shell(`bg_${i}`));

    expect(
      decideNotificationAdmission(queue, shell('bg_new'), { max: 3 }),
    ).toEqual({ action: 'evict', index: 0, evicted: shell('bg_0') });
    expect(
      decideNotificationAdmission(queue, shell('bg_new'), { max: 4 }),
    ).toEqual({ action: 'push' });
  });

  it('does not mutate the queue it inspects', () => {
    const queue = fill(MAX_BACKGROUND_NOTIFICATION_QUEUE, (i) =>
      shell(`bg_${i}`),
    );
    const snapshot = structuredClone(queue);

    decideNotificationAdmission(queue, shell('bg_new'));

    expect(queue).toEqual(snapshot);
  });
});

describe('DroppedNotificationTally', () => {
  it('reports nothing until something is dropped', () => {
    const tally = new DroppedNotificationTally();
    expect(tally.count).toBe(0);
    expect(tally.take()).toBeUndefined();
  });

  it('summarises drops by kind for the user and the model', () => {
    const tally = new DroppedNotificationTally();
    for (const id of [
      'mon_ab12',
      'mon_cd34',
      'mon_ab12',
      'mon_cd34',
      'mon_ab12',
    ]) {
      tally.record({ kind: 'monitor', taskId: id, interim: true });
    }
    tally.record(shell('bg_ef56'));
    tally.record(shell('bg_gh78'));

    expect(tally.count).toBe(7);
    const summary = tally.take();

    expect(summary?.displayText).toBe(
      'Dropped 2 background notifications (queue full): 2 shell results ' +
        '(bg_ef56, bg_gh78). 5 superseded monitor pulses (mon_ab12, ' +
        'mon_cd34, +3) were not delivered.',
    );
    expect(summary?.modelText).toBe(
      '<task-notification>\n<kind>queue</kind>\n<status>dropped</status>\n' +
        '<summary>2 background notifications were dropped before delivery ' +
        'because the notification queue overflowed: 2 shell results (bg_ef56, ' +
        'bg_gh78). 5 superseded monitor pulses (mon_ab12, mon_cd34, +3) were ' +
        'not delivered. The affected tasks were not stopped or deleted. Check ' +
        'their current state with /tasks or by reading the task output files ' +
        'before acting on this turn.</summary>\n' +
        '</task-notification>',
    );
  });

  it('elides distinct task ids beyond the per-group limit', () => {
    const tally = new DroppedNotificationTally();
    for (const id of ['bg_1', 'bg_2', 'bg_3', 'bg_4']) {
      tally.record(shell(id));
    }

    expect(tally.take()?.displayText).toBe(
      'Dropped 4 background notifications (queue full): 4 shell results ' +
        '(bg_1, bg_2, bg_3, +1).',
    );
  });

  it('renders every group and both recovery hints in stable order', () => {
    const tally = new DroppedNotificationTally();
    tally.record(agent('a_1'));
    tally.record({ kind: 'workflow', taskId: 'w_1' });
    tally.record(shell('bg_1'));
    tally.record({ kind: 'monitor', taskId: 'mon_done' });
    tally.record(pulse('mon_live'));
    tally.record({ kind: 'cron', taskId: 'cron_1' });

    const summary = tally.take();
    expect(summary?.displayText).toBe(
      'Dropped 5 background notifications (queue full): 1 agent result ' +
        '(a_1), 1 workflow result (w_1), 1 shell result (bg_1), 1 monitor ' +
        'result (mon_done), 1 scheduled prompt (cron_1). 1 superseded ' +
        'monitor pulse (mon_live) was not delivered.',
    );
    expect(summary?.modelText).toBe(
      '<task-notification>\n<kind>queue</kind>\n<status>dropped</status>\n' +
        '<summary>5 background notifications were dropped before delivery ' +
        'because the notification queue overflowed: 1 agent result (a_1), ' +
        '1 workflow result (w_1), 1 shell result (bg_1), 1 monitor result ' +
        '(mon_done), 1 scheduled prompt (cron_1). 1 superseded monitor pulse ' +
        '(mon_live) was not delivered. The affected tasks were not stopped ' +
        'or deleted. Check their current state with /tasks or by reading the ' +
        'task output files before acting on this turn. The scheduled prompts ' +
        'were not delivered and will not be retried.</summary>\n' +
        '</task-notification>',
    );
  });

  it('keeps a pulse-only summary out of the dropped headline', () => {
    const tally = new DroppedNotificationTally();
    tally.record(pulse('mon_live'));

    const summary = tally.take();
    expect(summary?.displayText).toBe(
      '1 superseded monitor pulse (mon_live) was not delivered.',
    );
    expect(summary?.modelText).toContain(
      '<summary>1 superseded monitor pulse (mon_live) was not delivered.</summary>',
    );
    expect(summary?.modelText).not.toContain('Dropped 0');
  });

  it('reports a recorded live-delivery miss separately from loss', () => {
    const tally = new DroppedNotificationTally();
    tally.record({ kind: 'agent', taskId: 'worker_1', persisted: true });

    const summary = tally.take();
    expect(summary?.displayText).toBe(
      'Recorded but not delivered live (queue full): 1 agent result (worker_1).',
    );
    expect(summary?.modelText).toContain(
      '1 background notification was already recorded but not delivered in a live notification turn',
    );
    expect(summary?.modelText).toContain('<status>recorded</status>');
    expect(summary?.modelText).toContain(
      'The recorded results remain available in the session transcript.',
    );
    expect(summary?.modelText).not.toContain('/tasks');
    expect(summary?.modelText).not.toContain('was dropped before delivery');
  });

  it('uses singular wording for a single drop', () => {
    const tally = new DroppedNotificationTally();
    tally.record(shell('bg_only'));

    const summary = tally.take();

    expect(summary?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 shell result (bg_only).',
    );
    expect(summary?.modelText).toContain(
      '1 background notification was dropped before delivery',
    );
  });

  it('resets after each take', () => {
    const tally = new DroppedNotificationTally();
    tally.record(shell('bg_1'));

    expect(tally.take()).toBeDefined();
    expect(tally.count).toBe(0);
    expect(tally.take()).toBeUndefined();

    tally.record(shell('bg_2'));
    expect(tally.take()?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 shell result (bg_2).',
    );
  });

  it('discards the backlog on clear without producing a summary', () => {
    const tally = new DroppedNotificationTally();
    tally.record(shell('bg_1'));

    tally.clear();

    expect(tally.count).toBe(0);
    expect(tally.take()).toBeUndefined();

    tally.record(shell('bg_2'));
    expect(tally.take()?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 shell result (bg_2).',
    );
  });

  it('separates interim monitor pulses from terminal monitor results', () => {
    const tally = new DroppedNotificationTally();
    tally.record({ kind: 'monitor', taskId: 'mon_1', interim: true });
    tally.record({ kind: 'monitor', taskId: 'mon_2' });

    expect(tally.take()?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 monitor result ' +
        '(mon_2). 1 superseded monitor pulse (mon_1) was not delivered.',
    );
  });

  it('omits ids for producers that did not supply one', () => {
    const tally = new DroppedNotificationTally();
    tally.record({ kind: 'cron' });

    const summary = tally.take();
    expect(summary?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 scheduled prompt.',
    );
    expect(summary?.modelText).toContain(
      'The scheduled prompts were not delivered and will not be retried.',
    );
    expect(summary?.modelText).not.toContain('/tasks');
  });
});
