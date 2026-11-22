/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../adapters/types.js';
import type { ChatCapabilities } from '../../chat-core/contract.js';
import { regionsToCapabilities } from '../../chat-core/capabilities.js';
import type {
  ManagedAgentPendingAction,
  ManagedAgentPendingPermissionAction,
  ManagedAgentPendingQuestionAction,
  ManagedAgentSessionPhase,
} from './managed-agent-provider.js';
import {
  createManagedChatController,
  MANAGED_QUESTION_DISMISS_OPTION_ID,
  MANAGED_QUESTION_SUBMIT_OPTION_ID,
  mapManagedOperationStatus,
  mapManagedPhase,
  normalizeManagedQuestionAnswers,
  toManagedQuestionPermissionRequest,
  type ManagedActionSettlement,
  type ManagedChatControllerDeps,
  type ManagedOperationSettlement,
  type ManagedTransportAdmission,
  type ManagedTurnSettlement,
} from './chat-controller.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function permissionAction(
  overrides: Partial<ManagedAgentPendingPermissionAction> = {},
): ManagedAgentPendingPermissionAction {
  return {
    actionId: 'act-1',
    sessionId: 's1',
    turnId: 't1',
    functionCallId: 'fc-1',
    toolName: 'run_shell_command',
    inputRevision: 1,
    policyRevision: 'pol-1',
    expiresAt: Date.now() + 60_000,
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ],
    ...overrides,
  };
}

function questionAction(
  overrides: Partial<ManagedAgentPendingQuestionAction> = {},
): ManagedAgentPendingQuestionAction {
  return {
    actionId: 'q-1',
    sessionId: 's1',
    turnId: 't1',
    functionCallId: 'fc-q1',
    toolName: 'ask_user_question',
    kind: 'question',
    inputRevision: 1,
    policyRevision: 'pol-1',
    expiresAt: Date.now() + 60_000,
    questions: [
      {
        id: 'env',
        prompt: 'Target environment?',
        required: true,
        multiple: false,
        allowText: false,
        options: [
          { id: 'dev', label: 'Dev', description: 'Development cluster' },
          { id: 'prod', label: 'Prod', description: 'Production cluster' },
        ],
      },
      {
        id: 'notes',
        prompt: 'Extra flags?',
        required: false,
        multiple: true,
        allowText: true,
        options: [
          { id: 'dry', label: 'Dry run' },
          { id: 'verbose', label: 'Verbose' },
        ],
      },
    ],
    ...overrides,
  };
}

