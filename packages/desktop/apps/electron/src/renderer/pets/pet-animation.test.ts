import { describe, expect, it } from 'bun:test';
import {
  PET_BACKGROUND_SIZE,
  PET_STATE_FRAMES,
  PET_STATES,
  backgroundPositionFor,
  buildSequence,
} from './pet-animation';

describe('pet-animation frame tables', () => {
  it('covers all nine states', () => {
    expect(PET_STATES).toHaveLength(9);
    for (const state of PET_STATES) {
      expect(PET_STATE_FRAMES[state].length).toBeGreaterThan(0);
    }
  });

  it('matches the atlas row/frame contract', () => {
    const counts = Object.fromEntries(
      PET_STATES.map((s) => [s, PET_STATE_FRAMES[s].length]),
    );
    expect(counts).toEqual({
      idle: 6,
      'running-right': 8,
      'running-left': 8,
      waving: 4,
      jumping: 5,
      failed: 8,
      waiting: 6,
      running: 6,
      review: 6,
    });
  });

  it('places each row on its own atlas row, columns ascending', () => {
    PET_STATES.forEach((state, rowIndex) => {
      PET_STATE_FRAMES[state].forEach((frame, col) => {
        expect(frame.rowIndex).toBe(rowIndex);
        expect(frame.columnIndex).toBe(col);
        expect(frame.durationMs).toBeGreaterThan(0);
      });
    });
  });
});

describe('backgroundPositionFor', () => {
  it('maps the first cell to the top-left', () => {
    expect(backgroundPositionFor({ rowIndex: 0, columnIndex: 0, durationMs: 1 })).toBe(
      '0% 0%',
    );
  });

  it('maps the last cell to the bottom-right', () => {
    expect(backgroundPositionFor({ rowIndex: 8, columnIndex: 7, durationMs: 1 })).toBe(
      '100% 100%',
    );
  });

  it('uses an 8x9 background-size', () => {
    expect(PET_BACKGROUND_SIZE).toBe('800% 900%');
  });
});

describe('buildSequence', () => {
  it('renders a single static frame under reduced motion', () => {
    const seq = buildSequence('running', true);
    expect(seq.frames).toHaveLength(1);
    expect(seq.loopStartIndex).toBeNull();
  });

  it('loops idle forever', () => {
    const seq = buildSequence('idle', false);
    expect(seq.loopStartIndex).toBe(0);
    expect(seq.frames.length).toBe(PET_STATE_FRAMES.idle.length);
  });

  it('plays an action three times then settles into idle', () => {
    const seq = buildSequence('running', false);
    const action = PET_STATE_FRAMES.running.length; // 6
    const idle = PET_STATE_FRAMES.idle.length; // 6
    expect(seq.frames).toHaveLength(action * 3 + idle);
    expect(seq.loopStartIndex).toBe(action * 3);
    // the loop tail is the idle row
    expect(seq.frames[seq.loopStartIndex!].rowIndex).toBe(0);
  });
});
