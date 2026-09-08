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
    ).toEqual({ action: 'drop' });
    // A protected incoming item is dropped too: evicting a protected peer
    // would trade one irreplaceable result for another.
    expect(
      decideNotificationAdmission(queue, agent('a_new'), { isProtected }),
    ).toEqual({ action: 'drop' });
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
      'Dropped 7 background notifications (queue full): 2 shell results ' +
        '(bg_ef56, bg_gh78), 5 monitor pulses (mon_ab12, mon_cd34, mon_ab12, +2).',
    );
    expect(summary?.modelText).toBe(
      '<task-notification>\n<kind>queue</kind>\n<status>dropped</status>\n' +
        '<summary>7 background notifications were dropped before delivery ' +
        'because the notification queue overflowed: 2 shell results (bg_ef56, ' +
        'bg_gh78), 5 monitor pulses (mon_ab12, mon_cd34, mon_ab12, +2). Their ' +
        'tasks were not stopped. Check their current state with /tasks or by ' +
        'reading the task output files before acting on this turn.</summary>\n' +
        '</task-notification>',
    );
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
  });

  it('discards the backlog on clear without producing a summary', () => {
    const tally = new DroppedNotificationTally();
    tally.record(shell('bg_1'));

    tally.clear();

    expect(tally.count).toBe(0);
    expect(tally.take()).toBeUndefined();
  });

  it('separates interim monitor pulses from terminal monitor results', () => {
    const tally = new DroppedNotificationTally();
    tally.record({ kind: 'monitor', taskId: 'mon_1', interim: true });
    tally.record({ kind: 'monitor', taskId: 'mon_2' });

    expect(tally.take()?.displayText).toBe(
      'Dropped 2 background notifications (queue full): 1 monitor result ' +
        '(mon_2), 1 monitor pulse (mon_1).',
    );
  });

  it('omits ids for producers that did not supply one', () => {
    const tally = new DroppedNotificationTally();
    tally.record({ kind: 'cron' });

    expect(tally.take()?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 scheduled prompt.',
    );
  });
});
