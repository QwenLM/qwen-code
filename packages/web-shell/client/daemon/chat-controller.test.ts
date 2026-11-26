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
  const permissionCalls: Array<{ requestId: string; optionId: string }> = [];
  const questionCalls: Array<{
    requestId: string;
    answers: readonly QuestionAnswer[];
  }> = [];

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
    submitPermission: (requestId, optionId) => {
      permissionCalls.push({ requestId, optionId });
      const deferred = deferredAdmission();
      permissionTransports.push(deferred);
      return deferred.promise;
    },
    submitQuestionAnswers: (requestId, answers) => {
      questionCalls.push({ requestId, answers });
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
      const next = submitTransports.shift();
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
    permissionCalls,
    questionCalls,
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
    // The transport receives the request and option the surface chose.
    expect(h.permissionCalls).toEqual([{ requestId: 'r1', optionId: 'allow' }]);
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
    // The transport receives the request and the exact answers chosen.
    expect(h.questionCalls).toEqual([{ requestId: 'q1', answers }]);
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

  it('releases subscriptions when constructed with an already-aborted signal', () => {
    const h = harness({ signal: AbortSignal.abort() });
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
    // The dispatch records the pending row before the POST resolves, so the
    // refusal is decided by the live (pending) attempt itself.
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('pending');
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

  it('a decision settles the active attempt and a late duplicate is a no-op', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const first = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await first;
    h.emitDecision({ requestId: 'r1', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
    // A late/replayed event for the now-terminal attempt cannot re-settle it.
    h.emitDecision({ requestId: 'r1', applied: false });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
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
    // Single delivery while superseded: never established, and given the
    // failed terminal exit so it does not leak a permanent non-terminal row.
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('failed');
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
    // Same request id the later attempt will use: an orphan event with no
    // active attempt must not be retained to certify it.
    h.emitDecision({ requestId: 'r1', applied: true });
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
    // The first cancel settled on its own turn's terminal event.
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('established');
    const b = h.controller.submit(input);
    h.admitSubmit('pB');
    await b;
    const cancel2 = h.controller.cancel();
    h.resolveCancel();
    await cancel2;
    h.emitPrompt({ promptId: 'pB', outcome: 'cancelled' });
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('established');
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
    // A live turn behind the finished one: the cancel must target the live
    // turn, not bind the dead finished prompt at the queue head.
    const live = h.controller.submit(input);
    h.admitSubmit('pL');
    await live;
    const cancel = h.controller.cancel();
    h.resolveCancel();
    await cancel;
    h.emitPrompt({ promptId: 'pL', outcome: 'cancelled' });
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('established');
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
    // The retry is not just admitted: it can still be certified.
    h.emitDecision({ requestId: 'r1', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
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

  it('a thrown submit after admission keeps the confirmed turn cancellable', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    const t = h.holdSubmit();
    t.onAdmitted('p1');
    t.deferred.reject(new Error('x'));
    await submit;
    // The submit row takes the abandon exit (client cannot confirm admission),
    // but onAdmitted confirmed the turn, so it stays a live cancel target.
    expect(h.controller.phase).not.toBe('running');
    const cancel = h.controller.cancel();
    h.resolveCancel();
    await cancel;
    h.emitPrompt({ promptId: 'p1', outcome: 'cancelled' });
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('established');
    expect(h.controller.phase).not.toBe('cancelling');
  });

  it('two overlapping cancels on a rejected prompt both terminalize', async () => {
    const h = harness();
    const submit = h.controller.submit(input);
    const deferred = h.startSubmit('p1');
    const cancel1 = h.controller.cancel();
    const cancel2 = h.controller.cancel();
    deferred.resolve('rejected');
    await submit;
    h.resolveCancel();
    const r1 = await cancel1;
    h.resolveCancel();
    const r2 = await cancel2;
    expect(r1.outcome).toBe('failed');
    expect(r2.outcome).toBe('failed');
    expect(h.controller.phase).not.toBe('cancelling');
  });

  it('a thrown question POST gives the question an exit and stays answerable', async () => {
    const h = harness();
    const first = h.controller.respondQuestion('q1', [
      { questionId: 'q1', value: 'a' },
    ]);
    h.rejectQuestion();
    await first;
    const second = h.controller.respondQuestion('q1', [
      { questionId: 'q1', value: 'b' },
    ]);
    h.resolveQuestion();
    const result = await second;
    expect(result.admission).toBe('accepted');
    h.emitDecision({ requestId: 'q1', applied: true });
    expect(opsOf(h.controller, 'question')[0]?.state).toBe('established');
  });

  it('a second question dispatch while one is live is refused', async () => {
    const h = harness();
    const first = h.controller.respondQuestion('q1', [
      { questionId: 'q1', value: 'a' },
    ]);
    const second = await h.controller.respondQuestion('q1', [
      { questionId: 'q1', value: 'b' },
    ]);
    expect(second.admission).toBe('rejected');
    h.resolveQuestion();
    await first;
    expect(opsOf(h.controller, 'question')).toHaveLength(1);
  });

  it('seeds approval currency for requests live at construction', async () => {
    const h = harness({
      liveApprovalRequestIds: ['r1'],
      pendingApprovals: [{ id: 'r1', status: 'pending' }],
    });
    const pending = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await pending;
    h.emitDecision({ requestId: 'r1', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('established');
  });

  it('seeds from the live-id list, not pendingApprovals membership', async () => {
    // A superseded approval stays listed in pendingApprovals until confirmed;
    // it is not in liveApprovalRequestIds, so it must not be seeded live.
    const h = harness({
      liveApprovalRequestIds: [],
      pendingApprovals: [{ id: 'r2', status: 'superseded' }],
    });
    const pending = h.controller.respondApproval('r2', 'allow');
    h.resolvePermission();
    await pending;
    h.emitDecision({ requestId: 'r2', applied: true });
    expect(opsOf(h.controller, 'approval')[0]?.state).toBe('failed');
  });

  it('a decision for one request does not settle another', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    h.emitCurrency('r2', true);
    const a = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await a;
    const b = h.controller.respondApproval('r2', 'allow');
    h.resolvePermission();
    await b;
    h.emitDecision({ requestId: 'r1', applied: true });
    const ops = opsOf(h.controller, 'approval');
    expect(ops.find((o) => o.target.requestId === 'r1')?.state).toBe(
      'established',
    );
    expect(ops.find((o) => o.target.requestId === 'r2')?.state).toBe(
      'unsettled',
    );
  });

  it('a finished prompt is evicted from the cancel queue', async () => {
    const h = harness();
    const a = h.controller.submit(input);
    h.admitSubmit('pA');
    await a;
    h.emitPrompt({ promptId: 'pA', outcome: 'completed' });
    const b = h.controller.submit(input);
    h.admitSubmit('pB');
    await b;
    const cancel = h.controller.cancel();
    h.resolveCancel();
    await cancel;
    h.emitPrompt({ promptId: 'pB', outcome: 'cancelled' });
    expect(opsOf(h.controller, 'cancel')[0]?.state).toBe('established');
  });

  it('projects live history pagination facts from deps', () => {
    const flags = {
      hasOlderHistory: false,
      loadingOlderHistory: false,
      historyCapacityReached: false,
      historyPaginationError: false,
    };
    const h = harness({
      get hasOlderHistory() {
        return flags.hasOlderHistory;
      },
      get loadingOlderHistory() {
        return flags.loadingOlderHistory;
      },
      get historyCapacityReached() {
        return flags.historyCapacityReached;
      },
      get historyPaginationError() {
        return flags.historyPaginationError;
      },
    });
    expect([
      h.controller.hasOlderHistory,
      h.controller.loadingOlderHistory,
      h.controller.historyCapacityReached,
      h.controller.historyPaginationError,
    ]).toEqual([false, false, false, false]);
    const keys = [
      'hasOlderHistory',
      'loadingOlderHistory',
      'historyCapacityReached',
      'historyPaginationError',
    ] as const;
    for (let i = 0; i < keys.length; i++) {
      for (let j = 0; j < keys.length; j++) {
        flags[keys[j]] = i === j;
      }
      expect([
        h.controller.hasOlderHistory,
        h.controller.loadingOlderHistory,
        h.controller.historyCapacityReached,
        h.controller.historyPaginationError,
      ]).toEqual(keys.map((_, j) => i === j));
    }
  });

  it('tracks activeTurnId along the FIFO prompt queue and stamps it on cancel results', async () => {
    const h = harness();
    expect(h.controller.activeTurnId).toBeUndefined();
    const s1 = h.controller.submit(input);
    h.admitSubmit('p1');
    await s1;
    expect(h.controller.activeTurnId).toBe('p1');
    // Queueing p2 behind p1 keeps p1 as the active cancel target.
    const s2 = h.controller.submit(input);
    h.admitSubmit('p2');
    await s2;
    expect(h.controller.activeTurnId).toBe('p1');
    // Emit p1's terminal settlement while cancel1 is still in flight so the
    // queue head advances to p2 before cancel1 settles: the returned target
    // must still carry the dispatch-time subject ('p1'), not the settle-time
    // head ('p2') (pins R2-3 against a settle-time queue read).
    const cancel1 = h.controller.cancel();
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    expect(h.controller.activeTurnId).toBe('p2');
    h.resolveCancel('unknown');
    const res1 = await cancel1;
    expect(res1.admission).toBe('unknown');
    expect(res1.target.turnId).toBe('p1');
    const cancel2 = h.controller.cancel();
    h.resolveCancel('rejected');
    const res2 = await cancel2;
    expect(res2.admission).toBe('rejected');
    expect(res2.target.turnId).toBe('p2');
    h.emitPrompt({ promptId: 'p2', outcome: 'completed' });
    expect(h.controller.activeTurnId).toBeUndefined();
    const idleCancel = h.controller.cancel();
    h.resolveCancel('rejected');
    const resIdle = await idleCancel;
    expect(resIdle.target.turnId).toBeUndefined();
  });

  it('seeds and deduplicates livePromptIds so a re-created controller keeps its FIFO head without latching settled prompts', () => {
    const h = harness({ livePromptIds: ['p1', 'p1', '', 'p2'] });
    expect(h.controller.activeTurnId).toBe('p1');
    h.emitPrompt({ promptId: 'p1', outcome: 'completed' });
    // Deduplication ensures one terminal event clears p1 instead of leaving a
    // duplicate p1 latched at the FIFO head.
    expect(h.controller.activeTurnId).toBe('p2');
    h.emitPrompt({ promptId: 'p2', outcome: 'completed' });
    expect(h.controller.activeTurnId).toBeUndefined();
  });
});
