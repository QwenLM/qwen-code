/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonAutofixPrWatch } from '../daemon/workspace/types';
import {
  parseAutofixPrTick,
  stopCommand,
  watchOfTask,
  watchPhase,
} from './autofixPrWatches';

const watch = (
  over: Partial<DaemonAutofixPrWatch> = {},
): DaemonAutofixPrWatch => ({
  pr: 12,
  repo: 'o/r',
  host: 'github.com',
  url: 'https://github.com/o/r/pull/12',
  headRefName: 'feat',
  headSha: 'a'.repeat(40),
  pushes: 0,
  maxPushes: 10,
  session: 's',
  preparedAt: null,
  lastCheck: null,
  checkedRecently: true,
  lastRound: null,
  stopped: null,
  watch: { every: 2, reply: true, instructions: '', task: 'feedc0ffee12' },
  ended: null,
  needsHuman: [],
  worktreeExists: true,
  fix: null,
  ...over,
});

describe('parseAutofixPrTick', () => {
  it('reads the prompt `schedule` writes, its options and instructions after', () => {
    expect(parseAutofixPrTick('Run /autofix-pr tick o/r#12')).toEqual({
      repo: 'o/r',
      pr: 12,
    });
    expect(
      parseAutofixPrTick(
        'Run /autofix-pr tick my-org/repo.js#7 --task feedc0ffee12 --no-reply -- keep the API',
      ),
    ).toEqual({ repo: 'my-org/repo.js', pr: 7, task: 'feedc0ffee12' });
  });

  it('takes no other prompt for a watch', () => {
    for (const prompt of [
      'summarize the day',
      'Run /autofix-pr tick o/r#0',
      'Run /autofix-pr tick o/r#12x',
      'Run /autofix-pr status 12',
      'Please Run /autofix-pr tick o/r#12',
      'Run /autofix-pr tick o#12',
    ]) {
      expect(parseAutofixPrTick(prompt)).toBeNull();
    }
  });
});

describe('watchOfTask', () => {
  it("finds the task's watch, whatever the case of the repository", () => {
    const recorded = watch({ repo: 'O/R' });
    expect(
      watchOfTask('Run /autofix-pr tick o/r#12 --task feedc0ffee12', [
        watch({ pr: 13 }),
        recorded,
      ]),
    ).toEqual({ watch: recorded, stale: false });
    expect(watchOfTask('Run /autofix-pr tick o/r#14', [recorded])).toBeNull();
    expect(watchOfTask('Run /autofix-pr tick o/r#12', undefined)).toBeNull();
  });

  it('calls a task stale as its gate does: an ended watch, another task, or none where it has an id', () => {
    const staleOf = (prompt: string, over: Partial<DaemonAutofixPrWatch>) =>
      watchOfTask(prompt, [watch(over)])?.stale;
    const withId = 'Run /autofix-pr tick o/r#12 --task feedc0ffee12';
    const noId = 'Run /autofix-pr tick o/r#12';
    expect(staleOf(withId, {})).toBe(false);
    expect(staleOf('Run /autofix-pr tick o/r#12 --task 000000000000', {})).toBe(
      true,
    );
    expect(staleOf(withId, { watch: null })).toBe(true);
    expect(
      staleOf(withId, { ended: { at: '2026-10-26T10:00:00Z', reason: 'x' } }),
    ).toBe(true);
    // A task from before task ids is not the one recorded once there is one.
    expect(staleOf(noId, {})).toBe(true);
    // Nor stale where nothing says otherwise.
    expect(
      staleOf(noId, {
        watch: { every: 2, reply: true, instructions: '' },
      }),
    ).toBe(false);
    expect(staleOf(noId, { watch: null })).toBe(false);
  });
});

describe('watchPhase', () => {
  it('reads an ended PR first, then an ended watch, then the fix, then the checks', () => {
    const fix = { attempt: '0123456789ab', startedAt: null, fresh: true };
    expect(watchPhase(watch({ stopped: 'merged', fix }))).toBe('merged');
    expect(watchPhase(watch({ stopped: 'closed' }))).toBe('closed');
    expect(
      watchPhase(watch({ ended: { at: 'x', reason: 'stopped' }, fix })),
    ).toBe('ended');
    expect(watchPhase(watch({ watch: null, fix }))).toBe('unscheduled');
    expect(watchPhase(watch({ fix, checkedRecently: false }))).toBe('fixing');
    expect(watchPhase(watch({ fix: { ...fix, fresh: false } }))).toBe(
      'abandonedFix',
    );
    expect(watchPhase(watch())).toBe('watching');
    expect(watchPhase(watch({ checkedRecently: false }))).toBe('idle');
  });
});

it('stops a watch as a user types it', () => {
  expect(stopCommand(watch())).toBe('/autofix-pr stop 12');
});
