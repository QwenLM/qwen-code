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

const MAX = MAX_BACKGROUND_NOTIFICATION_QUEUE;
const decide = decideNotificationAdmission;

/** A queue of `count` shell items `bg_0`, `bg_1`, …; full by default. */
const shells = (count = MAX) => fill(count, (i) => shell(`bg_${i}`));

const evict = (index: number, evicted: TestItem) => ({
  action: 'evict',
  index,
  evicted,
});

function tallyOf(...items: TestItem[]): DroppedNotificationTally {
  const tally = new DroppedNotificationTally();
  for (const item of items) tally.record(item);
  return tally;
}

const PEER_NOT_REDELIVERED =
  'The cross-session messages were not delivered and will not be redelivered.';

describe('decideNotificationAdmission', () => {
  it('pushes while the queue is below the cap', () => {
    const queue = shells(MAX - 1);
    expect(decide(queue, shell('bg_new'))).toEqual({
      action: 'push',
    });
  });

  it('evicts the oldest interim pulse before any other queued item', () => {
    const queue = fill(MAX, (i) =>
      i === 5 ? pulse('mon_5') : i === 9 ? pulse('mon_9') : shell(`bg_${i}`),
    );

    const admission = decide(queue, shell('bg_new'));

    expect(admission).toEqual(evict(5, pulse('mon_5')));
  });

  it('evicts the oldest queued item when no pulse is queued', () => {
    const queue = shells();

    const admission = decide(queue, shell('bg_new'));

    expect(admission).toEqual(evict(0, shell('bg_0')));
  });

  it('skips protected items and evicts the first unprotected one', () => {
    const queue = fill(MAX, (i) =>
      i === MAX - 1 ? shell('bg_last') : agent(`a_${i}`),
    );

    const admission = decide(queue, shell('bg_new'), {
      isProtected: (item) => item.kind === 'agent',
    });

    expect(admission).toEqual(evict(MAX - 1, shell('bg_last')));
  });

  it('never lets pulse priority override protection', () => {
    const queue = [pulse('mon_protected'), ...shells(MAX - 1)];

    expect(
      decide(queue, shell('bg_new'), {
        isProtected: (item) => item.kind === 'monitor',
      }),
    ).toEqual(evict(1, shell('bg_0')));
  });

  it('passes the queue index to the protection predicate', () => {
    const queue = shells();
    const seen: number[] = [];

    const admission = decide(queue, shell('bg_new'), {
      isProtected: (_item, index) => {
        seen.push(index);
        return index < 3;
      },
    });

    expect(seen).toHaveLength(MAX);
    expect(admission).toEqual(evict(3, shell('bg_3')));
  });

  it('drops the incoming item when every queued item is protected', () => {
    const queue = fill(MAX, (i) => agent(`a_${i}`));
    const isProtected = () => true;

    expect(decide(queue, shell('bg_new'), { isProtected })).toEqual({
      action: 'drop',
      reason: 'all-protected',
    });
    // A protected incoming item is dropped too: evicting a protected peer
    // would trade one irreplaceable result for another.
    expect(decide(queue, agent('a_new'), { isProtected })).toEqual({
      action: 'drop',
      reason: 'all-protected',
    });
  });

  it('drops an arriving pulse rather than displace a terminal result', () => {
    const queue = shells();

    // A pulse is superseded by the monitor's next poll, so evicting the only
    // copy of a shell result to make room for one trades the wrong way.
    expect(decide(queue, pulse('mon_new'))).toEqual({
      action: 'drop',
      reason: 'superseded-pulse',
    });
    // But a queued pulse is still the first thing an arriving pulse displaces.
    const withPulse = fill(MAX, (i) =>
      i === 4 ? pulse('mon_old') : shell(`bg_${i}`),
    );
    expect(decide(withPulse, pulse('mon_new'))).toEqual(
      evict(4, pulse('mon_old')),
    );
  });

  it('honours an explicit max over the shared cap', () => {
    const queue = shells(3);

    expect(decide(queue, shell('bg_new'), { max: 3 })).toEqual(
      evict(0, shell('bg_0')),
    );
    expect(decide(queue, shell('bg_new'), { max: 4 })).toEqual({
      action: 'push',
    });
  });

  it('does not mutate the queue it inspects', () => {
    const queue = shells();
    const snapshot = structuredClone(queue);

    decide(queue, shell('bg_new'));

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
    const tally = tallyOf(
      ...['mon_ab12', 'mon_cd34', 'mon_ab12', 'mon_cd34', 'mon_ab12'].map(
        pulse,
      ),
      shell('bg_ef56'),
      shell('bg_gh78'),
    );

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
    const tally = tallyOf(...['bg_1', 'bg_2', 'bg_3', 'bg_4'].map(shell));

    expect(tally.take()?.displayText).toBe(
      'Dropped 4 background notifications (queue full): 4 shell results ' +
        '(bg_1, bg_2, bg_3, +1).',
    );
  });

  it('renders every group and both recovery hints in stable order', () => {
    const summary = tallyOf(
      agent('a_1'),
      { kind: 'workflow', taskId: 'w_1' },
      shell('bg_1'),
      { kind: 'monitor', taskId: 'mon_done' },
      pulse('mon_live'),
      { kind: 'cron', taskId: 'cron_1' },
    ).take();
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
    const summary = tallyOf(pulse('mon_live')).take();
    expect(summary?.displayText).toBe(
      '1 superseded monitor pulse (mon_live) was not delivered.',
    );
    expect(summary?.modelText).toContain(
      '<summary>1 superseded monitor pulse (mon_live) was not delivered.</summary>',
    );
    expect(summary?.modelText).not.toContain('Dropped 0');
  });

  it('reports a recorded live-delivery miss separately from loss', () => {
    const summary = tallyOf({
      kind: 'agent',
      taskId: 'worker_1',
      persisted: true,
    }).take();
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
    const summary = tallyOf(shell('bg_only')).take();

    expect(summary?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 shell result (bg_only).',
    );
    expect(summary?.modelText).toContain(
      '1 background notification was dropped before delivery',
    );
  });

  it('resets after each take', () => {
    const tally = tallyOf(shell('bg_1'));

    expect(tally.take()).toBeDefined();
    expect(tally.count).toBe(0);
    expect(tally.take()).toBeUndefined();

    tally.record(shell('bg_2'));
    expect(tally.take()?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 shell result (bg_2).',
    );
  });

  it('discards the backlog on clear without producing a summary', () => {
    const tally = tallyOf(shell('bg_1'));

    tally.clear();

    expect(tally.count).toBe(0);
    expect(tally.take()).toBeUndefined();

    tally.record(shell('bg_2'));
    expect(tally.take()?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 shell result (bg_2).',
    );
  });

  it('separates interim monitor pulses from terminal monitor results', () => {
    const tally = tallyOf(pulse('mon_1'), { kind: 'monitor', taskId: 'mon_2' });

    expect(tally.take()?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 monitor result ' +
        '(mon_2). 1 superseded monitor pulse (mon_1) was not delivered.',
    );
  });

  it('omits ids for producers that did not supply one', () => {
    const summary = tallyOf({ kind: 'cron' }).take();
    expect(summary?.displayText).toBe(
      'Dropped 1 background notification (queue full): 1 scheduled prompt.',
    );
    expect(summary?.modelText).toContain(
      'The scheduled prompts were not delivered and will not be retried.',
    );
    expect(summary?.modelText).not.toContain('/tasks');
  });

  it('names a lost peer message without sending the model to /tasks', () => {
    const summary = tallyOf(
      { kind: 'peer', taskId: 'msg_1' },
      { kind: 'peer', taskId: 'msg_2' },
    ).take();
    expect(summary?.displayText).toBe(
      'Dropped 2 background notifications (queue full): 2 cross-session ' +
        'messages (msg_1, msg_2).',
    );
    expect(summary?.modelText).toContain(PEER_NOT_REDELIVERED);
    // A peer message has no entry in the task registry, so the line that
    // tells the model to go and read one would send it nowhere.
    expect(summary?.modelText).not.toContain('/tasks');
  });

  it('still points at /tasks when a task was lost alongside a peer message', () => {
    const summary = tallyOf(
      { kind: 'peer', taskId: 'msg_1' },
      shell('bg_1'),
    ).take();
    expect(summary?.modelText).toContain('/tasks');
    expect(summary?.modelText).toContain(PEER_NOT_REDELIVERED);
  });

  it('evicts a queued peer message like any other terminal notification', () => {
    const queue = fill(MAX, (i) => ({ kind: 'peer', taskId: `msg_${i}` }));

    const admission = decide(queue, {
      kind: 'peer',
      taskId: 'msg_new',
    });

    expect(admission).toEqual(evict(0, queue[0]));
  });
});