function createHarness(overrides: Partial<ManagedChatControllerDeps> = {}) {
  let sessionPhase: ManagedAgentSessionPhase = 'created';
  let activeTurnId: string | undefined;
  let pendingActions: readonly ManagedAgentPendingAction[] = [];
  let messages: readonly Message[] = [];
  let transcriptState: 'loading' | 'ready' | 'error' = 'ready';
  const pagination = {
    hasOlderHistory: false,
    loadingOlderHistory: false,
    historyCapacityReached: false,
    historyPaginationError: false,
  };
  let opListener: ((e: ManagedOperationSettlement) => void) | undefined;
  let turnListener: ((e: ManagedTurnSettlement) => void) | undefined;
  let actionListener: ((e: ManagedActionSettlement) => void) | undefined;
  const unsubOp = vi.fn(() => {
    opListener = undefined;
  });
  const unsubTurn = vi.fn(() => {
    turnListener = undefined;
  });
  const unsubAction = vi.fn(() => {
    actionListener = undefined;
  });
  const submitPrompt = vi.fn(
    async (): Promise<ManagedTransportAdmission> => ({
      admission: 'accepted',
      operationId: 'op-sub-1',
      turnId: 't1',
    }),
  );
  const cancelTurn = vi.fn(
    async (): Promise<ManagedTransportAdmission> => ({
      admission: 'accepted',
      operationId: 'op-cancel-1',
    }),
  );
  const submitApproval = vi.fn(
    async (): Promise<ManagedTransportAdmission> => ({
      admission: 'accepted',
      operationId: 'op-app-1',
    }),
  );
  const submitQuestion = vi.fn(
    async (): Promise<ManagedTransportAdmission> => ({
      admission: 'accepted',
      operationId: 'op-q-1',
    }),
  );
  const loadOlder = vi.fn(async () => {});
  const capabilities: ChatCapabilities = regionsToCapabilities(['artifacts']);

  const deps: ManagedChatControllerDeps = {
    sessionId: 's1',
    storageKey: 'managed:srv:s1',
    get activeTurnId() {
      return activeTurnId;
    },
    get sessionPhase() {
      return sessionPhase;
    },
    get messages() {
      return messages;
    },
    get transcriptState() {
      return transcriptState;
    },
    get hasOlderHistory() {
      return pagination.hasOlderHistory;
    },
    get loadingOlderHistory() {
      return pagination.loadingOlderHistory;
    },
    get historyCapacityReached() {
      return pagination.historyCapacityReached;
    },
    get historyPaginationError() {
      return pagination.historyPaginationError;
    },
    loadOlder,
    get pendingActions() {
      return pendingActions;
    },
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities,
    submitPrompt,
    cancelTurn,
    submitApproval,
    submitQuestion,
    subscribeOperationSettlement: (listener) => {
      opListener = listener;
      return unsubOp;
    },
    subscribeTurnSettlement: (listener) => {
      turnListener = listener;
      return unsubTurn;
    },
    subscribeActionSettlement: (listener) => {
      actionListener = listener;
      return unsubAction;
    },
    ...overrides,
  };

  const controller = createManagedChatController(deps);

  return {
    controller,
    submitPrompt,
    cancelTurn,
    submitApproval,
    submitQuestion,
    loadOlder,
    unsubOp,
    unsubTurn,
    unsubAction,
    pagination,
    setPhase: (next: ManagedAgentSessionPhase) => {
      sessionPhase = next;
    },
    setActiveTurnId: (next: string | undefined) => {
      activeTurnId = next;
    },
    setPendingActions: (next: readonly ManagedAgentPendingAction[]) => {
      pendingActions = next;
    },
    setMessages: (next: readonly Message[]) => {
      messages = next;
    },
    setTranscriptState: (next: 'loading' | 'ready' | 'error') => {
      transcriptState = next;
    },
    emitOperation: (event: ManagedOperationSettlement) => opListener?.(event),
    emitTurn: (event: ManagedTurnSettlement) => turnListener?.(event),
    emitAction: (event: ManagedActionSettlement) => actionListener?.(event),
  };
}

describe('managed chat-controller mappings', () => {
  it('maps every ManagedAgentSessionPhase to a ChatPhase', () => {
    expect(mapManagedPhase('created')).toBe('idle');
    expect(mapManagedPhase('completed')).toBe('idle');
    expect(mapManagedPhase('cancelled')).toBe('idle');
    expect(mapManagedPhase('failed')).toBe('failed');
    expect(mapManagedPhase('cancelling')).toBe('cancelling');
    for (const running of [
      'admitted',
      'runtime_starting',
      'agent_running',
      'waiting_runtime',
      'tool_running',
    ] as const) {
      expect(mapManagedPhase(running)).toBe('running');
    }
  });

  it('maps every ManagedOperationSettlement status to a non-pending IntentState', () => {
    expect(mapManagedOperationStatus('completed')).toBe('established');
    expect(mapManagedOperationStatus('failed')).toBe('failed');
    expect(mapManagedOperationStatus('cancelled')).toBe('failed');
    expect(mapManagedOperationStatus('recovery_blocked')).toBe('unsettled');
  });

  it('converts a ManagedAgentPendingQuestionAction into an AskUserQuestion PermissionRequest', () => {
    const req = toManagedQuestionPermissionRequest(questionAction());
    expect(req.id).toBe('q-1');
    expect(req.sessionId).toBe('s1');
    expect(req.toolCallId).toBe('t1:fc-q1');
    expect(req.title).toBe('Target environment?');
    expect(req.options).toEqual([
      {
        id: MANAGED_QUESTION_SUBMIT_OPTION_ID,
        label: 'Submit',
        kind: 'allow_once',
      },
      {
        id: MANAGED_QUESTION_DISMISS_OPTION_ID,
        label: 'Dismiss',
        kind: 'reject_once',
      },
    ]);
    expect(req.rawInput?.questions).toEqual([
      {
        question: 'Target environment?',
        header: 'env',
        options: [
          { label: 'Dev', description: 'Development cluster' },
          { label: 'Prod', description: 'Production cluster' },
        ],
        multiSelect: false,
      },
      {
        question: 'Extra flags?',
        header: 'notes',
        options: [
          { label: 'Dry run', description: '' },
          { label: 'Verbose', description: '' },
        ],
        multiSelect: true,
      },
    ]);
  });

  it('normalizes decimal-indexed and id-keyed question answers and fails closed on invalid input', () => {
    const action = questionAction();
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: '0', value: 'Prod' },
        { questionId: '1', value: 'Dry run, custom note' },
      ]),
    ).toEqual([
      { questionId: 'env', optionIds: ['prod'] },
      { questionId: 'notes', optionIds: ['dry'], text: 'custom note' },
    ]);
    // Direct questionId + optionId also accepted.
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: 'env', value: 'dev' },
      ]),
    ).toEqual([{ questionId: 'env', optionIds: ['dev'] }]);
    // Missing required question -> null (fail closed).
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: 'notes', value: 'Dry run' },
      ]),
    ).toBeNull();
    // Free text when allowText is false -> null (fail closed).
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: '0', value: 'staging' },
      ]),
    ).toBeNull();
    // Unknown question id, out-of-range index, or duplicate question -> null.
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: '99', value: 'Prod' },
      ]),
    ).toBeNull();
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: 'unknown', value: 'Prod' },
      ]),
    ).toBeNull();
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: '0', value: 'Dev' },
        { questionId: 'env', value: 'Prod' },
      ]),
    ).toBeNull();
  });
});

