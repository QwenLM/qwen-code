/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CronFireRegistry } from './cron-fire-registry.js';

/** The prefix `cronManager.ts` stamps on every fired prompt. */
const SCHEDULED_PROMPT = '[Running scheduled task (Aug 6, 3:00 PM)]\ndo the thing';

const taskFire = { taskId: 'a3f9c210', isWakeup: false };

describe('cron fire registry', () => {
  let registry: CronFireRegistry;

  beforeEach(() => {
    registry = new CronFireRegistry();
  });

  it('claims a parked fire when the prompt is a scheduled one', () => {
    registry.registerFire(taskFire);

    const claimed = registry.claimPendingFires(SCHEDULED_PROMPT);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].taskId).toBe('a3f9c210');
    expect(claimed[0].isWakeup).toBe(false);
    expect(registry.pendingFireCount()).toBe(0);
  });

  it('leaves the fire parked for a prompt the user typed', () => {
    registry.registerFire(taskFire);

    expect(registry.claimPendingFires('fix the failing test')).toEqual([]);
    expect(registry.pendingFireCount()).toBe(1);
  });

  it('claims one fire per marker the merged prompt carries', () => {
    registry.registerFire({ taskId: 'f1', isWakeup: false });
    registry.registerFire({ taskId: 'f2', isWakeup: false });
    registry.registerFire({ taskId: 'f3', isWakeup: true });

    // What the queue processor produces when it drains three notifications:
    // dequeueAllMatching + prompts.join('\n'), so three markers, one turn.
    const merged = [SCHEDULED_PROMPT, SCHEDULED_PROMPT, SCHEDULED_PROMPT].join(
      '\n',
    );
    const claimed = registry.claimPendingFires(merged);

    expect(claimed.map((c) => c.taskId)).toEqual(['f1', 'f2', 'f3']);
  });

  /**
   * A fire that landed after the queue drained belongs to the next turn. If it
   * were swept into this one, this run's credits would be split across the wrong
   * number of fires and the next run would charge nothing.
   */
  it('leaves fires the prompt does not carry parked for the next turn', () => {
    registry.registerFire({ taskId: 'f1', isWakeup: false });
    registry.registerFire({ taskId: 'f2', isWakeup: false });

    const claimed = registry.claimPendingFires(SCHEDULED_PROMPT);

    expect(claimed.map((c) => c.taskId)).toEqual(['f1']);
    expect(registry.pendingFireCount()).toBe(1);
    expect(
      registry.claimPendingFires(SCHEDULED_PROMPT).map((c) => c.taskId),
    ).toEqual(['f2']);
  });

  it('claims no more than are parked when the prompt carries more markers', () => {
    registry.registerFire(taskFire);

    const merged = [SCHEDULED_PROMPT, SCHEDULED_PROMPT].join('\n');
    expect(registry.claimPendingFires(merged)).toHaveLength(1);
  });

  it('claims only once, so a later turn does not charge the same fire again', () => {
    registry.registerFire(taskFire);

    expect(registry.claimPendingFires(SCHEDULED_PROMPT)).toHaveLength(1);
    expect(registry.claimPendingFires(SCHEDULED_PROMPT)).toEqual([]);
  });

  it('drops the oldest fire past the cap instead of growing unbounded', () => {
    for (let i = 0; i < 40; i++) {
      registry.registerFire({ taskId: `f${i}`, isWakeup: false });
    }

    expect(registry.pendingFireCount()).toBe(32);

    // Enough markers to drain the whole registry, so the assertion is about the
    // cap rather than about how many the prompt happened to carry.
    const claimed = registry.claimPendingFires(
      Array(40).fill(SCHEDULED_PROMPT).join('\n'),
    );

    expect(claimed).toHaveLength(32);
    expect(claimed[0].taskId).toBe('f8');
  });

  /**
   * The reason this class exists rather than a module-level array: two sessions
   * in one process must not be able to claim each other's fires.
   */
  it('never hands one session the fire another session parked', () => {
    const other = new CronFireRegistry();
    registry.registerFire({ taskId: 'mine', isWakeup: false });

    expect(other.claimPendingFires(SCHEDULED_PROMPT)).toEqual([]);
    expect(registry.claimPendingFires(SCHEDULED_PROMPT).map((c) => c.taskId)).toEqual([
      'mine',
    ]);
  });
});
