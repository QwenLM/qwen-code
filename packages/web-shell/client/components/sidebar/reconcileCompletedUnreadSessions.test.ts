import { expect, it } from 'vitest';
import { reconcileCompletedUnreadSessions } from './reconcileCompletedUnreadSessions';

it('marks an observed completion but not an initially idle session', () => {
  const running = new Map([
    ['finished', false],
    ['idle', false],
  ]);
  expect(reconcileCompletedUnreadSessions(null, running, null)).toEqual({
    add: [],
    remove: [],
  });
  expect(
    reconcileCompletedUnreadSessions(
      new Map([['finished', true]]),
      running,
      null,
    ),
  ).toEqual({ add: ['finished'], remove: [] });
});

it('clears running and opened sessions without clearing absent identities', () => {
  expect(
    reconcileCompletedUnreadSessions(
      new Map([
        ['absent', false],
        ['opened', true],
      ]),
      new Map([
        ['running', true],
        ['opened', false],
      ]),
      'opened',
    ),
  ).toEqual({ add: [], remove: ['opened', 'running'] });
});

it('clears at the start of a run without clearing on repeated running snapshots', () => {
  const running = new Map([['session', true]]);
  expect(reconcileCompletedUnreadSessions(null, running, null)).toEqual({
    add: [],
    remove: ['session'],
  });
  expect(
    reconcileCompletedUnreadSessions(
      new Map([['session', false]]),
      running,
      null,
    ),
  ).toEqual({ add: [], remove: ['session'] });
  expect(reconcileCompletedUnreadSessions(running, running, null)).toEqual({
    add: [],
    remove: [],
  });
});
