import { describe, expect, it } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import {
  derivePermissionSignals,
  questionSubmitOptionId,
} from './permission-signals.js';

const set = (...ids: string[]) => new Set(ids);

function questionPermission(
  requestId: string,
  options: Array<{ optionId: string; kind: string }>,
): Extract<DaemonTranscriptBlock, { kind: 'permission' }> {
  return {
    id: `perm-${requestId}`,
    kind: 'permission',
    requestId,
    sessionId: 'session-1',
    title: 'Ask user',
    resolved: undefined,
    options: options.map((option) => ({
      optionId: option.optionId,
      label: option.optionId,
      raw: { kind: option.kind },
    })),
    toolCall: { rawInput: { questions: [] } },
    preview: { kind: 'generic' },
    createdAt: 1,
    updatedAt: 1,
  } as Extract<DaemonTranscriptBlock, { kind: 'permission' }>;
}

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

describe('questionSubmitOptionId', () => {
  it('returns the allow_once option id for the request', () => {
    const permissions = [
      questionPermission('q1', [
        { optionId: 'submit', kind: 'allow_once' },
        { optionId: 'cancel', kind: 'reject_once' },
      ]),
    ];
    expect(questionSubmitOptionId(permissions, 'q1')).toBe('submit');
  });

  it('picks the matching request among several', () => {
    const permissions = [
      questionPermission('q1', [{ optionId: 'a', kind: 'allow_once' }]),
      questionPermission('q2', [{ optionId: 'b', kind: 'allow_once' }]),
    ];
    expect(questionSubmitOptionId(permissions, 'q2')).toBe('b');
  });

  it('returns undefined for an unknown request', () => {
    const permissions = [
      questionPermission('q1', [{ optionId: 'a', kind: 'allow_once' }]),
    ];
    expect(questionSubmitOptionId(permissions, 'missing')).toBeUndefined();
  });

  it('returns undefined when the request has no allow_once option', () => {
    const permissions = [
      questionPermission('q1', [{ optionId: 'cancel', kind: 'reject_once' }]),
    ];
    expect(questionSubmitOptionId(permissions, 'q1')).toBeUndefined();
  });
});
