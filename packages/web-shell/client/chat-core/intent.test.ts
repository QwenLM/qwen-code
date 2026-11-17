import { describe, expect, it } from 'vitest';
import type { ChatOperation, IntentTarget } from './contract.js';
import {
  acknowledgeOperation,
  deriveChatPhase,
  isTerminalOperation,
  resolveIntent,
  resolveOutcome,
  retainOperations,
} from './intent.js';

const target: IntentTarget = { sessionId: 's1', turnId: 't1' };

function operation(
  overrides: Partial<ChatOperation> & Pick<ChatOperation, 'id' | 'kind'>,
): ChatOperation {
  return { state: 'pending', target, ...overrides };
}

describe('admission/outcome truth table', () => {
  it('rejected admission carries no outcome for any witness', () => {
    for (const witness of ['settled', 'failed', 'none'] as const) {
      expect(resolveOutcome('rejected', witness)).toBeUndefined();
    }
  });

  it('transport success alone never produces established', () => {
    expect(resolveOutcome('accepted', 'none')).toBe('unsettled');
    expect(resolveIntent('accepted', 'none', target).outcome).toBe('unsettled');
  });

  it('established requires an accepted admission and a settled witness', () => {
    expect(resolveOutcome('accepted', 'settled')).toBe('established');
    expect(resolveOutcome('unknown', 'settled')).toBe('unsettled');
  });

  it('failed requires an accepted admission and a failed witness', () => {
    expect(resolveOutcome('accepted', 'failed')).toBe('failed');
    expect(resolveOutcome('unknown', 'failed')).toBe('unsettled');
  });

  it('unknown admission stays unsettled until reconciliation', () => {
    expect(resolveOutcome('unknown', 'none')).toBe('unsettled');
  });

  it('resolveIntent keeps the correlation target', () => {
    const result = resolveIntent('accepted', 'settled', {
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      requestId: 'r1',
    });
    expect(result.target).toEqual({
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      requestId: 'r1',
    });
    expect(result.admission).toBe('accepted');
    expect(result.outcome).toBe('established');
  });
});

describe('operation retention', () => {
  it('classifies terminal states', () => {
    expect(isTerminalOperation('established')).toBe(true);
    expect(isTerminalOperation('failed')).toBe(true);
    for (const state of ['pending', 'running', 'unsettled'] as const) {
      expect(isTerminalOperation(state)).toBe(false);
    }
  });

  it('keeps at most the latest terminal entry per kind and target', () => {
    const ops = [
      operation({ id: 'c1', kind: 'cancel', state: 'established' }),
      operation({ id: 'c2', kind: 'cancel', state: 'failed' }),
      operation({ id: 's1', kind: 'submit', state: 'established' }),
    ];
    const retained = retainOperations(ops);
    expect(retained.map((op) => op.id)).toEqual(['c2', 's1']);
  });

  it('keeps terminal entries for distinct targets', () => {
    const ops = [
      operation({ id: 'c1', kind: 'cancel', state: 'established' }),
      operation({
        id: 'c2',
        kind: 'cancel',
        state: 'established',
        target: { sessionId: 's1', turnId: 't2' },
      }),
    ];
    expect(retainOperations(ops).map((op) => op.id)).toEqual(['c1', 'c2']);
  });

  it('keeps every non-terminal entry, including unsettled across refresh', () => {
    const ops = [
      operation({ id: 'u1', kind: 'submit', state: 'unsettled' }),
      operation({ id: 'u2', kind: 'cancel', state: 'unsettled' }),
      operation({ id: 'p1', kind: 'compression', state: 'running' }),
    ];
    expect(retainOperations(ops).map((op) => op.id)).toEqual([
      'u1',
      'u2',
      'p1',
    ]);
  });

  it('acknowledgement removes only the named terminal entry', () => {
    const ops = [
      operation({ id: 'c1', kind: 'cancel', state: 'established' }),
      operation({ id: 'u1', kind: 'submit', state: 'unsettled' }),
    ];
    expect(acknowledgeOperation(ops, 'c1').map((op) => op.id)).toEqual(['u1']);
    expect(acknowledgeOperation(ops, 'u1').map((op) => op.id)).toEqual([
      'c1',
      'u1',
    ]);
  });
});

describe('phase derivation', () => {
  it('an unestablished cancel operation yields cancelling', () => {
    for (const state of ['pending', 'running', 'unsettled'] as const) {
      const ops = [
        operation({ id: 's1', kind: 'submit', state: 'running' }),
        operation({ id: 'c1', kind: 'cancel', state }),
      ];
      expect(deriveChatPhase(ops, 'idle')).toBe('cancelling');
    }
  });

  it('a settled cancel operation does not keep cancelling', () => {
    const ops = [operation({ id: 'c1', kind: 'cancel', state: 'established' })];
    expect(deriveChatPhase(ops, 'idle')).toBe('idle');
  });

  it('submit states map to submitting and running', () => {
    expect(
      deriveChatPhase(
        [operation({ id: 's1', kind: 'submit', state: 'pending' })],
        'idle',
      ),
    ).toBe('submitting');
    for (const state of ['running', 'unsettled'] as const) {
      expect(
        deriveChatPhase(
          [operation({ id: 's1', kind: 'submit', state })],
          'idle',
        ),
      ).toBe('running');
    }
  });

  it('no active operations passes the settled phase through', () => {
    expect(deriveChatPhase([], 'idle')).toBe('idle');
    expect(deriveChatPhase([], 'failed')).toBe('failed');
  });
});
