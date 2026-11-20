import { describe, it, expect } from 'vitest';
import {
  LEDGER_CONTINUATION_SUFFIXES,
  buildContinuationPromptId,
  deriveLedgerTurnKey,
} from './ledger-turn-key.js';

describe('deriveLedgerTurnKey', () => {
  const base = 'test-session-id########1';

  // Each continuation suffix alternative must normalize to the base key, or a
  // continuation would read as a new turn and reset the consumed marks (R8-F4).
  it.each(LEDGER_CONTINUATION_SUFFIXES)(
    'strips the _%s_N continuation suffix',
    (suffix) => {
      expect(deriveLedgerTurnKey(`${base}_${suffix}_1`)).toBe(base);
    },
  );

  it('strips a multi-digit continuation ordinal', () => {
    expect(deriveLedgerTurnKey(`${base}_stop_hook_12`)).toBe(base);
  });

  it('leaves a base prompt id without a continuation suffix unchanged', () => {
    expect(deriveLedgerTurnKey(base)).toBe(base);
  });

  it('leaves an unrecognized suffix unchanged', () => {
    expect(deriveLedgerTurnKey(`${base}_other_1`)).toBe(`${base}_other_1`);
  });

  it('only strips a trailing suffix, not an interior match', () => {
    expect(deriveLedgerTurnKey(`${base}_stop_hook_1_extra`)).toBe(
      `${base}_stop_hook_1_extra`,
    );
  });
});

describe('continuation suffix vocabulary (R9-11)', () => {
  const base = 'test-session-id########1';

  // Pin the vocabulary content at runtime, not only via the compile-time
  // literal-union type: dropping a suffix must fail here even though the
  // it.each below would simply generate fewer cases (S7).
  it('contains exactly the four continuation suffixes', () => {
    expect([...LEDGER_CONTINUATION_SUFFIXES]).toEqual([
      'todo_stop_guard',
      'stop_hook',
      'background_result',
      'mid_turn',
    ]);
  });

  // The generation side (buildContinuationPromptId, used by Session.ts) and the
  // stripping side (deriveLedgerTurnKey) share one vocabulary; every id the
  // builders produce must normalize back to its base, so the two cannot drift.
  it.each(LEDGER_CONTINUATION_SUFFIXES)(
    'round-trips a built _%s_N id back to its base',
    (suffix) => {
      for (const ordinal of [1, 7, 42]) {
        const built = buildContinuationPromptId(base, suffix, ordinal);
        expect(built).toBe(`${base}_${suffix}_${ordinal}`);
        expect(deriveLedgerTurnKey(built)).toBe(base);
      }
    },
  );
});
