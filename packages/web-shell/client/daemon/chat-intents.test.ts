import { describe, expect, it } from 'vitest';
import type { IntentTarget } from '../chat-core/contract.js';
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
    const result = await intents.dispatch('submit', target, accepted);
    // Transport success is admission only — never an established outcome.
    expect(result.admission).toBe('accepted');
    expect(result.outcome).toBe('unsettled');
    expect(intents.operations.some((op) => op.kind === 'submit')).toBe(true);
    expect(intents.phase('idle')).toBe('running');

    const settled = intents.settle('submit', target, 'settled');
    expect(settled?.outcome).toBe('established');
    expect(intents.phase('idle')).toBe('idle');
  });

  it('a resolved cancel transport keeps cancelling until settlement evidence', async () => {
    const intents = createDaemonChatIntents();
    const result = await intents.dispatch('cancel', target, accepted);
    expect(result.outcome).toBe('unsettled');
    // The cancel promise resolving does not end the cancelling phase.
    expect(intents.phase('idle')).toBe('cancelling');

    const settled = intents.settle('cancel', target, 'settled');
    expect(settled?.outcome).toBe('established');
    expect(intents.phase('idle')).toBe('idle');
  });

  it('a superseded approval decision never establishes', async () => {
    const intents = createDaemonChatIntents();
    intents.setCurrentApprovalRequest('r1');
    await intents.dispatch('approval', approvalTarget('r1'), accepted);
    // A newer request supersedes r1 before its decision is confirmed.
    intents.setCurrentApprovalRequest('r2');

    const superseded = intents.settle(
      'approval',
      approvalTarget('r1'),
      'settled',
    );
    expect(superseded?.outcome).not.toBe('established');
    expect(superseded?.outcome).toBe('unsettled');

    // Positive control: the still-current request does establish.
    await intents.dispatch('approval', approvalTarget('r2'), accepted);
    const current = intents.settle('approval', approvalTarget('r2'), 'settled');
    expect(current?.outcome).toBe('established');
  });
});

describe('daemon intents: admission handling', () => {
  it('a rejected admission carries no outcome and is not tracked', async () => {
    const intents = createDaemonChatIntents();
    const result = await intents.dispatch(
      'submit',
      target,
      async () => 'rejected',
    );
    expect(result.admission).toBe('rejected');
    expect(result.outcome).toBeUndefined();
    expect(intents.operations).toEqual([]);
    expect(intents.phase('idle')).toBe('idle');
  });

  it('a transport failure is an unknown admission that never establishes', async () => {
    const intents = createDaemonChatIntents();
    const result = await intents.dispatch('submit', target, async () => {
      throw new Error('transport down');
    });
    expect(result.admission).toBe('unknown');
    expect(result.outcome).toBe('unsettled');
    // Even a settled witness cannot establish an unknown admission.
    const settled = intents.settle('submit', target, 'settled');
    expect(settled?.outcome).toBe('unsettled');
  });

  it('a failed witness produces a failed outcome', async () => {
    const intents = createDaemonChatIntents();
    await intents.dispatch('submit', target, accepted);
    const failed = intents.settle('submit', target, 'failed');
    expect(failed?.outcome).toBe('failed');
    expect(intents.operations.find((op) => op.kind === 'submit')?.state).toBe(
      'failed',
    );
  });

  it('settling an unknown intent is a no-op', () => {
    const intents = createDaemonChatIntents();
    expect(intents.settle('submit', target, 'settled')).toBeUndefined();
  });
});

describe('daemon intents: bounded retention', () => {
  it('keeps at most the latest terminal submit per target', async () => {
    const intents = createDaemonChatIntents();
    await intents.dispatch('submit', target, accepted);
    intents.settle('submit', target, 'settled');
    await intents.dispatch('submit', target, accepted);
    intents.settle('submit', target, 'failed');
    const submits = intents.operations.filter((op) => op.kind === 'submit');
    expect(submits).toHaveLength(1);
    expect(submits[0].state).toBe('failed');
  });
});
