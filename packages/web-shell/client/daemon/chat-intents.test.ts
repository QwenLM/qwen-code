import { describe, expect, it } from 'vitest';
import type { IntentResult, IntentTarget } from '../chat-core/contract.js';
import { createDaemonChatIntents } from './chat-intents.js';

const target: IntentTarget = { sessionId: 's1', turnId: 't1' };
const approvalTarget = (requestId: string): IntentTarget => ({
  sessionId: 's1',
  requestId,
});
const accepted = async () => 'accepted' as const;

describe('daemon intents: admission is not establishment', () => {
  it('a resolved submit transport alone stays unsettled until the turn settles', async () => {
    const intents = createDaemonChatIntents();
    const { result, operationId } = await intents.dispatch(
      'submit',
      target,
      accepted,
    );
    // Transport success is admission only — never an established outcome.
    expect(result.admission).toBe('accepted');
    expect(result.outcome).toBe('unsettled');
    expect(intents.operations.some((op) => op.kind === 'submit')).toBe(true);
    expect(intents.phase('idle')).toBe('running');

    const settled = intents.settle(operationId, 'settled');
    expect(settled?.outcome).toBe('established');
    expect(intents.phase('idle')).toBe('idle');
  });

  it('a resolved cancel transport keeps cancelling until settlement evidence', async () => {
    const intents = createDaemonChatIntents();
    const { result, operationId } = await intents.dispatch(
      'cancel',
      target,
      accepted,
    );
    expect(result.outcome).toBe('unsettled');
    // The cancel promise resolving does not end the cancelling phase.
    expect(intents.phase('idle')).toBe('cancelling');

    const settled = intents.settle(operationId, 'settled');
    expect(settled?.outcome).toBe('established');
    expect(intents.phase('idle')).toBe('idle');
  });

  it('a superseded approval decision never establishes', async () => {
    const intents = createDaemonChatIntents();
    intents.setCurrentApprovalRequest('r1');
    const first = await intents.dispatch(
      'approval',
      approvalTarget('r1'),
      accepted,
    );
    // A newer request supersedes r1 before its decision is confirmed.
    intents.setCurrentApprovalRequest('r2');

    const superseded = intents.settle(first.operationId, 'settled');
    expect(superseded?.outcome).not.toBe('established');
    expect(superseded?.outcome).toBe('unsettled');

    // Positive control: the still-current request does establish.
    const second = await intents.dispatch(
      'approval',
      approvalTarget('r2'),
      accepted,
    );
    const current = intents.settle(second.operationId, 'settled');
    expect(current?.outcome).toBe('established');
  });

  it('an approval whose request identity is unknown never establishes', async () => {
    const intents = createDaemonChatIntents();
    const { operationId } = await intents.dispatch(
      'approval',
      { sessionId: 's1' },
      accepted,
    );
    // Currency cannot be verified without the request it applies to.
    expect(intents.settle(operationId, 'settled')?.outcome).toBe('unsettled');
  });
});

