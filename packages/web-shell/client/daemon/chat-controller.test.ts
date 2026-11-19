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
  const cancelTransport = deferredAdmission();
  const permissionTransport = deferredAdmission();
  const questionTransport = deferredAdmission();

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
    cancelPrompt: () => cancelTransport.promise,
    submitPermission: () => permissionTransport.promise,
    submitQuestionAnswers: () => questionTransport.promise,
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
  return {
    controller,
    deps,
    // Admit the next submit with a prompt id, then resolve its admission.
    admitSubmit(promptId: string, admission: Admission = 'accepted') {
      const next = submitTransports.shift();
      if (!next) throw new Error('no submit transport in flight');
      next.onAdmitted(promptId);
      next.deferred.resolve(admission);
    },
    // Admit without resolving yet (keeps the POST in flight).
    startSubmit(promptId: string) {
      const next = submitTransports[submitTransports.length - 1];
      if (!next) throw new Error('no submit transport in flight');
      next.onAdmitted(promptId);
      return next.deferred;
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
      cancelTransport.resolve(admission),
    resolvePermission: (admission: Admission = 'accepted') =>
      permissionTransport.resolve(admission),
    resolveQuestion: (admission: Admission = 'accepted') =>
      questionTransport.resolve(admission),
    hasPromptListener: () => promptListener !== undefined,
  };
}

const submitOp = (controller: ReturnType<typeof harness>['controller']) =>
  controller.operations.find((op) => op.kind === 'submit');

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
    const retry = submitOp(h.controller);
    expect(retry?.state).toBe('running');

    // A late terminal event naming the finished attempt's prompt must not
    // establish the retry, even though both share the visible session target.
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
    const [idA, idB] = h.controller.operations
      .filter((op) => op.kind === 'submit')
      .map((op) => op.id);
    // B's event arrives first: it must establish B and leave A running, not
    // swap onto A. (Retention keeps only the latest terminal per kind+target,
    // so the discriminating assertion is made while A is still non-terminal.)
    h.emitPrompt({ promptId: 'pB', outcome: 'completed' });
    const afterB = h.controller.operations.filter((op) => op.kind === 'submit');
    expect(afterB.find((op) => op.id === idB)?.state).toBe('established');
    expect(afterB.find((op) => op.id === idA)?.state).toBe('running');
    h.emitPrompt({ promptId: 'pA', outcome: 'failed' });
    expect(h.controller.phase).toBe('idle');
  });

  it('evidence delivered while the POST is in flight is applied once admission resolves', async () => {
    const h = harness();
    const pending = h.controller.submit(input);
    const deferred = h.startSubmit('pF');
    // Terminal event arrives before dispatch returns the operation id.
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
    // An orphan terminal event (replayed history / another client's turn)
    // arrives for a prompt this controller never submitted. It must not be
    // retained as evidence that could certify a future attempt.
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

describe('daemon controller: cancel', () => {
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
    const cancelOp = h.controller.operations.find((op) => op.kind === 'cancel');
    expect(cancelOp?.state).toBe('established');
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
    const op = h.controller.operations.find((op) => op.kind === 'approval');
    expect(op?.state).toBe('established');
  });

  it('a decision on a superseded request never establishes', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    h.emitCurrency('r1', false);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    await pending;
    h.emitDecision({ requestId: 'r1', applied: true });
    const op = h.controller.operations.find((op) => op.kind === 'approval');
    expect(op?.state).toBe('failed');
    expect(h.controller.phase).toBe('idle');
  });

  it('an accepted decision without evidence stays unsettled', async () => {
    const h = harness();
    h.emitCurrency('r1', true);
    const pending = h.controller.respondApproval('r1', 'allow');
    h.resolvePermission();
    const result = await pending;
    expect(result.outcome).toBe('unsettled');
    const op = h.controller.operations.find((op) => op.kind === 'approval');
    expect(op?.state).toBe('unsettled');
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
    const op = h.controller.operations.find((op) => op.kind === 'question');
    expect(op?.state).toBe('established');
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

  it('releases evidence subscriptions when the signal aborts', () => {
    const abort = new AbortController();
    const h = harness({ signal: abort.signal });
    expect(h.hasPromptListener()).toBe(true);
    abort.abort();
    expect(h.hasPromptListener()).toBe(false);
  });
});
