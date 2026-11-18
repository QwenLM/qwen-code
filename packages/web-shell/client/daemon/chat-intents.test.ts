import { describe, expect, it } from 'vitest';
import type {
  Admission,
  IntentResult,
  IntentTarget,
} from '../chat-core/contract.js';
import { createDaemonChatIntents } from './chat-intents.js';

const target: IntentTarget = { sessionId: 's1', turnId: 't1' };
const approvalTarget = (requestId: string): IntentTarget => ({
  sessionId: 's1',
  requestId,
});
const accepted = async () => 'accepted' as const;

function deferredAdmission() {
  let resolve!: (admission: Admission) => void;
  const promise = new Promise<Admission>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('daemon intents: admission is not establishment', () => {
  it('a resolved submit transport alone stays unsettled until the turn settles', async () => {
    const intents = createDaemonChatIntents();
    const { result, operationId } = await intents.dispatch(
      'submit',
      target,
      accepted,
    );
    expect(result.admission).toBe('accepted');
    expect(result.outcome).toBe('unsettled');
    expect(intents.operations.some((op) => op.kind === 'submit')).toBe(true);
    expect(intents.phase('idle')).toBe('running');

    expect(intents.settle(operationId, 'settled')?.outcome).toBe('established');
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
    expect(intents.phase('idle')).toBe('cancelling');

    expect(intents.settle(operationId, 'settled')?.outcome).toBe('established');
    expect(intents.phase('idle')).toBe('idle');
  });

  it('a superseded approval decision never establishes on positive evidence', async () => {
    const intents = createDaemonChatIntents();
    intents.setApprovalRequestLive('r1', true);
    const first = await intents.dispatch(
      'approval',
      approvalTarget('r1'),
      accepted,
    );
    // r2 supersedes r1: r1 is no longer awaiting a decision.
    intents.setApprovalRequestLive('r1', false);
    intents.setApprovalRequestLive('r2', true);

    expect(intents.settle(first.operationId, 'settled')?.outcome).toBe(
      'unsettled',
    );

    const second = await intents.dispatch(
      'approval',
      approvalTarget('r2'),
      accepted,
    );
    expect(intents.settle(second.operationId, 'settled')?.outcome).toBe(
      'established',
    );
  });

  it('an approval whose request identity is unknown never establishes', async () => {
    const intents = createDaemonChatIntents();
    const { operationId } = await intents.dispatch(
      'approval',
      { sessionId: 's1' },
      accepted,
    );
    expect(intents.settle(operationId, 'settled')?.outcome).toBe('unsettled');
  });

  it('concurrently live approval requests each establish on their own decision', async () => {
    const intents = createDaemonChatIntents();
    // The daemon keeps several permission requests pending at once.
    intents.setApprovalRequestLive('r1', true);
    intents.setApprovalRequestLive('r2', true);
    const first = await intents.dispatch(
      'approval',
      approvalTarget('r1'),
      accepted,
    );
    const second = await intents.dispatch(
      'approval',
      approvalTarget('r2'),
      accepted,
    );

    expect(intents.settle(first.operationId, 'settled')?.outcome).toBe(
      'established',
    );
    expect(intents.settle(second.operationId, 'settled')?.outcome).toBe(
      'established',
    );
  });

  it('a superseded decision that genuinely failed still terminalizes', async () => {
    const intents = createDaemonChatIntents();
    intents.setApprovalRequestLive('r1', true);
    const first = await intents.dispatch(
      'approval',
      approvalTarget('r1'),
      accepted,
    );
    intents.setApprovalRequestLive('r1', false);
    intents.setApprovalRequestLive('r2', true);

    // Negative evidence is not rewritten by the supersede guard.
    expect(intents.settle(first.operationId, 'failed')?.outcome).toBe('failed');
    expect(
      intents.operations.find((op) => op.id === first.operationId)?.state,
    ).toBe('failed');
  });
});

describe('daemon intents: witness correlation', () => {
  it('a late witness for a finished attempt cannot establish a later attempt', async () => {
    const intents = createDaemonChatIntents();
    const finished = await intents.dispatch('submit', target, accepted);
    intents.settle(finished.operationId, 'failed');
    const retry = await intents.dispatch('submit', target, accepted);

    expect(intents.settle(finished.operationId, 'settled')).toBeUndefined();
    expect(
      intents.operations.find((op) => op.id === retry.operationId)?.state,
    ).toBe('running');
    expect(intents.settle(retry.operationId, 'settled')?.outcome).toBe(
      'established',
    );
  });

  it('an already-established attempt cannot be re-settled to failed', async () => {
    const intents = createDaemonChatIntents();
    const { operationId } = await intents.dispatch('submit', target, accepted);
    intents.settle(operationId, 'settled');
    expect(intents.settle(operationId, 'failed')).toBeUndefined();
    expect(intents.operations.find((op) => op.id === operationId)?.state).toBe(
      'established',
    );
  });

  it('out-of-order evidence keeps its effect on its own attempt', async () => {
    const settleInOrder = async (order: readonly ('first' | 'second')[]) => {
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
        if (index === 0) {
          const states = new Map(
            intents.operations.map((op) => [op.id, op.state]),
          );
          const other = name === 'first' ? 'second' : 'first';
          expect(states.get(dispatched[name])).toBe(terminalOf(name));
          expect(states.get(dispatched[other])).toBe('running');
        }
      }
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

describe('daemon intents: dispatch order and in-flight identity', () => {
  it('records a pending attempt before the transport resolves', async () => {
    const intents = createDaemonChatIntents();
    const gate = deferredAdmission();
    const pending = intents.dispatch('submit', target, () => gate.promise);
    // The row exists and the phase is submitting while the request is in flight.
    expect(intents.operations.some((op) => op.state === 'pending')).toBe(true);
    expect(intents.phase('idle')).toBe('submitting');
    gate.resolve('accepted');
    await pending;
    expect(intents.phase('idle')).toBe('running');
  });

  it('retention keeps the later-dispatched attempt, not the later-resolved one', async () => {
    const intents = createDaemonChatIntents();
    const slow = deferredAdmission();
    const firstPromise = intents.dispatch('submit', target, () => slow.promise);
    // A second submit on the same target completes while the first is in flight.
    const second = await intents.dispatch('submit', target, accepted);
    slow.resolve('accepted');
    const first = await firstPromise;

    intents.settle(first.operationId, 'failed');
    intents.settle(second.operationId, 'settled');
    expect(intents.operations.map((op) => [op.id, op.state])).toEqual([
      [second.operationId, 'established'],
    ]);
  });
});

describe('daemon intents: unknown admission has an exit', () => {
  it('a thrown submit transport can be abandoned so the phase does not latch', async () => {
    const intents = createDaemonChatIntents();
    const { result, operationId } = await intents.dispatch(
      'submit',
      target,
      async () => {
        throw new Error('daemon restarting');
      },
    );
    expect(result.admission).toBe('unknown');
    expect(result.outcome).toBe('unsettled');
    expect(intents.phase('idle')).toBe('running');
    // No witness can terminalize an unknown admission through settle.
    expect(intents.settle(operationId, 'settled')?.outcome).toBe('unsettled');
    expect(intents.settle(operationId, 'failed')?.outcome).toBe('unsettled');

    intents.abandon(operationId);
    expect(intents.phase('idle')).toBe('idle');
    expect(
      intents.operations.some(
        (op) =>
          op.kind === 'submit' &&
          op.state !== 'failed' &&
          op.state !== 'established',
      ),
    ).toBe(false);
  });

  it('a thrown cancel transport can be abandoned so cancelling clears', async () => {
    const intents = createDaemonChatIntents();
    const { operationId } = await intents.dispatch(
      'cancel',
      target,
      async () => {
        throw new Error('daemon restarting');
      },
    );
    expect(intents.phase('idle')).toBe('cancelling');
    intents.abandon(operationId);
    expect(intents.phase('idle')).toBe('idle');
  });

  it('abandon never establishes and is a no-op on terminal or unknown ids', async () => {
    const intents = createDaemonChatIntents();
    const { operationId } = await intents.dispatch('submit', target, accepted);
    intents.settle(operationId, 'settled');
    expect(intents.abandon(operationId)).toBeUndefined();
    expect(intents.abandon('daemon-intent-404')).toBeUndefined();
    expect(intents.operations.find((op) => op.id === operationId)?.state).toBe(
      'established',
    );
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

  it('a failed witness produces a failed outcome', async () => {
    const intents = createDaemonChatIntents();
    const { operationId } = await intents.dispatch('submit', target, accepted);
    expect(intents.settle(operationId, 'failed')?.outcome).toBe('failed');
    expect(intents.operations.find((op) => op.id === operationId)?.state).toBe(
      'failed',
    );
  });

  it('settling an unknown intent is a no-op', () => {
    const intents = createDaemonChatIntents();
    expect(intents.settle('daemon-intent-404', 'settled')).toBeUndefined();
  });
});

describe('daemon intents: observable snapshot and retention', () => {
  it('keeps a stable operations snapshot identity between state changes', async () => {
    const intents = createDaemonChatIntents();
    expect(intents.operations).toBe(intents.operations);
    const { operationId } = await intents.dispatch('submit', target, accepted);
    const snapshot = intents.operations;
    expect(intents.operations).toBe(snapshot);
    intents.settle(operationId, 'settled');
    expect(intents.operations).not.toBe(snapshot);
    expect(intents.operations).toBe(intents.operations);
  });

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

  it('acknowledge releases a consumed terminal row and keeps the rest', async () => {
    const intents = createDaemonChatIntents();
    const first = await intents.dispatch(
      'submit',
      { sessionId: 's1', turnId: 't1' },
      accepted,
    );
    const second = await intents.dispatch(
      'submit',
      { sessionId: 's1', turnId: 't2' },
      accepted,
    );
    intents.settle(first.operationId, 'settled');
    intents.settle(second.operationId, 'settled');
    expect(intents.operations).toHaveLength(2);

    intents.acknowledge(first.operationId);
    expect(intents.operations.map((op) => op.id)).toEqual([second.operationId]);
    // Acknowledging a non-terminal row keeps it.
    const third = await intents.dispatch(
      'submit',
      { sessionId: 's1', turnId: 't3' },
      accepted,
    );
    intents.acknowledge(third.operationId);
    expect(intents.operations.some((op) => op.id === third.operationId)).toBe(
      true,
    );
  });
});

describe('daemon intents: recorded-target and evidence boundaries', () => {
  it('a caller mutating its target object cannot revive a superseded approval', async () => {
    const intents = createDaemonChatIntents();
    const mutableTarget: IntentTarget = { sessionId: 's1', requestId: 'r1' };
    intents.setApprovalRequestLive('r1', true);
    const { operationId } = await intents.dispatch(
      'approval',
      mutableTarget,
      accepted,
    );
    intents.setApprovalRequestLive('r1', false);
    intents.setApprovalRequestLive('r2', true);
    // The caller retargets the object it still holds after dispatch.
    mutableTarget.requestId = 'r2';

    expect(intents.settle(operationId, 'settled')?.outcome).toBe('unsettled');
    // The recorded row still claims the identity it was dispatched for.
    expect(
      intents.operations.find((op) => op.id === operationId)?.target.requestId,
    ).toBe('r1');
  });

  it('evidence delivered during the POST is applied once admission resolves', async () => {
    const intents = createDaemonChatIntents();
    const gate = deferredAdmission();
    const pending = intents.dispatch('cancel', target, () => gate.promise);
    // Settlement arrives while the transport is still in flight.
    const early = intents.settle(
      intents.operations.find((op) => op.kind === 'cancel')!.id,
      'settled',
    );
    expect(early?.outcome).toBe('unsettled');
    gate.resolve('accepted');
    const { operationId } = await pending;
    expect(intents.operations.find((op) => op.id === operationId)?.state).toBe(
      'established',
    );
    expect(intents.phase('idle')).toBe('idle');
  });

  it('abandon is a no-op on an accepted attempt so its evidence can still land', async () => {
    const intents = createDaemonChatIntents();
    const { operationId } = await intents.dispatch('submit', target, accepted);
    expect(intents.operations.find((op) => op.id === operationId)?.state).toBe(
      'running',
    );
    expect(intents.abandon(operationId)).toBeUndefined();
    expect(intents.operations.find((op) => op.id === operationId)?.state).toBe(
      'running',
    );
    expect(intents.settle(operationId, 'settled')?.outcome).toBe('established');
  });

  it('an approval establishes while its request is live and the engine releases it on settle', async () => {
    const intents = createDaemonChatIntents();
    intents.setApprovalRequestLive('r1', true);
    const first = await intents.dispatch(
      'approval',
      approvalTarget('r1'),
      accepted,
    );
    // Answering the request (settling it) while it is still live establishes;
    // the caller does not clear liveness on answer.
    expect(intents.settle(first.operationId, 'settled')?.outcome).toBe(
      'established',
    );
    // The engine released the identity, so a re-delivered decision for the
    // same settled request no longer establishes.
    const again = await intents.dispatch(
      'approval',
      approvalTarget('r1'),
      accepted,
    );
    expect(intents.settle(again.operationId, 'settled')?.outcome).toBe(
      'unsettled',
    );
  });
});
