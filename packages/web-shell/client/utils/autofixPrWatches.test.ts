/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonAutofixPrWatch } from '../daemon/workspace/types';
import {
  buildAutofixPrStartCommand,
  findWatchForPr,
  getWatchActiveStatus,
  indexAutofixPrWatches,
  isPrOpenForAutofix,
  isWatchActivePhase,
  normalizePrUrlKey,
  parseAutofixPrInput,
  parseAutofixPrTick,
  resumeCommand,
  stopCommand,
  summarizeAutofixPrWatches,
  summarizeSessionPrWatchStatus,
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
    expect(
      parseAutofixPrTick(
        'Run /autofix-pr tick o/r#12 --task feedc0ffee12 --in-place --no-reply -- keep API',
      ),
    ).toEqual({ repo: 'o/r', pr: 12, task: 'feedc0ffee12' });
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

it('stops and resumes a watch as a user types it', () => {
  expect(stopCommand(watch())).toBe('/autofix-pr stop 12');
  expect(resumeCommand(watch())).toBe('/autofix-pr resume 12');
});

describe('buildAutofixPrStartCommand', () => {
  it('builds watch, once, in-place, interval, no-reply, and instructions commands', () => {
    expect(
      buildAutofixPrStartCommand({ pr: 'https://github.com/o/r/pull/12' }),
    ).toBe('/autofix-pr https://github.com/o/r/pull/12');
    expect(
      buildAutofixPrStartCommand({
        pr: 12,
        mode: 'watch',
        every: 5,
        noReply: true,
        instructions: '  keep the public API\nunchanged  ',
      }),
    ).toBe('/autofix-pr 12 --every 5 --no-reply keep the public API unchanged');
    expect(
      buildAutofixPrStartCommand({
        pr: 'https://github.com/o/r/pull/12',
        mode: 'once',
        every: 5,
        noReply: true,
      }),
    ).toBe('/autofix-pr https://github.com/o/r/pull/12 --once --no-reply');
    expect(
      buildAutofixPrStartCommand({
        pr: 12,
        mode: 'in-place',
        every: 5,
      }),
    ).toBe('/autofix-pr 12 --in-place');
  });
});

describe('normalizePrUrlKey and parseAutofixPrInput', () => {
  it('canonicalizes PR URLs case-insensitively and ignores trailing slashes', () => {
    expect(normalizePrUrlKey('https://GitHub.com/Acme/Widgets/pull/12/')).toBe(
      'github.com/acme/widgets#12',
    );
    expect(
      normalizePrUrlKey('https://git.corp.example:8443/Org/Repo/pull/7'),
    ).toBe('git.corp.example:8443/org/repo#7');
    expect(normalizePrUrlKey('javascript:alert(1)')).toBeNull();
    expect(normalizePrUrlKey('https://github.com/o/r/issues/12')).toBeNull();
    expect(normalizePrUrlKey('https://github.com/o/r/pull/0')).toBeNull();
  });

  it('parses bare numbers, #numbers, and http(s) PR URLs', () => {
    expect(parseAutofixPrInput('42')).toEqual({ kind: 'number', number: 42 });
    expect(parseAutofixPrInput('#42')).toEqual({ kind: 'number', number: 42 });
    expect(
      parseAutofixPrInput('https://github.com/Acme/Widgets/pull/42/'),
    ).toEqual({
      kind: 'url',
      url: 'https://github.com/Acme/Widgets/pull/42',
      number: 42,
    });
    for (const invalid of ['', '0', '#0', '-1', 'abc', 'ftp://x/o/r/pull/1']) {
      expect(parseAutofixPrInput(invalid)).toBeNull();
    }
  });
});

describe('indexAutofixPrWatches and helpers', () => {
  it('indexes watches by canonical PR URL and keeps higher-priority phase on duplicates', () => {
    const idleWatch = watch({ checkedRecently: false });
    const fixingWatch = watch({
      fix: { attempt: '0123456789ab', startedAt: null, fresh: true },
    });
    const index = indexAutofixPrWatches(
      new Map([
        ['', { available: true, watches: [idleWatch] }],
        ['second', { available: true, watches: [fixingWatch] }],
      ]),
      new Map([
        ['', '/w/main'],
        ['second', '/w/second'],
      ]),
    );
    const found = findWatchForPr(index, 'https://GITHUB.com/O/R/pull/12/');
    expect(found?.phase).toBe('fixing');
    expect(found?.workspaceCwd).toBe('/w/second');
    expect(
      findWatchForPr(index, 'https://github.com/other/repo/pull/12'),
    ).toBeUndefined();
  });

  it('distinguishes active watch phases and open PR states', () => {
    expect(isWatchActivePhase('watching')).toBe(true);
    expect(isWatchActivePhase('fixing')).toBe(true);
    expect(isWatchActivePhase('abandonedFix')).toBe(true);
    expect(isWatchActivePhase('idle')).toBe(false);
    expect(isWatchActivePhase('ended')).toBe(false);
    expect(isWatchActivePhase('merged')).toBe(false);

    expect(isPrOpenForAutofix('open')).toBe(true);
    expect(isPrOpenForAutofix('draft')).toBe(true);
    expect(isPrOpenForAutofix(undefined)).toBe(true);
    expect(isPrOpenForAutofix('merged')).toBe(false);
    expect(isPrOpenForAutofix('closed')).toBe(false);
  });

  it('summarizes active watches, needsHuman counts, and per-session PR watch status', () => {
    const watching = watch({ pr: 10, url: 'https://github.com/o/r/pull/10' });
    const fixing = watch({
      pr: 11,
      url: 'https://github.com/o/r/pull/11',
      fix: { attempt: '0123456789ab', startedAt: null, fresh: true },
    });
    const waitingIdle = watch({
      pr: 12,
      url: 'https://github.com/o/r/pull/12',
      checkedRecently: false,
      needsHuman: [
        { sha: 'a'.repeat(40), at: '2026-11-28T00:00:00Z', text: 'Decide A' },
        { sha: 'a'.repeat(40), at: '2026-11-28T00:01:00Z', text: 'Decide B' },
      ],
    });
    const endedWithOldNeedsHuman = watch({
      pr: 13,
      url: 'https://github.com/o/r/pull/13',
      ended: { at: '2026-11-28T00:00:00Z', reason: 'stopped' },
      needsHuman: [
        { sha: 'a'.repeat(40), at: '2026-11-28T00:00:00Z', text: 'Old' },
      ],
    });
    const index = indexAutofixPrWatches(
      new Map([
        [
          '',
          {
            available: true,
            watches: [watching, fixing, waitingIdle, endedWithOldNeedsHuman],
          },
        ],
      ]),
    );

    expect(summarizeAutofixPrWatches(index)).toEqual({
      activeCount: 2,
      needsHumanCount: 2,
    });
    expect(getWatchActiveStatus(endedWithOldNeedsHuman)).toBeNull();
    expect(
      summarizeSessionPrWatchStatus(index, [
        { url: 'https://github.com/o/r/pull/10', state: 'open' },
        { url: 'https://github.com/o/r/pull/11', state: 'open' },
      ]),
    ).toEqual({ status: 'fixing', needsHumanCount: 0 });
    // Merged PRs do not contribute a watch badge.
    expect(
      summarizeSessionPrWatchStatus(index, [
        { url: 'https://github.com/o/r/pull/12', state: 'merged' },
      ]),
    ).toBeNull();
    expect(
      summarizeSessionPrWatchStatus(index, [
        { url: 'https://github.com/o/r/pull/10', state: 'open' },
        { url: 'https://github.com/o/r/pull/12', state: 'open' },
      ]),
    ).toEqual({ status: 'needsHuman', needsHumanCount: 2 });
  });
});
