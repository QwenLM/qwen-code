import { describe, expect, it } from 'vitest';
import { ChannelOutputTurn } from './output-turn.js';

describe('ChannelOutputTurn', () => {
  it.each(['per_task', 'per_turn'] as const)(
    'selects the last non-empty output in %s',
    (mode) => {
      const turn = new ChannelOutputTurn(mode);
      expect(turn.close('first', 'response_boundary')).toEqual({
        kind: 'preview',
        text: 'first',
        deferFallback: true,
      });
      turn.close('last', 'response_boundary');
      expect(turn.shouldPreview(' \n')).toBe(false);
      expect(turn.close(' \n', 'response_boundary')).toEqual({ kind: 'skip' });
      expect(turn.close(' \n', 'completed')).toEqual({
        kind: 'complete',
        text: 'last',
        rotate: false,
      });
      expect(turn.finish('completed')).toBeUndefined();
    },
  );

  it('uses explicit final output instead of the remembered preview', () => {
    const turn = new ChannelOutputTurn('per_turn');
    turn.close('process', 'response_boundary');
    expect(turn.close('final', 'completed')).toEqual({
      kind: 'complete',
      text: 'final',
      rotate: false,
    });
    expect(turn.finish('completed')).toBeUndefined();
  });

  it('recovers the latest result when no final segment is emitted', () => {
    const turn = new ChannelOutputTurn('per_turn');
    turn.close('first', 'response_boundary');
    turn.close('last', 'response_boundary');
    expect(turn.finish('completed')).toBe('last');
    expect(turn.finish('completed')).toBeUndefined();
    expect(turn.close('late', 'completed')).toEqual({ kind: 'skip' });
    expect(turn.shouldPreview('late')).toBe(false);
  });

  it.each(['failed', 'cancelled'] as const)(
    'discards withheld output on %s',
    (reason) => {
      const turn = new ChannelOutputTurn('per_turn');
      turn.close('process', 'response_boundary');
      expect(turn.close('', reason)).toEqual({ kind: reason });
      expect(turn.finish(reason)).toBeUndefined();
      const withoutSegment = new ChannelOutputTurn('per_turn');
      withoutSegment.close('process', 'response_boundary');
      expect(withoutSegment.finish(reason)).toBeUndefined();
    },
  );

  it('completes every non-empty process response and skips an empty tail', () => {
    const turn = new ChannelOutputTurn('per_response');
    expect(turn.close('first', 'response_boundary')).toEqual({
      kind: 'complete',
      text: 'first',
      rotate: true,
    });
    expect(turn.close('last', 'completed')).toEqual({
      kind: 'complete',
      text: 'last',
      rotate: false,
    });
    expect(turn.close(' \n', 'completed')).toEqual({ kind: 'skip' });
    expect(turn.finish('completed')).toBeUndefined();
  });

  it.each(['per_task', 'per_turn', 'per_response', undefined] as const)(
    'completes the input boundary with mode %s',
    (mode) => {
      const turn = new ChannelOutputTurn(mode);
      turn.close('previous', 'response_boundary');
      expect(turn.close('question', 'input_requested')).toEqual({
        kind: 'complete',
        text: 'question',
        rotate: true,
      });
      expect(turn.finish('completed')).toBeUndefined();
    },
  );

  it('preserves omitted-mode boundary fallback and whitespace behavior', () => {
    const turn = new ChannelOutputTurn();
    expect(turn.shouldPreview(' ')).toBe(true);
    expect(turn.close('process', 'response_boundary')).toEqual({
      kind: 'preview',
      text: 'process',
      deferFallback: false,
    });
    expect(turn.close(' ', 'completed')).toEqual({
      kind: 'complete',
      text: ' ',
      rotate: false,
    });
    expect(turn.finish('completed')).toBeUndefined();
  });

  it('does not share state between turns', () => {
    const first = new ChannelOutputTurn('per_turn');
    const second = new ChannelOutputTurn('per_turn');
    first.close('first turn', 'response_boundary');
    expect(second.close('', 'completed')).toEqual({ kind: 'skip' });
    expect(first.finish('completed')).toBe('first turn');
    expect(second.finish('completed')).toBeUndefined();
  });
});
