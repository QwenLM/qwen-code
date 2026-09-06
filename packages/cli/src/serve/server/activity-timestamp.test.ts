/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { laterActivityTimestamp } from './activity-timestamp.js';

describe('laterActivityTimestamp', () => {
  it('picks the later candidate from either side', () => {
    expect(
      laterActivityTimestamp(
        '2026-05-17T12:00:09.000Z',
        '2026-05-17T12:00:05.000Z',
      ),
    ).toBe('2026-05-17T12:00:09.000Z');
    expect(
      laterActivityTimestamp(
        '2026-05-17T12:00:01.000Z',
        '2026-05-17T12:00:05.000Z',
      ),
    ).toBe('2026-05-17T12:00:05.000Z');
    // Equal instants keep the live spelling so a tie cannot flip the reported
    // string back and forth between two encodings of the same time.
    expect(
      laterActivityTimestamp(
        '2026-05-17T12:00:05.000Z',
        '2026-05-17T12:00:05.000+00:00',
      ),
    ).toBe('2026-05-17T12:00:05.000Z');
  });

  it('never lets an absent or unparseable candidate displace a valid one', () => {
    expect(laterActivityTimestamp(undefined, '2026-05-17T12:00:05.000Z')).toBe(
      '2026-05-17T12:00:05.000Z',
    );
    expect(
      laterActivityTimestamp('not-a-timestamp', '2026-05-17T12:00:05.000Z'),
    ).toBe('2026-05-17T12:00:05.000Z');
    expect(laterActivityTimestamp('2026-05-17T12:00:05.000Z', undefined)).toBe(
      '2026-05-17T12:00:05.000Z',
    );
    expect(
      laterActivityTimestamp('2026-05-17T12:00:05.000Z', 'not-a-timestamp'),
    ).toBe('2026-05-17T12:00:05.000Z');
  });

  it('passes a candidate through unchanged when neither side parses', () => {
    // Defensive tail: no caller can currently supply two invalid candidates,
    // but dropping it would silently turn an unparseable stored value into
    // `undefined` and erase the only evidence of the bad data.
    expect(laterActivityTimestamp(undefined, 'not-a-timestamp')).toBe(
      'not-a-timestamp',
    );
    expect(laterActivityTimestamp('not-a-timestamp', undefined)).toBe(
      'not-a-timestamp',
    );
    expect(laterActivityTimestamp('live-garbage', 'persisted-garbage')).toBe(
      'live-garbage',
    );
    expect(laterActivityTimestamp(undefined, undefined)).toBeUndefined();
  });
});