describe('daemon intents: witness correlation', () => {
  it('a late witness for a finished attempt cannot establish a later attempt', async () => {
    const intents = createDaemonChatIntents();
    const finished = await intents.dispatch('submit', target, accepted);
    intents.settle(finished.operationId, 'failed');
    const retry = await intents.dispatch('submit', target, accepted);

    // Evidence from the finished attempt arrives late, after the retry began.
    expect(intents.settle(finished.operationId, 'settled')).toBeUndefined();
    expect(
      intents.operations.find((op) => op.id === retry.operationId)?.state,
    ).toBe('running');

    // The retry's own evidence still establishes it.
    expect(intents.settle(retry.operationId, 'settled')?.outcome).toBe(
      'established',
    );
  });

  it('out-of-order evidence keeps its effect on its own attempt', async () => {
    const settleInOrder = async (
      order: readonly ('first' | 'second')[],
    ): Promise<{
      first?: IntentResult['outcome'];
      second?: IntentResult['outcome'];
    }> => {
      const intents = createDaemonChatIntents();
      const dispatched = {
        first: (await intents.dispatch('submit', target, accepted)).operationId,
        second: (await intents.dispatch('submit', target, accepted))
          .operationId,
      };
      const witnessFor = { first: 'failed', second: 'settled' } as const;
      const outcomes = new Map<string, IntentResult['outcome']>();
      const terminalOf = (name: 'first' | 'second') =>
        witnessFor[name] === 'settled' ? 'established' : 'failed';
      for (const [index, name] of order.entries()) {
        outcomes.set(
          name,
          intents.settle(dispatched[name], witnessFor[name])?.outcome,
        );
        // Each attempt's state must follow the witness that named it, not the
        // attempt whose evidence happened to arrive first.
        if (index === 0) {
          const states = new Map(
            intents.operations.map((op) => [op.id, op.state]),
          );
          const other = name === 'first' ? 'second' : 'first';
          expect(states.get(dispatched[name])).toBe(terminalOf(name));
          expect(states.get(dispatched[other])).toBe('running');
        }
      }
      // Once both attempts are terminal, retention keeps the later-dispatched
      // row; the outcomes above show each attempt kept its own witness.
      expect(intents.operations.map((op) => [op.id, op.state])).toEqual([
        [dispatched.second, 'established'],
      ]);
      return { first: outcomes.get('first'), second: outcomes.get('second') };
    };

    const expected = { first: 'failed', second: 'established' };
    expect(await settleInOrder(['first', 'second'])).toEqual(expected);
    expect(await settleInOrder(['second', 'first'])).toEqual(expected);
  });
});

describe('daemon intents: admission handling', () => {
  it('a rejected admission carries no outcome and is not tracked', async () => {
    const intents = createDaemonChatIntents();
    const { result, operationId } = await intents.dispatch(
      'submit',
      target,
      async () => 'rejected',
    );
    expect(result.admission).toBe('rejected');
    expect(result.outcome).toBeUndefined();
    expect(intents.operations).toEqual([]);
    expect(intents.phase('idle')).toBe('idle');
    expect(intents.settle(operationId, 'settled')).toBeUndefined();
  });

  it('a transport failure is an unknown admission that never establishes', async () => {
    const intents = createDaemonChatIntents();
    const { result, operationId } = await intents.dispatch(
      'submit',
      target,
      async () => {
        throw new Error('transport down');
      },
    );
    expect(result.admission).toBe('unknown');
    expect(result.outcome).toBe('unsettled');
    // Even a settled witness cannot establish an unknown admission.
    const settled = intents.settle(operationId, 'settled');
    expect(settled?.outcome).toBe('unsettled');
  });

  it('a failed witness produces a failed outcome', async () => {
    const intents = createDaemonChatIntents();
    const { operationId } = await intents.dispatch('submit', target, accepted);
    const failed = intents.settle(operationId, 'failed');
    expect(failed?.outcome).toBe('failed');
    expect(intents.operations.find((op) => op.id === operationId)?.state).toBe(
      'failed',
    );
  });

  it('settling an unknown intent is a no-op', () => {
    const intents = createDaemonChatIntents();
    expect(intents.settle('daemon-intent-404', 'settled')).toBeUndefined();
  });
});

describe('daemon intents: bounded retention', () => {
  it('keeps at most the latest terminal submit per target', async () => {
    const intents = createDaemonChatIntents();
    const first = await intents.dispatch('submit', target, accepted);
    intents.settle(first.operationId, 'settled');
    const second = await intents.dispatch('submit', target, accepted);
    intents.settle(second.operationId, 'failed');
    const submits = intents.operations.filter((op) => op.kind === 'submit');
    expect(submits).toHaveLength(1);
    expect(submits[0].state).toBe('failed');
  });
});
