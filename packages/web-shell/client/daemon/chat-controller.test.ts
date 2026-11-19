import { describe, expect, it } from 'vitest';
import type {
  Admission,
  ChatCapabilities,
  ComposerSubmit,
  QuestionAnswer,
} from '../chat-core/contract.js';
import { regionsToCapabilities } from '../chat-core/capabilities.js';
import {
  createDaemonChatController,
  type DaemonChatControllerDeps,
  type DaemonDecisionSettlement,
  type DaemonPromptSettlement,
} from './chat-controller.js';

function deferredAdmission() {
  let resolve!: (admission: Admission) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Admission>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const input: ComposerSubmit = { text: 'hello' };

function harness(overrides?: Partial<DaemonChatControllerDeps>) {
  let promptListener: ((e: DaemonPromptSettlement) => void) | undefined;
  let decisionListener: ((e: DaemonDecisionSettlement) => void) | undefined;
  let currencyListener:
    | ((requestId: string, live: boolean) => void)
    | undefined;
  const submitTransports: Array<{
    onAdmitted: (promptId: string) => void;
    deferred: ReturnType<typeof deferredAdmission>;
  }> = [];
  const cancelTransports: Array<ReturnType<typeof deferredAdmission>> = [];
  const permissionTransports: Array<ReturnType<typeof deferredAdmission>> = [];
  const questionTransports: Array<ReturnType<typeof deferredAdmission>> = [];

  const deps: DaemonChatControllerDeps = {
    sessionId: 's1',
    storageKey: 'daemon:s1',
    messages: [],
    transcriptState: 'ready',
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: regionsToCapabilities(['contextUsage']),
    pendingApprovals: [],
    pendingQuestions: [],
    submitPrompt: (_input, onAdmitted) => {
      const deferred = deferredAdmission();
      submitTransports.push({ onAdmitted, deferred });
      return deferred.promise;
    },
    cancelPrompt: () => {
      const deferred = deferredAdmission();
      cancelTransports.push(deferred);
      return deferred.promise;
    },
    submitPermission: () => {
      const deferred = deferredAdmission();
      permissionTransports.push(deferred);
      return deferred.promise;
    },
    submitQuestionAnswers: () => {
      const deferred = deferredAdmission();
      questionTransports.push(deferred);
      return deferred.promise;
    },
    subscribePromptSettlement: (listener) => {
      promptListener = listener;
      return () => {
        promptListener = undefined;
      };
    },
    subscribeDecisionSettlement: (listener) => {
      decisionListener = listener;
      return () => {
        decisionListener = undefined;
      };
    },
    subscribeApprovalCurrency: (listener) => {
      currencyListener = listener;
      return () => {
        currencyListener = undefined;
      };
    },
  };
  // Apply overrides preserving property descriptors so a getter-backed fact
  // stays live (object spread would flatten it to a snapshot value).
  if (overrides) {
    Object.defineProperties(deps, Object.getOwnPropertyDescriptors(overrides));
  }

  const controller = createDaemonChatController(deps);
  const shift = (
    queue: Array<ReturnType<typeof deferredAdmission>>,
    label: string,
  ) => {
    const next = queue.shift();
    if (!next) throw new Error(`no ${label} transport in flight`);
    return next;
  };
  return {
    controller,
    deps,
    admitSubmit(promptId: string, admission: Admission = 'accepted') {
      const next = submitTransports.shift();
      if (!next) throw new Error('no submit transport in flight');
      next.onAdmitted(promptId);
      next.deferred.resolve(admission);
    },
    startSubmit(promptId: string) {
      const next = submitTransports.shift();
      if (!next) throw new Error('no submit transport in flight');
      next.onAdmitted(promptId);
      return next.deferred;
    },
    holdSubmit() {
      const next = submitTransports[submitTransports.length - 1];
      if (!next) throw new Error('no submit transport in flight');
      return next;
    },
    emitPrompt(event: DaemonPromptSettlement) {
      promptListener?.(event);
    },
    emitDecision(event: DaemonDecisionSettlement) {
      decisionListener?.(event);
    },
    emitCurrency(requestId: string, live: boolean) {
      currencyListener?.(requestId, live);
    },
    resolveCancel: (admission: Admission = 'accepted') =>
      shift(cancelTransports, 'cancel').resolve(admission),
    resolvePermission: (admission: Admission = 'accepted') =>
      shift(permissionTransports, 'permission').resolve(admission),
    resolvePermissionIfPending: (admission: Admission = 'accepted') => {
      permissionTransports.shift()?.resolve(admission);
    },
    resolveQuestion: (admission: Admission = 'accepted') =>
      shift(questionTransports, 'question').resolve(admission),
    rejectCancel: () =>
      shift(cancelTransports, 'cancel').reject(new Error('x')),
    rejectPermission: () =>
      shift(permissionTransports, 'permission').reject(new Error('x')),
    rejectQuestion: () =>
      shift(questionTransports, 'question').reject(new Error('x')),
    hasPromptListener: () => promptListener !== undefined,
    hasDecisionListener: () => decisionListener !== undefined,
    hasCurrencyListener: () => currencyListener !== undefined,
  };
}

const submitOp = (controller: ReturnType<typeof harness>['controller']) =>
  controller.operations.find((op) => op.kind === 'submit');
const opsOf = (
  controller: ReturnType<typeof harness>['controller'],
  kind: string,
) => controller.operations.filter((op) => op.kind === kind);

describe('daemon controller: admission is not establishment', () => {
  it('a resolved submit transport stays unsettled until the turn settles', async () => {
    const h = harness();
    const pending = h.controller.submit(input);
    h.admitSubmit('p1');
    const result = await pending;
    expect(result.admission).toBe('accepted');
    expect(result.outcome).toBe('unsettled');
    expect(h.controller.phase).toBe('running');
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    expect(submitOp(h.controller)?.state).toBe('established');
    expect(h.controller.phase).toBe('idle');
  });

  it('a failed turn terminalizes the submit as failed', async () => {
    const h = harness();
    const pending = h.controller.submit(input);
    h.admitSubmit('p1');
    await pending;
    h.emitPrompt({ promptId: 'p1', outcome: 'failed' });
    expect(submitOp(h.controller)?.state).toBe('failed');
    expect(h.controller.phase).toBe('idle');
  });

  it('a rejected submit is not tracked and settles nothing', async () => {
    const h = harness();
    const pending = h.controller.submit(input);
    h.admitSubmit('p1', 'rejected');
    const result = await pending;
    expect(result.admission).toBe('rejected');
    expect(result.outcome).toBeUndefined();
    expect(h.controller.operations).toHaveLength(0);
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    expect(h.controller.operations).toHaveLength(0);
  });
});

describe('daemon controller: witness correlation by prompt id', () => {
  it('a late event for a finished attempt cannot establish a retry on the same target', async () => {
    const h = harness();
    const a = h.controller.submit(input);
    h.admitSubmit('pA');
    await a;
    h.emitPrompt({ promptId: 'pA', outcome: 'failed' });
    expect(submitOp(h.controller)?.state).toBe('failed');

    const b = h.controller.submit(input);
    h.admitSubmit('pB');
    await b;
    expect(submitOp(h.controller)?.state).toBe('running');

    h.emitPrompt({ promptId: 'pA', outcome: 'completed' });
    expect(submitOp(h.controller)?.state).toBe('running');
    expect(h.controller.phase).toBe('running');

    h.emitPrompt({ promptId: 'pB', outcome: 'completed' });
    expect(submitOp(h.controller)?.state).toBe('established');
  });

  it('out-of-order events keep their effect on the attempt they name', async () => {
    const h = harness();
    const a = h.controller.submit(input);
    h.admitSubmit('pA');
    await a;
    const b = h.controller.submit(input);
    h.admitSubmit('pB');
    await b;
    const [idA, idB] = opsOf(h.controller, 'submit').map((op) => op.id);
    h.emitPrompt({ promptId: 'pB', outcome: 'completed' });
    const afterB = opsOf(h.controller, 'submit');
    expect(afterB.find((op) => op.id === idB)?.state).toBe('established');
    expect(afterB.find((op) => op.id === idA)?.state).toBe('running');
    h.emitPrompt({ promptId: 'pA', outcome: 'failed' });
    expect(h.controller.phase).toBe('idle');
  });

  it('evidence delivered while the POST is in flight is applied once admission resolves', async () => {
    const h = harness();
    const pending = h.controller.submit(input);
    const deferred = h.startSubmit('pF');
    h.emitPrompt({ promptId: 'pF', outcome: 'completed' });
    expect(h.controller.phase).toBe('submitting');
    deferred.resolve('accepted');
    const result = await pending;
    expect(result.outcome).toBe('established');
    expect(submitOp(h.controller)?.state).toBe('established');
    expect(h.controller.phase).toBe('idle');
  });

  it('a terminal event for a prompt we never dispatched cannot certify a later attempt', async () => {
    const h = harness();
    h.emitPrompt({ promptId: 'pX', outcome: 'completed' });
    expect(h.controller.operations).toHaveLength(0);
    expect(h.controller.phase).toBe('idle');
    const pending = h.controller.submit(input);
    h.admitSubmit('pX');
    const result = await pending;
    expect(result.outcome).toBe('unsettled');
    expect(submitOp(h.controller)?.state).toBe('running');
  });

  it('a duplicate terminal event does not re-settle an established attempt', async () => {
    const h = harness();
    const pending = h.controller.submit(input);
    h.admitSubmit('p1');
    await pending;
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    h.emitPrompt({ promptId: 'p1', outcome: 'failed' });
    expect(submitOp(h.controller)?.state).toBe('established');
  });
});

describe('daemon controller: cancel targets the active turn', () => {
  it('a resolved cancel stays cancelling until the turn settles cancelled', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    h.admitSubmit('p1');
    await submit;
    const cancel = h.controller.cancel();
    h.resolveCancel();
    const result = await cancel;
    expect(result.admission).toBe('accepted');
    expect(result.outcome).toBe('unsettled');
    expect(h.controller.phase).toBe('cancelling');
    h.emitPrompt({ promptId: 'p1', outcome: 'cancelled' });
    expect(h.controller.phase).toBe('idle');
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('established');
  });

  it('a cancel after the turn already settled does not certify and does not latch', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    h.admitSubmit('p1');
    await submit;
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    const cancel = h.controller.cancel();
    h.resolveCancel();
    const result = await cancel;
    expect(result.outcome).not.toBe('established');
    expect(h.controller.phase).not.toBe('cancelling');
    expect(h.controller.phase).toBe('idle');
  });

  it('a cancel binds the active (FIFO-head) turn, not a queued prompt', async () => {
    const h = harness();
    const a = h.controller.submit(input);
    h.admitSubmit('pA');
    await a;
    const b = h.controller.submit(input);
    h.admitSubmit('pB');
    await b;
    const cancel = h.controller.cancel();
    h.resolveCancel();
    await cancel;
    // The active turn A is cancelled; the cancel must settle on A's event, not
    // wait for the unrelated queued prompt B to complete.
    h.emitPrompt({ promptId: 'pA', outcome: 'cancelled' });
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('established');
    expect(h.controller.phase).not.toBe('cancelling');
  });

  it('a rejected cancel in flight does not strand the submit it overlaps', async () => {
    const h = harness();
    const pending = h.controller.submit(input);
    const deferred = h.startSubmit('p1');
    // The cancel is dispatched against the live turn p1, then the turn's
    // terminal event arrives while both POSTs are in flight, then the cancel
    // resolves rejected. Binding that rejected cancel would prune p1's
    // retained in-flight witness and strand the submit.
    const cancel = h.controller.cancel();
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    h.resolveCancel('rejected');
    await cancel;
    deferred.resolve('accepted');
    const result = await pending;
    expect(result.outcome).toBe('established');
    expect(submitOp(h.controller)?.state).toBe('established');
    expect(h.controller.phase).toBe('idle');
  });
});

