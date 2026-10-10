// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { followRangeFromRows } from './TranscriptViewport';

describe('followRangeFromRows', () => {
  it('returns undefined when no row maps to a turn', () => {
    expect(
      followRangeFromRows([{ top: 0, bottom: 10 }], 0, 100),
    ).toBeUndefined();
  });

  it('highlights the turn owning the row above the reading line', () => {
    const rows = [
      { top: 0, bottom: 100, ordinal: 3 },
      { top: 100, bottom: 200, ordinal: 4 },
      { top: 200, bottom: 300, ordinal: 5 },
    ];
    expect(followRangeFromRows(rows, 0, 300)).toEqual({
      start: 3,
      end: 5,
      current: 4,
    });
  });

  it('reaches the first and last turns at the scroll extremes', () => {
    expect(
      followRangeFromRows(
        [
          { top: 0, bottom: 120, ordinal: 0 },
          { top: 120, bottom: 240, ordinal: 1 },
        ],
        0,
        300,
      )?.current,
    ).toBe(0);
    expect(
      followRangeFromRows(
        [
          { top: 0, bottom: 200, ordinal: 8 },
          { top: 200, bottom: 400, ordinal: 9 },
        ],
        200,
        400,
      )?.current,
    ).toBe(9);
  });

  it('propagates a turn across its unmapped rows', () => {
    const rows = [
      { top: 0, bottom: 50, ordinal: 7 },
      { top: 50, bottom: 250 },
      { top: 250, bottom: 300, ordinal: 8 },
    ];
    expect(followRangeFromRows(rows, 0, 300)).toEqual({
      start: 7,
      end: 8,
      current: 7,
    });
  });

  it('assigns rows above the first mapped row to the previous turn, clamped at zero', () => {
    const rows = [
      { top: 0, bottom: 50 },
      { top: 50, bottom: 100, ordinal: 12 },
    ];
    expect(followRangeFromRows(rows, 0, 100)).toEqual({
      start: 11,
      end: 12,
      current: 11,
    });
    const clamped = followRangeFromRows(
      [
        { top: 0, bottom: 50 },
        { top: 50, bottom: 100, ordinal: 0 },
      ],
      0,
      100,
    );
    expect(clamped?.start).toBe(0);
  });

  it('uses off-viewport rows for inheritance but not for the range', () => {
    const rows = [
      { top: -200, bottom: -100, ordinal: 30 },
      { top: 0, bottom: 100 },
      { top: 100, bottom: 200, ordinal: 31 },
    ];
    expect(followRangeFromRows(rows, 0, 200)).toEqual({
      start: 30,
      end: 31,
      current: 30,
    });
  });
});
