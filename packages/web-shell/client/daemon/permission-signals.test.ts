import { describe, expect, it } from 'vitest';
import { derivePermissionSignals } from './permission-signals.js';

const set = (...ids: string[]) => new Set(ids);

describe('derivePermissionSignals', () => {
  it('a newly pending request becomes live', () => {
    const signals = derivePermissionSignals(set(), set('r1'), set());
    expect(signals.currency).toEqual([['r1', true]]);
    expect(signals.decisions).toEqual([]);
  });

  it('a still-pending request emits nothing', () => {
    const signals = derivePermissionSignals(set('r1'), set('r1'), set());
    expect(signals.currency).toEqual([]);
    expect(signals.decisions).toEqual([]);
  });

  it('an answered request that resolves emits an applied decision and stays live', () => {
    const signals = derivePermissionSignals(set('r1'), set(), set('r1'));
    expect(signals.decisions).toEqual([{ requestId: 'r1', applied: true }]);
    // No not-live currency signal: the engine releases the identity on establish.
    expect(signals.currency).toEqual([]);
    expect(signals.answered.has('r1')).toBe(false);
  });

  it('an unanswered request that resolves is superseded (not live)', () => {
    const signals = derivePermissionSignals(set('r1'), set(), set());
    expect(signals.currency).toEqual([['r1', false]]);
    expect(signals.decisions).toEqual([]);
  });

  it('separates answered from superseded requests in one transition', () => {
    const signals = derivePermissionSignals(
      set('r1', 'r2', 'r3'),
      set('r3', 'r4'),
      set('r1'),
    );
    // r1 answered -> decision; r2 unanswered -> superseded; r4 new -> live.
    expect(signals.decisions).toEqual([{ requestId: 'r1', applied: true }]);
    expect(signals.currency).toEqual([
      ['r4', true],
      ['r2', false],
    ]);
    expect(signals.answered.has('r1')).toBe(false);
  });

  it('does not re-emit a decision for an answer already consumed', () => {
    // r1 was answered and consumed in a prior transition (not in answered now);
    // if it somehow re-leaves the pending set it is treated as superseded.
    const signals = derivePermissionSignals(set('r1'), set(), set());
    expect(signals.decisions).toEqual([]);
    expect(signals.currency).toEqual([['r1', false]]);
  });
});