describe('createManagedChatController', () => {
  it('projects live pass-through facts, one-hot pagination flags, and forwards loadOlder options', async () => {
    const h = createHarness();
    expect(h.controller.kind).toBe('managed');
    expect(h.controller.sessionId).toBe('s1');
    expect(h.controller.storageKey).toBe('managed:srv:s1');
    expect(h.controller.capabilities.artifacts).toBe(true);
    expect(h.controller.capabilities.terminal).toBe(false);

    const keys = [
      'hasOlderHistory',
      'loadingOlderHistory',
      'historyCapacityReached',
      'historyPaginationError',
    ] as const;
    for (let i = 0; i < keys.length; i++) {
      for (let j = 0; j < keys.length; j++) {
        h.pagination[keys[j]] = i === j;
      }
      expect([
        h.controller.hasOlderHistory,
        h.controller.loadingOlderHistory,
        h.controller.historyCapacityReached,
        h.controller.historyPaginationError,
      ]).toEqual(keys.map((_, j) => i === j));
    }

    await h.controller.loadOlder?.({ force: true });
    expect(h.loadOlder).toHaveBeenCalledWith({ force: true });
  });

  it('splits pendingActions into pendingApprovals and pendingQuestions', () => {
    const h = createHarness();
    h.setPendingActions([permissionAction(), questionAction()]);
    expect(h.controller.pendingApprovals).toHaveLength(1);
    expect(h.controller.pendingApprovals[0]?.id).toBe('act-1');
    expect(h.controller.pendingApprovals[0]?.request.toolName).toBe(
      'run_shell_command',
    );
    expect(h.controller.pendingQuestions).toHaveLength(1);
    expect(h.controller.pendingQuestions[0]?.id).toBe('q-1');
    expect(h.controller.pendingQuestions[0]?.request.title).toBe(
      'Target environment?',
    );
  });

  it('separates submit admission from establishment and settles on authoritative evidence', async () => {
    const h = createHarness();
    const d = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(d.promise);

    const submitPromise = h.controller.submit({ text: 'hello' });
    // In-flight submit lifts phase to 'submitting' before transport resolves.
    expect(h.controller.phase).toBe('submitting');
    expect(h.controller.operations).toHaveLength(1);
    expect(h.controller.operations[0]?.state).toBe('pending');
    // Snapshot identity is stable across repeated reads with no state change.
    const snap = h.controller.operations;
    expect(h.controller.operations).toBe(snap);

    d.resolve({ admission: 'accepted', operationId: 'op-1', turnId: 't1' });
    const res = await submitPromise;
    expect(res).toEqual({
      admission: 'accepted',
      outcome: 'unsettled',
      target: { sessionId: 's1' },
    });
    expect(h.controller.operations[0]?.state).toBe('pending');

    // recovery_blocked moves operation to 'unsettled', not 'established'.
    h.emitOperation({ operationId: 'op-1', status: 'recovery_blocked' });
    expect(h.controller.operations[0]?.state).toBe('unsettled');

    // Authoritative turn completion establishes the submit.
    h.emitTurn({ turnId: 't1', outcome: 'completed' });
    expect(h.controller.operations[0]?.state).toBe('established');
    expect(h.controller.phase).toBe('idle');
  });

  it('applies buffered settlement that arrives before submitPrompt resolves', async () => {
    const h = createHarness();
    const d = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(d.promise);

    const submitPromise = h.controller.submit({ text: 'fast turn' });
    h.emitOperation({ operationId: 'op-fast', status: 'completed' });
    d.resolve({
      admission: 'accepted',
      operationId: 'op-fast',
      turnId: 't-fast',
    });
    const res = await submitPromise;
    expect(res.admission).toBe('accepted');
    expect(res.outcome).toBe('established');
    expect(h.controller.operations[0]?.state).toBe('established');
  });

  it('does not track rejected submits and abandons unknown/thrown submits without latching phase', async () => {
    const h = createHarness();
    h.submitPrompt.mockResolvedValueOnce({ admission: 'rejected' });
    const rej = await h.controller.submit({ text: 'nope' });
    expect(rej).toEqual({
      admission: 'rejected',
      outcome: 'unsettled',
      target: { sessionId: 's1' },
    });
    expect(h.controller.operations).toEqual([]);
    expect(h.controller.phase).toBe('idle');

    h.submitPrompt.mockRejectedValueOnce(new Error('network lost'));
    const unk = await h.controller.submit({ text: 'lost' });
    expect(unk).toEqual({
      admission: 'unknown',
      outcome: 'unsettled',
      target: { sessionId: 's1' },
    });
    expect(h.controller.operations).toEqual([]);
    expect(h.controller.phase).toBe('idle');
  });

  it('requires an activeTurnId for cancel, stamps dispatch-time turnId on result, and projects turn outcomes', async () => {
    const h = createHarness();
    // Idle: no active turn -> fail closed without calling transport.
    const idleRes = await h.controller.cancel();
    expect(idleRes.admission).toBe('rejected');
    expect(idleRes.target.turnId).toBeUndefined();
    expect(h.cancelTurn).not.toHaveBeenCalled();

    // Active turn t1: cancel lifts phase to 'cancelling', stamps dispatch-time
    // turnId even if activeTurnId advances to t2 while cancel is in flight,
    // and keeps the retained operation target bare { sessionId }.
    h.setPhase('agent_running');
    h.setActiveTurnId('t1');
    const d = deferred<ManagedTransportAdmission>();
    h.cancelTurn.mockReturnValueOnce(d.promise);
    const cancelPromise = h.controller.cancel();
    expect(h.cancelTurn).toHaveBeenCalledWith('t1');
    expect(h.controller.phase).toBe('cancelling');

    h.setActiveTurnId('t2');
    d.resolve({ admission: 'accepted', operationId: 'op-c1' });
    const res = await cancelPromise;
    expect(res.admission).toBe('accepted');
    expect(res.target.turnId).toBe('t1');
    expect(h.controller.operations[0]?.target).toEqual({ sessionId: 's1' });

    // Turn completing on its own proves cancel did not take effect -> failed.
    h.emitTurn({ turnId: 't1', outcome: 'completed' });
    expect(h.controller.operations[0]?.state).toBe('failed');
    expect(h.controller.phase).toBe('running');

    // A second cancel on t2 that reaches 'cancelled' establishes and supersedes
    // the previous terminal cancel row (bounded per-session retention).
    const cancel2 = await h.controller.cancel();
    expect(cancel2.target.turnId).toBe('t2');
    h.emitTurn({ turnId: 't2', outcome: 'cancelled' });
    expect(h.controller.operations).toHaveLength(1);
    expect(h.controller.operations[0]?.state).toBe('established');
  });

  it('validates respondApproval and respondQuestion fail-closed and blocks concurrent duplicate dispatches', async () => {
    const h = createHarness();
    h.setPendingActions([permissionAction(), questionAction()]);

    // Unknown action or invalid option -> rejected without calling transport.
    expect(
      (await h.controller.respondApproval('missing', 'allow')).admission,
    ).toBe('rejected');
    expect(
      (await h.controller.respondApproval('act-1', 'bogus')).admission,
    ).toBe('rejected');
    expect(
      (await h.controller.respondApproval('q-1', 'submit')).admission,
    ).toBe('rejected');
    expect(h.submitApproval).not.toHaveBeenCalled();

    // Valid approval with concurrent duplicate blocked.
    const dApp = deferred<ManagedTransportAdmission>();
    h.submitApproval.mockReturnValueOnce(dApp.promise);
    const first = h.controller.respondApproval('act-1', 'allow');
    const dup = await h.controller.respondApproval('act-1', 'allow');
    expect(dup.admission).toBe('rejected');
    expect(h.submitApproval).toHaveBeenCalledTimes(1);
    dApp.resolve({ admission: 'accepted', operationId: 'op-a1' });
    expect((await first).admission).toBe('accepted');
    h.emitAction({ actionId: 'act-1', outcome: 'resolved' });
    expect(
      h.controller.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('established');

    // Question dismiss routes through respondApproval with 'deny'.
    const dismiss = await h.controller.respondApproval(
      'q-1',
      MANAGED_QUESTION_DISMISS_OPTION_ID,
    );
    expect(dismiss.admission).toBe('accepted');
    expect(h.submitApproval).toHaveBeenLastCalledWith('q-1', 'deny');

    // Question answers normalize and reject invalid payloads fail-closed.
    const badQ = await h.controller.respondQuestion('q-1', [
      { questionId: '0', value: 'invalid-free-text' },
    ]);
    expect(badQ.admission).toBe('rejected');
    expect(h.submitQuestion).not.toHaveBeenCalled();

    const goodQ = await h.controller.respondQuestion('q-1', [
      { questionId: '0', value: 'Dev' },
      { questionId: '1', value: 'Verbose, extra' },
    ]);
    expect(goodQ.admission).toBe('accepted');
    expect(h.submitQuestion).toHaveBeenCalledWith('q-1', [
      { questionId: 'env', optionIds: ['dev'] },
      { questionId: 'notes', optionIds: ['verbose'], text: 'extra' },
    ]);
    h.emitAction({ actionId: 'q-1', outcome: 'expired' });
    expect(
      h.controller.operations.find((op) => op.kind === 'question')?.state,
    ).toBe('failed');

    // Retrying an approval after a prior failed settlement must start pending
    // (must not replay the stale failed outcome from attempt 1).
    h.setPendingActions([permissionAction({ actionId: 'act-retry' })]);
    await h.controller.respondApproval('act-retry', 'allow');
    h.emitAction({ actionId: 'act-retry', outcome: 'failed' });
    const retryRes = await h.controller.respondApproval('act-retry', 'allow');
    expect(retryRes.admission).toBe('accepted');
    expect(retryRes.outcome).toBe('unsettled');
    expect(
      h.controller.operations.find(
        (op) => op.kind === 'approval' && op.target.requestId === 'act-retry',
      )?.state,
    ).toBe('pending');
    h.emitAction({ actionId: 'act-retry', outcome: 'resolved' });
    expect(
      h.controller.operations.find(
        (op) => op.kind === 'approval' && op.target.requestId === 'act-retry',
      )?.state,
    ).toBe('established');
  });

  it('releases settlement subscriptions on AbortSignal abort and skips subscribing when already aborted', () => {
    const abortController = new AbortController();
    const h = createHarness({ signal: abortController.signal });
    expect(h.unsubOp).not.toHaveBeenCalled();
    abortController.abort();
    expect(h.unsubOp).toHaveBeenCalledTimes(1);
    expect(h.unsubTurn).toHaveBeenCalledTimes(1);
    expect(h.unsubAction).toHaveBeenCalledTimes(1);

    const subOp = vi.fn(() => vi.fn());
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    createHarness({
      signal: alreadyAborted.signal,
      subscribeOperationSettlement: subOp,
    });
    expect(subOp).not.toHaveBeenCalled();
  });
});