describe('daemon controller: approvals and questions', () => {
  it('a decision applied to a live request establishes', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    const result = await pending;
    expect(result.outcome).toBe('unsettled');
    h.emitDecision({ requestId: 'r1', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
  });

  it('a decision on a superseded request never establishes', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    h.emitCurrency('r1', false);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await pending;
    h.emitDecision({ requestId: 'r1', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('failed');
    expect(h.controller.phase).toBe('idle');
  });

  it('an accepted decision without evidence stays unsettled', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    const result = await pending;
    expect(result.outcome).toBe('unsettled');
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('unsettled');
  });

  it('a retry after a failed decision earns its own evidence', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const first = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await first;
    h.emitDecision({ requestId: 'r1', applied: false });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('failed');

    const retry = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    const retryResult = await retry;
    // The retry must not inherit the previous attempt's failed verdict.
    expect(retryResult.outcome).toBe('unsettled');
    h.emitDecision({ requestId: 'r1', applied: true });
    const approvals = opsOf(h.controller, 'approval');
    expect(approvals[approvals.length - 1]?.state).toBe('established');
  });

  it('a rejected decision dispatch does not corrupt the correlation', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const rejected = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission('rejected');
    const rejectedResult = await rejected;
    expect(rejectedResult.admission).toBe('rejected');
    expect(opsOf(h.controller, 'approval')).toHaveLength(0);

    const accepted = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await accepted;
    h.emitDecision({ requestId: 'r1', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
  });

  it('a second decision dispatch while one is live is refused', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const first = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await first;
    const secondPromise = h.controller.respondApproval('r1', 'deny');
    // If the second dispatch were not refused it would create a transport;
    // resolve it so the case fails on the row count, not a hang.
    h.resolvePermissionIfPending();
    const second = await secondPromise;
    expect(second.admission).toBe('rejected');
    expect(opsOf(h.controller, 'approval')).toHaveLength(1);
    h.emitDecision({ requestId: 'r1', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
  });

  it('a question answer applied to its request establishes', async () => {
    const h = harness();
    const answers: readonly QuestionAnswer[] = [
      { questionId: 'q1', value: 'yes' },
    ];
    const pending = h.controller.respondQuestion('q1', answers);
    h.resolveQuestion();
    await pending;
    h.emitDecision({ requestId: 'q1', applied: true });
    expect(opsOf(h.controller, 'question')[0]?.state).toBe('established');
  });
});

describe('daemon controller: pass-through facts and lifecycle', () => {
  it('exposes identity and provider facts without re-deriving them', () => {
    const capabilities: ChatCapabilities = regionsToCapabilities([
      'modelSelection',
      'sessionOps',
    ]);
    const h = harness({
      transcriptState: 'loading',
      statusFacts: { queueLength: 2, goalActive: true },
      capabilities,
    });
    expect(h.controller.kind).toBe('daemon');
    expect(h.controller.sessionId).toBe('s1');
    expect(h.controller.storageKey).toBe('daemon:s1');
    expect(h.controller.transcriptState).toBe('loading');
    expect(h.controller.statusFacts).toEqual({
      queueLength: 2,
      goalActive: true,
    });
    expect(h.controller.capabilities).toBe(capabilities);
    expect(h.controller.modelSelection).toBeUndefined();
  });

  it('reads fact fields live so a getter-backed deps stays current', () => {
    let queueLength = 0;
    const h = harness({
      get statusFacts() {
        return { queueLength, goalActive: false };
      },
    });
    expect(h.controller.statusFacts.queueLength).toBe(0);
    queueLength = 3;
    expect(h.controller.statusFacts.queueLength).toBe(3);
  });

  it('reports the settled failed phase when no operation holds it open', () => {
    const h = harness({ settledPhase: 'failed' });
    expect(h.controller.operations).toHaveLength(0);
    expect(h.controller.phase).toBe('failed');
  });

  it('releases all three evidence subscriptions when the signal aborts', () => {
    const abort = new AbortController();
    const h = harness({ signal: abort.signal });
    expect(h.hasPromptListener()).toBe(true);
    expect(h.hasDecisionListener()).toBe(true);
    expect(h.hasCurrencyListener()).toBe(true);
    abort.abort();
    expect(h.hasPromptListener()).toBe(false);
    expect(h.hasDecisionListener()).toBe(false);
    expect(h.hasCurrencyListener()).toBe(false);
  });

  it('passes through each fact field distinctly and binds loadOlder', async () => {
    const messages = [{ id: 'm1' }] as unknown as Parameters<
      typeof createDaemonChatController
    >[0]['messages'];
    const pendingApprovals = [{ id: 'a1', status: 'pending' as const }];
    const pendingQuestions = [{ id: 'q1' }];
    const approvalSelection = {
      mode: 'default',
      availableModes: ['default'],
      select: async () => ({
        admission: 'accepted' as const,
        target: { sessionId: 's1' },
      }),
    };
    const contextUsage = {
      usageKnown: true,
      compress: async () => ({
        admission: 'accepted' as const,
        target: { sessionId: 's1' },
      }),
    };
    const sessionOps = {
      rename: async () => ({
        admission: 'accepted' as const,
        target: { sessionId: 's1' },
      }),
    };
    const h = harness({
      messages,
      pendingApprovals,
      pendingQuestions,
      approvalSelection,
      contextUsage,
      sessionOps,
      // Reads a sentinel off `this`, so it only resolves 'bound' when the
      // controller keeps the deps binding.
      loadOlder(this: { loadOlderSentinel?: string }) {
        return Promise.resolve(this.loadOlderSentinel);
      },
      loadOlderSentinel: 'bound',
    } as unknown as Partial<DaemonChatControllerDeps>);
    expect(h.controller.messages).toBe(messages);
    expect(h.controller.pendingApprovals).toBe(pendingApprovals);
    expect(h.controller.pendingQuestions).toBe(pendingQuestions);
    expect(h.controller.approvalSelection).toBe(approvalSelection);
    expect(h.controller.contextUsage).toBe(contextUsage);
    expect(h.controller.sessionOps).toBe(sessionOps);
    await expect(h.controller.loadOlder?.()).resolves.toBe('bound');
    const without = harness();
    expect(without.controller.loadOlder).toBeUndefined();
  });
});

describe('daemon controller: in-flight and racing correlation', () => {
  it('a second decision dispatch while the first POST is in flight is refused', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const first = h.controller.respondApproval('r1', 'allow');
    const second = await h.controller.respondApproval('r1', 'deny');
    expect(second.admission).toBe('rejected');
    h.resolvePermission();
    await first;
    expect(opsOf(h.controller, 'approval')).toHaveLength(1);
    h.emitDecision({ requestId: 'r1', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
  });

  it('decision evidence during a retry POST settles the retry, not the previous attempt', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const first = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await first;
    h.emitDecision({ requestId: 'r1', applied: false });
    const retry = h.controller.respondApproval('r1', 'allow');
    h.emitDecision({ requestId: 'r1', applied: true });
    h.resolvePermission();
    const retryResult = await retry;
    expect(retryResult.outcome).toBe('established');
    expect(
      opsOf(h.controller, 'approval').some((o) => o.state === 'established'),
    ).toBe(true);
  });

  it('a replayed decision for a finished attempt does not establish a retry', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const first = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await first;
    const firstAttemptId = opsOf(h.controller, 'approval')[0]?.target.attemptId;
    h.emitDecision({ requestId: 'r1', applied: false });
    const retry = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await retry;
    h.emitDecision({
      requestId: 'r1',
      applied: true,
      attemptId: firstAttemptId,
    });
    // Retention lists non-terminal rows before terminal ones, so locate the
    // retry by its attempt identity rather than by position.
    const retryOp = opsOf(h.controller, 'approval').find(
      (o) => o.target.attemptId !== firstAttemptId,
    );
    expect(retryOp?.state).toBe('unsettled');
  });

  it('a rejected decision dispatch leaves no evidence for the next attempt', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const first = h.controller.respondApproval('r1', 'allow');
    h.emitDecision({ requestId: 'r1', applied: true });
    h.resolvePermission('rejected');
    await first;
    const retry = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    const retryResult = await retry;
    expect(retryResult.outcome).toBe('unsettled');
  });

  it('currency is frozen at evidence time: live then superseded still establishes', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.emitDecision({ requestId: 'r1', applied: true });
    h.emitCurrency('r1', false);
    h.resolvePermission();
    await pending;
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
  });

  it('evidence produced while superseded cannot certify even if live again at bind', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    h.emitCurrency('r1', false);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.emitDecision({ requestId: 'r1', applied: true });
    h.emitCurrency('r1', true);
    h.resolvePermission();
    await pending;
    expect(opsOf(h.controller, 'approval')[0]?.state).not.toBe('established');
  });

  it('decision evidence delivered during the POST is applied once admission resolves', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.emitDecision({ requestId: 'r1', applied: true });
    h.resolvePermission();
    const result = await pending;
    expect(result.outcome).toBe('established');
  });

  it('an orphan decision creates nothing and cannot certify a later attempt', async () => {
    const h = harness();
    h.emitDecision({ requestId: 'rX', applied: true });
    expect(h.controller.operations).toHaveLength(0);
    h.emitCurrency('r1', true);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    const result = await pending;
    expect(result.outcome).toBe('unsettled');
  });

  it('a cancel bound before its submit rejects is terminalized (order 1)', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    const deferred = h.startSubmit('p1');
    const cancel = h.controller.cancel();
    h.resolveCancel();
    await cancel;
    deferred.resolve('rejected');
    await submit;
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('failed');
    expect(h.controller.phase).toBe('idle');
  });

  it('a cancel whose submit rejected first takes the failed exit (order 2)', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    const deferred = h.startSubmit('p1');
    const cancel = h.controller.cancel();
    deferred.resolve('rejected');
    await submit;
    h.resolveCancel();
    await cancel;
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('failed');
    expect(h.controller.phase).toBe('idle');
  });

  it('a cancel still settles when a later submit supersedes its target rows', async () => {
    const h = harness();
    const a = h.controller.submit(input);
    h.admitSubmit('pA');
    await a;
    const cancel = h.controller.cancel();
    h.emitPrompt({ promptId: 'pA', outcome: 'cancelled' });
    const b = h.controller.submit(input);
    h.admitSubmit('pB');
    await b;
    h.emitPrompt({ promptId: 'pB', outcome: 'completed' });
    h.resolveCancel();
    await cancel;
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('established');
    expect(h.controller.phase).not.toBe('cancelling');
  });

  it('a submit in flight whose cancel row is superseded still settles', async () => {
    const h = harness();
    const a = h.controller.submit(input);
    const deferredA = h.startSubmit('pA');
    const cancel = h.controller.cancel();
    h.resolveCancel();
    await cancel;
    h.emitPrompt({ promptId: 'pA', outcome: 'cancelled' });
    const b = h.controller.submit(input);
    h.admitSubmit('pB');
    await b;
    const cancel2 = h.controller.cancel();
    h.resolveCancel();
    await cancel2;
    h.emitPrompt({ promptId: 'pB', outcome: 'cancelled' });
    deferredA.resolve('accepted');
    const resultA = await a;
    expect(resultA.outcome).toBe('established');
    expect(h.controller.phase).not.toBe('running');
  });

  it('a terminal event before onAdmitted settles the submit and is not a cancel target', async () => {
    const h = harness();
    const pending = h.controller.submit(input);
    const t = h.holdSubmit();
    h.emitPrompt({ promptId: 'pE', outcome: 'completed' });
    t.onAdmitted('pE');
    t.deferred.resolve('accepted');
    const result = await pending;
    expect(result.outcome).toBe('established');
    expect(h.controller.phase).toBe('idle');
    const cancel = h.controller.cancel();
    h.resolveCancel();
    const cancelResult = await cancel;
    expect(cancelResult.outcome).not.toBe('established');
  });

  it('a cancel whose target turn completes on its own is failed, not established', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    h.admitSubmit('p1');
    await submit;
    const cancel = h.controller.cancel();
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    h.resolveCancel();
    await cancel;
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('failed');
  });

  it('a rejected submit leaves no live cancel target', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    h.admitSubmit('p1', 'rejected');
    await submit;
    const cancel = h.controller.cancel();
    h.resolveCancel();
    const result = await cancel;
    expect(result.outcome).not.toBe('established');
    expect(h.controller.phase).toBe('idle');
    h.emitPrompt({ promptId: 'p1', outcome: 'cancelled' });
    expect(opsOf(h.controller, 'cancel')[0]?.state).not.toBe('established');
  });

  it('a thrown permission POST gives the approval an exit and stays answerable', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const first = h.controller.respondApproval('r1', 'allow');
    h.rejectPermission();
    await first;
    const second = h.controller.respondApproval('r1', 'deny');
    h.resolvePermission();
    const result = await second;
    expect(result.admission).toBe('accepted');
  });

  it('a thrown cancel does not latch cancelling after the turn terminal', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    h.admitSubmit('p1');
    await submit;
    const cancel = h.controller.cancel();
    h.rejectCancel();
    await cancel;
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    expect(h.controller.phase).not.toBe('cancelling');
  });

  it('a thrown submit after admission does not latch running nor leave a cancel target', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    const t = h.holdSubmit();
    t.onAdmitted('p1');
    t.deferred.reject(new Error('x'));
    await submit;
    expect(h.controller.phase).not.toBe('running');
    const cancel = h.controller.cancel();
    h.resolveCancel();
    const result = await cancel;
    expect(result.outcome).not.toBe('established');
  });
});
