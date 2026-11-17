import { describe, it, expect } from 'vitest';
import { deriveLedgerTurnKey } from './ledger-turn-key.js';

describe('deriveLedgerTurnKey', () => {
  const base = 'test-session-id########1';

  // Each continuation suffix alternative must normalize to the base key, or a
  // continuation would read as a new turn and reset the consumed marks (R8-F4).
  it.each(['todo_stop_guard', 'stop_hook', 'background_result', 'mid_turn'])(
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
