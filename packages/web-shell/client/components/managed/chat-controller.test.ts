/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../adapters/types.js';
import type {
  ApprovalSelectionController,
  ChatCapabilities,
  ChatStatusFacts,
  ContextUsageController,
  ModelSelectionController,
  SessionOpsController,
} from '../../chat-core/contract.js';
import { regionsToCapabilities } from '../../chat-core/capabilities.js';
import type {
  ManagedAgentPendingAction,
  ManagedAgentPendingPermissionAction,
  ManagedAgentPendingQuestionAction,
  ManagedAgentSessionPhase,
} from './managed-agent-provider.js';
import {
  createManagedChatController,
  MANAGED_QUESTION_SUBMIT_OPTION_ID,
  MAX_MANAGED_QUESTION_TEXT_LENGTH,
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
  // Matches the server-emitted shape (required: true, allowText: true).
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
        allowText: true,
        options: [
          { id: 'dev', label: 'Dev', description: 'Development cluster' },
          { id: 'prod', label: 'Prod', description: 'Production cluster' },
        ],
      },
      {
        id: 'notes',
        prompt: 'Extra flags?',
        required: true,
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
  let statusFacts: ChatStatusFacts = { queueLength: 0, goalActive: false };
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
    get statusFacts() {
      return statusFacts;
    },
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
    setStatusFacts: (next: ChatStatusFacts) => {
      statusFacts = next;
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

  it('converts a ManagedAgentPendingQuestionAction into an AskUserQuestion PermissionRequest with submit option only (R1-3)', () => {
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

  it('normalizes decimal-indexed and id-keyed question answers and fails closed on invalid or over-cap input', () => {
    const action = questionAction();
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: '0', value: 'Prod' },
        { questionId: '1', value: 'Verbose, Dry run' },
      ]),
    ).toEqual([
      { questionId: 'env', optionIds: ['prod'] },
      // Canonical option order from canonicalQuestionAnswers ('dry' before 'verbose').
      { questionId: 'notes', optionIds: ['dry', 'verbose'] },
    ]);
    // Direct questionId + optionId + free text also accepted.
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: 'env', value: 'dev' },
        { questionId: 'notes', value: 'custom free text' },
      ]),
    ).toEqual([
      { questionId: 'env', optionIds: ['dev'] },
      { questionId: 'notes', text: 'custom free text' },
    ]);
    // Missing required question -> null (fail closed).
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: 'notes', value: 'Dry run' },
      ]),
    ).toBeNull();
    // Unknown question id, out-of-range index, or duplicate question -> null
    // even when every required question is answered (pins the lookup/dedupe guards).
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: 'env', value: 'Prod' },
        { questionId: 'notes', value: 'Dry run' },
        { questionId: '99', value: 'extra' },
      ]),
    ).toBeNull();
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: 'env', value: 'Prod' },
        { questionId: 'notes', value: 'Dry run' },
        { questionId: 'unknown', value: 'extra' },
      ]),
    ).toBeNull();
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: '0', value: 'Dev' },
        { questionId: 'env', value: 'Prod' },
        { questionId: 'notes', value: 'Dry run' },
      ]),
    ).toBeNull();

    // R2-2: (a) optional blank answer skips cleanly, (b) single-select with
    // allowText: false rejects non-matching text, and (c) exactly 8192 chars is accepted.
    const optionalAndStrict = questionAction({
      questions: [
        {
          id: 'opt',
          prompt: 'Optional note?',
          required: false,
          multiple: false,
          allowText: true,
          options: [],
        },
        {
          id: 'strict',
          prompt: 'Pick strictly',
          required: true,
          multiple: false,
          allowText: false,
          options: [{ id: 'a', label: 'A' }],
        },
      ],
    });
    expect(
      normalizeManagedQuestionAnswers(optionalAndStrict, [
        { questionId: 'opt', value: '   ' },
        { questionId: 'strict', value: 'A' },
      ]),
    ).toEqual([
      { questionId: 'opt' },
      { questionId: 'strict', optionIds: ['a'] },
    ]);
    expect(
      normalizeManagedQuestionAnswers(optionalAndStrict, [
        { questionId: 'strict', value: 'custom words' },
      ]),
    ).toBeNull();
    const exactLimitText = 'z'.repeat(MAX_MANAGED_QUESTION_TEXT_LENGTH);
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: '0', value: exactLimitText },
        { questionId: '1', value: 'Dry run' },
      ]),
    ).toEqual([
      { questionId: 'env', text: exactLimitText },
      { questionId: 'notes', optionIds: ['dry'] },
    ]);

    // R1-5: single text over 8192 chars -> null (both single- and multi-select);
    // combined payload over 32 KiB -> null.
    expect(
      normalizeManagedQuestionAnswers(action, [
        {
          questionId: '0',
          value: 'x'.repeat(MAX_MANAGED_QUESTION_TEXT_LENGTH + 1),
        },
        { questionId: '1', value: 'Dry run' },
      ]),
    ).toBeNull();
    expect(
      normalizeManagedQuestionAnswers(action, [
        { questionId: '0', value: 'Dev' },
        {
          questionId: '1',
          value: 'y'.repeat(MAX_MANAGED_QUESTION_TEXT_LENGTH + 1),
        },
      ]),
    ).toBeNull();
    const fiveQuestions = questionAction({
      questions: Array.from({ length: 5 }, (_, idx) => ({
        id: `q${idx}`,
        prompt: `Question ${idx}`,
        required: true,
        multiple: false,
        allowText: true,
        options: [],
      })),
    });
    expect(
      normalizeManagedQuestionAnswers(
        fiveQuestions,
        Array.from({ length: 5 }, (_, idx) => ({
          questionId: String(idx),
          value: 'a'.repeat(7000),
        })),
      ),
    ).toBeNull();
  });

  it('decodes multi-select comma labels intact and keeps free text beginning with a label verbatim (F1 / R1-2)', () => {
    const withText = questionAction({
      questions: [
        {
          id: 'q',
          prompt: 'Pick options',
          required: true,
          multiple: true,
          allowText: true,
          options: [
            { id: 'yes', label: 'Yes, please' },
            { id: 'n', label: 'No' },
            { id: 'ny', label: 'No, thanks' },
            { id: 'dry', label: 'Dry run' },
            { id: 'verbose', label: 'Verbose' },
          ],
        },
      ],
    });
    // Single comma-containing label matches its option id, not free text.
    expect(
      normalizeManagedQuestionAnswers(withText, [
        { questionId: '0', value: 'Yes, please' },
      ]),
    ).toEqual([{ questionId: 'q', optionIds: ['yes'] }]);
    // Longer comma-containing label wins over shorter prefix option ("No").
    expect(
      normalizeManagedQuestionAnswers(withText, [
        { questionId: '0', value: 'No, thanks' },
      ]),
    ).toEqual([{ questionId: 'q', optionIds: ['ny'] }]);
    // Mixed selections combining plain and comma-containing labels decode cleanly in canonical order.
    expect(
      normalizeManagedQuestionAnswers(withText, [
        { questionId: '0', value: 'No, No, thanks' },
      ]),
    ).toEqual([{ questionId: 'q', optionIds: ['n', 'ny'] }]);
    expect(
      normalizeManagedQuestionAnswers(withText, [
        { questionId: '0', value: 'No, thanks, No' },
      ]),
    ).toEqual([{ questionId: 'q', optionIds: ['n', 'ny'] }]);
    // R1-2a: free text beginning with an option label followed by a comma stays pure text
    // (never invents optionIds: ['verbose'] or truncates the leading half).
    expect(
      normalizeManagedQuestionAnswers(withText, [
        { questionId: '0', value: 'Verbose, but only for the parser' },
      ]),
    ).toEqual([{ questionId: 'q', text: 'Verbose, but only for the parser' }]);
    // Non-boundary prefix ("No way"), space-joined option labels ("No Verbose"),
    // and mixed option + free text ("Dry run, --a, --b") stay verbatim text (G3).
    expect(
      normalizeManagedQuestionAnswers(withText, [
        { questionId: '0', value: 'No way' },
      ]),
    ).toEqual([{ questionId: 'q', text: 'No way' }]);
    expect(
      normalizeManagedQuestionAnswers(withText, [
        { questionId: '0', value: 'No Verbose' },
      ]),
    ).toEqual([{ questionId: 'q', text: 'No Verbose' }]);
    expect(
      normalizeManagedQuestionAnswers(withText, [
        { questionId: '0', value: 'Dry run, --a, --b' },
      ]),
    ).toEqual([{ questionId: 'q', text: 'Dry run, --a, --b' }]);

    // R1-2: join collision ("Alpha" + "Beta" vs "Alpha, Beta") and duplicate
    // option labels ("Same, label" on two ids) must fail closed (never guess).
    const collidingMulti = questionAction({
      questions: [
        {
          id: 'q',
          prompt: 'Pick',
          required: true,
          multiple: true,
          allowText: true,
          options: [
            { id: 'a', label: 'Alpha' },
            { id: 'b', label: 'Beta' },
            { id: 'c', label: 'Alpha, Beta' },
          ],
        },
      ],
    });
    expect(
      normalizeManagedQuestionAnswers(collidingMulti, [
        { questionId: '0', value: 'Alpha, Beta' },
      ]),
    ).toBeNull();

    const dupLabelMulti = questionAction({
      questions: [
        {
          id: 'q',
          prompt: 'Pick',
          required: true,
          multiple: true,
          allowText: true,
          options: [
            { id: 'q1o1', label: 'Same, label' },
            { id: 'q1o2', label: 'Same, label' },
          ],
        },
      ],
    });
    expect(
      normalizeManagedQuestionAnswers(dupLabelMulti, [
        { questionId: '0', value: 'Same, label' },
      ]),
    ).toBeNull();

    const dupLabelSingle = questionAction({
      questions: [
        {
          id: 'q',
          prompt: 'Pick one',
          required: true,
          multiple: false,
          allowText: true,
          options: [
            { id: 'q1o1', label: 'Same, label' },
            { id: 'q1o2', label: 'Same, label' },
          ],
        },
      ],
    });
    expect(
      normalizeManagedQuestionAnswers(dupLabelSingle, [
        { questionId: '0', value: 'Same, label' },
      ]),
    ).toBeNull();
    // Explicit option id remains unambiguous even when labels collide.
    expect(
      normalizeManagedQuestionAnswers(dupLabelSingle, [
        { questionId: '0', value: 'q1o2' },
      ]),
    ).toEqual([{ questionId: 'q', optionIds: ['q1o2'] }]);

    // allowText: false still accepts comma-containing option labels and rejects non-option text.
    const noText = questionAction({
      questions: [
        {
          id: 'q',
          prompt: 'Pick options',
          required: true,
          multiple: true,
          allowText: false,
          options: [
            { id: 'yes', label: 'Yes, please' },
            { id: 'n', label: 'No' },
          ],
        },
      ],
    });
    expect(
      normalizeManagedQuestionAnswers(noText, [
        { questionId: '0', value: 'Yes, please' },
      ]),
    ).toEqual([{ questionId: 'q', optionIds: ['yes'] }]);
    expect(
      normalizeManagedQuestionAnswers(noText, [
        { questionId: '0', value: 'Yes, please, rogue' },
      ]),
    ).toBeNull();
  });
});

describe('createManagedChatController', () => {
  it('projects live pass-through facts, sub-controllers, one-hot pagination flags, and forwards loadOlder options', async () => {
    const modelSelection = {
      tag: 'model',
    } as unknown as ModelSelectionController;
    const approvalSelection = {
      tag: 'approval',
    } as unknown as ApprovalSelectionController;
    const contextUsage = {
      tag: 'context',
    } as unknown as ContextUsageController;
    const sessionOps = { tag: 'ops' } as unknown as SessionOpsController;
    const h = createHarness({
      modelSelection,
      approvalSelection,
      contextUsage,
      sessionOps,
    });
    expect(h.controller.kind).toBe('managed');
    expect(h.controller.sessionId).toBe('s1');
    expect(h.controller.storageKey).toBe('managed:srv:s1');
    expect(h.controller.capabilities.artifacts).toBe(true);
    expect(h.controller.capabilities.terminal).toBe(false);
    expect(h.controller.modelSelection).toBe(modelSelection);
    expect(h.controller.approvalSelection).toBe(approvalSelection);
    expect(h.controller.contextUsage).toBe(contextUsage);
    expect(h.controller.sessionOps).toBe(sessionOps);

    const sentinelMessages = [{ id: 'm1' }] as unknown as readonly Message[];
    h.setMessages(sentinelMessages);
    h.setTranscriptState('loading');
    const sentinelStatus: ChatStatusFacts = {
      queueLength: 2,
      goalActive: true,
    };
    h.setStatusFacts(sentinelStatus);
    expect(h.controller.messages).toBe(sentinelMessages);
    expect(h.controller.transcriptState).toBe('loading');
    expect(h.controller.statusFacts).toBe(sentinelStatus);

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

  it('applies buffered early settlements for operation, submit turn, cancel turn, approval, and question (R1-6)', async () => {
    const h = createHarness();
    h.setPendingActions([permissionAction(), questionAction()]);

    // 1. Operation settlement arriving before submitPrompt resolves.
    const dOp = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(dOp.promise);
    const pOp = h.controller.submit({ text: 'fast op' });
    h.emitOperation({ operationId: 'op-fast', status: 'completed' });
    dOp.resolve({
      admission: 'accepted',
      operationId: 'op-fast',
      turnId: 't-op',
    });
    expect((await pOp).outcome).toBe('established');

    // 2. Turn settlement arriving before submitPrompt resolves.
    const dSub = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(dSub.promise);
    const pSub = h.controller.submit({ text: 'fast turn' });
    h.emitTurn({ turnId: 't-sub', outcome: 'failed' });
    dSub.resolve({
      admission: 'accepted',
      operationId: 'op-sub',
      turnId: 't-sub',
    });
    expect((await pSub).outcome).toBe('failed');

    // 3. Turn settlement arriving before cancelTurn resolves.
    h.setActiveTurnId('t-can');
    const dCan = deferred<ManagedTransportAdmission>();
    h.cancelTurn.mockReturnValueOnce(dCan.promise);
    const pCan = h.controller.cancel();
    h.emitTurn({ turnId: 't-can', outcome: 'cancelled' });
    dCan.resolve({ admission: 'accepted', operationId: 'op-can' });
    expect((await pCan).outcome).toBe('established');

    // 4. Action settlement arriving before submitApproval resolves.
    const dApp = deferred<ManagedTransportAdmission>();
    h.submitApproval.mockReturnValueOnce(dApp.promise);
    const pApp = h.controller.respondApproval('act-1', 'allow');
    h.emitAction({ actionId: 'act-1', outcome: 'resolved' });
    dApp.resolve({ admission: 'accepted', operationId: 'op-a-early' });
    expect((await pApp).outcome).toBe('established');

    // 5. Action settlement arriving before submitQuestion resolves.
    const dQ = deferred<ManagedTransportAdmission>();
    h.submitQuestion.mockReturnValueOnce(dQ.promise);
    const pQ = h.controller.respondQuestion('q-1', [
      { questionId: '0', value: 'Dev' },
      { questionId: '1', value: 'Verbose' },
    ]);
    h.emitAction({ actionId: 'q-1', outcome: 'resolved' });
    dQ.resolve({ admission: 'accepted', operationId: 'op-q-early' });
    expect((await pQ).outcome).toBe('established');
  });

  it('omits outcome on rejected submits and abandons resolved-unknown and thrown submits without latching phase (R1-4 / R1-6)', async () => {
    const h = createHarness();
    h.submitPrompt.mockResolvedValueOnce({ admission: 'rejected' });
    const rej = await h.controller.submit({ text: 'nope' });
    expect(rej).toEqual({
      admission: 'rejected',
      target: { sessionId: 's1' },
    });
    expect(rej.outcome).toBeUndefined();
    expect(h.controller.operations).toEqual([]);
    expect(h.controller.phase).toBe('idle');

    // Resolved { admission: 'unknown' } (distinct from thrown transport).
    h.submitPrompt.mockResolvedValueOnce({ admission: 'unknown' });
    const unkResolved = await h.controller.submit({ text: 'uncertain' });
    expect(unkResolved).toEqual({
      admission: 'unknown',
      outcome: 'unsettled',
      target: { sessionId: 's1' },
    });
    expect(h.controller.operations).toEqual([]);
    expect(h.controller.phase).toBe('idle');

    // Thrown transport.
    h.submitPrompt.mockRejectedValueOnce(new Error('network lost'));
    const unkThrown = await h.controller.submit({ text: 'lost' });
    expect(unkThrown).toEqual({
      admission: 'unknown',
      outcome: 'unsettled',
      target: { sessionId: 's1' },
    });
    expect(h.controller.operations).toEqual([]);
    expect(h.controller.phase).toBe('idle');
  });

  it('requires activeTurnId for cancel, keeps cancelling phase on recovery_blocked, stamps dispatch-time turnId, and projects turn outcomes (R1-7)', async () => {
    const h = createHarness();
    // Idle: no active turn -> fail closed without calling transport, outcome omitted.
    const idleRes = await h.controller.cancel();
    expect(idleRes).toEqual({
      admission: 'rejected',
      target: { sessionId: 's1' },
    });
    expect(idleRes.outcome).toBeUndefined();
    expect(h.cancelTurn).not.toHaveBeenCalled();

    // Active turn t1: cancel lifts phase to 'cancelling', stays 'cancelling' on
    // recovery_blocked (unsettled), stamps dispatch-time turnId even if
    // activeTurnId advances while cancel is in flight, and keeps retained target bare.
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

    // R1-7: recovery_blocked -> unsettled cancel must keep phase === 'cancelling'.
    h.emitOperation({ operationId: 'op-c1', status: 'recovery_blocked' });
    expect(h.controller.operations[0]?.state).toBe('unsettled');
    expect(h.controller.phase).toBe('cancelling');

    // Turn completing on its own proves cancel did not take effect -> failed.
    h.emitTurn({ turnId: 't1', outcome: 'completed' });
    expect(h.controller.operations[0]?.state).toBe('failed');
    expect(h.controller.phase).toBe('running');

    // Second cancel on t2 that reaches 'cancelled' establishes and supersedes
    // the previous terminal cancel row.
    const cancel2 = await h.controller.cancel();
    expect(cancel2.target.turnId).toBe('t2');
    h.emitTurn({ turnId: 't2', outcome: 'cancelled' });
    expect(h.controller.operations).toHaveLength(1);
    expect(h.controller.operations[0]?.state).toBe('established');
  });

  it('does not let terminal rows absorb settlements needed by a later in-flight cancel or approval retry (R1-1)', async () => {
    const h = createHarness();
    h.setPendingActions([permissionAction({ actionId: 'act-r1' })]);

    // Case 1: submit admitted with t1 and already terminal via operation settlement;
    // cancel(t1) is in flight while emitTurn(t1, 'cancelled') arrives.
    h.setPhase('agent_running');
    h.setActiveTurnId('t1');
    await h.controller.submit({ text: 'run' });
    h.emitOperation({ operationId: 'op-sub-1', status: 'completed' });
    expect(
      h.controller.operations.find((op) => op.kind === 'submit')?.state,
    ).toBe('established');

    const dCan = deferred<ManagedTransportAdmission>();
    h.cancelTurn.mockReturnValueOnce(dCan.promise);
    const cancelPromise = h.controller.cancel();
    expect(h.controller.phase).toBe('cancelling');
    h.emitTurn({ turnId: 't1', outcome: 'cancelled' });
    dCan.resolve({ admission: 'accepted', operationId: 'op-c-r1' });
    const cancelRes = await cancelPromise;
    expect(cancelRes.admission).toBe('accepted');
    expect(cancelRes.outcome).toBe('established');
    expect(
      h.controller.operations.find((op) => op.kind === 'cancel')?.state,
    ).toBe('established');
    expect(h.controller.phase).toBe('running');

    // Case 2: approval attempt 1 settles 'failed' (terminal row stays in tracked);
    // retry's 'resolved' settlement arrives mid-POST and must establish attempt 2.
    await h.controller.respondApproval('act-r1', 'allow');
    h.emitAction({ actionId: 'act-r1', outcome: 'failed' });
    expect(
      h.controller.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('failed');

    const dRetry = deferred<ManagedTransportAdmission>();
    h.submitApproval.mockReturnValueOnce(dRetry.promise);
    const retryPromise = h.controller.respondApproval('act-r1', 'allow');
    h.emitAction({ actionId: 'act-r1', outcome: 'resolved' });
    dRetry.resolve({ admission: 'accepted', operationId: 'op-a-r2' });
    const retryRes = await retryPromise;
    expect(retryRes.admission).toBe('accepted');
    expect(retryRes.outcome).toBe('established');
    expect(
      h.controller.operations.find((op) => op.kind === 'approval')?.state,
    ).toBe('established');
  });

  it('validates respondApproval and respondQuestion fail-closed, rejects question dismiss via submitApproval, blocks duplicates, and fails superseded approvals (R1-3 / R1-5 / R1-6)', async () => {
    const h = createHarness();
    h.setPendingActions([
      permissionAction({ actionId: 'act-1' }),
      permissionAction({ actionId: 'act-sup' }),
      questionAction(),
    ]);

    // Unknown action, invalid option, or question action via respondApproval -> rejected (no outcome).
    for (const [id, opt] of [
      ['missing', 'allow'],
      ['act-1', 'bogus'],
      ['q-1', 'deny'],
      ['q-1', 'submit'],
    ] as const) {
      const res = await h.controller.respondApproval(id, opt);
      expect(res.admission).toBe('rejected');
      expect(res.outcome).toBeUndefined();
    }
    expect(h.submitApproval).not.toHaveBeenCalled();

    // Valid approval with concurrent duplicate blocked.
    const dApp = deferred<ManagedTransportAdmission>();
    h.submitApproval.mockReturnValueOnce(dApp.promise);
    const first = h.controller.respondApproval('act-1', 'allow');
    const dup = await h.controller.respondApproval('act-1', 'allow');
    expect(dup.admission).toBe('rejected');
    expect(dup.outcome).toBeUndefined();
    expect(h.submitApproval).toHaveBeenCalledTimes(1);
    dApp.resolve({ admission: 'accepted', operationId: 'op-a1' });
    expect((await first).admission).toBe('accepted');
    h.emitAction({ actionId: 'act-1', outcome: 'resolved' });
    expect(
      h.controller.operations.find(
        (op) => op.kind === 'approval' && op.target.requestId === 'act-1',
      )?.state,
    ).toBe('established');

    // Design-mandated negative test: superseded approval never establishes.
    await h.controller.respondApproval('act-sup', 'allow');
    h.emitAction({ actionId: 'act-sup', outcome: 'superseded' });
    expect(
      h.controller.operations.find(
        (op) => op.kind === 'approval' && op.target.requestId === 'act-sup',
      )?.state,
    ).toBe('failed');

    // R1-5: over-cap question answer fails closed before calling submitQuestion.
    const overCap = await h.controller.respondQuestion('q-1', [
      {
        questionId: '0',
        value: 'x'.repeat(MAX_MANAGED_QUESTION_TEXT_LENGTH + 1),
      },
      { questionId: '1', value: 'Dry run' },
    ]);
    expect(overCap.admission).toBe('rejected');
    expect(overCap.outcome).toBeUndefined();
    expect(h.submitQuestion).not.toHaveBeenCalled();

    // R1-6: respondQuestion concurrent duplicate guard.
    const dQ = deferred<ManagedTransportAdmission>();
    h.submitQuestion.mockReturnValueOnce(dQ.promise);
    const firstQ = h.controller.respondQuestion('q-1', [
      { questionId: '0', value: 'Dev' },
      { questionId: '1', value: 'Verbose' },
    ]);
    const dupQ = await h.controller.respondQuestion('q-1', [
      { questionId: '0', value: 'Dev' },
      { questionId: '1', value: 'Verbose' },
    ]);
    expect(dupQ.admission).toBe('rejected');
    expect(dupQ.outcome).toBeUndefined();
    expect(h.submitQuestion).toHaveBeenCalledTimes(1);
    expect(h.submitQuestion).toHaveBeenCalledWith('q-1', [
      { questionId: 'env', optionIds: ['dev'] },
      { questionId: 'notes', optionIds: ['verbose'] },
    ]);
    dQ.resolve({ admission: 'accepted', operationId: 'op-q1' });
    expect((await firstQ).admission).toBe('accepted');
    h.emitAction({ actionId: 'q-1', outcome: 'expired' });
    expect(
      h.controller.operations.find((op) => op.kind === 'question')?.state,
    ).toBe('failed');
  });

  it('consumes buffered settlements once and prunes buffers on rejected drain (C19 / C21)', async () => {
    const h = createHarness();
    h.setPendingActions([
      permissionAction({ actionId: 'act-c19' }),
      permissionAction({ actionId: 'act-c21' }),
    ]);

    // C19 (M03): hold a concurrent submit in flight so inFlightDispatches stays > 0,
    // buffer an action failure and an operation failure, let attempt 1 consume
    // them, then retry while the submit is still in flight — both retries must
    // start pending instead of replaying the already-consumed buffer entries.
    const heldSubmit = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(heldSubmit.promise);
    const concurrentSubmit = h.controller.submit({ text: 'hold drain open' });

    const dApp1 = deferred<ManagedTransportAdmission>();
    h.submitApproval.mockReturnValueOnce(dApp1.promise);
    const app1 = h.controller.respondApproval('act-c19', 'allow');
    h.emitAction({ actionId: 'act-c19', outcome: 'failed' });
    dApp1.resolve({ admission: 'accepted', operationId: 'op-c19-1' });
    expect((await app1).outcome).toBe('failed');

    const app2 = await h.controller.respondApproval('act-c19', 'allow');
    expect(app2.admission).toBe('accepted');
    expect(app2.outcome).toBe('unsettled');

    const dSub1 = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(dSub1.promise);
    const sub1 = h.controller.submit({ text: 'op buffer consume' });
    h.emitOperation({ operationId: 'op-shared', status: 'failed' });
    dSub1.resolve({ admission: 'accepted', operationId: 'op-shared' });
    expect((await sub1).outcome).toBe('failed');

    const dSub2 = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(dSub2.promise);
    const sub2 = h.controller.submit({ text: 'op buffer retry' });
    dSub2.resolve({ admission: 'accepted', operationId: 'op-shared' });
    expect((await sub2).outcome).toBe('unsettled');

    heldSubmit.resolve({ admission: 'rejected' });
    await concurrentSubmit;

    // C21 (M04 / M12): with no other dispatch in flight, buffer an action
    // settlement during an attempt that is rejected, then retry — pruneBuffers
    // must have cleared the orphan buffer so the retry starts pending.
    const dRej = deferred<ManagedTransportAdmission>();
    h.submitApproval.mockReturnValueOnce(dRej.promise);
    const rejAttempt = h.controller.respondApproval('act-c21', 'allow');
    h.emitAction({ actionId: 'act-c21', outcome: 'failed' });
    dRej.resolve({ admission: 'rejected' });
    expect((await rejAttempt).admission).toBe('rejected');

    const afterRej = await h.controller.respondApproval('act-c21', 'allow');
    expect(afterRej.admission).toBe('accepted');
    expect(afterRej.outcome).toBe('unsettled');

    // R2-1 (1): idle-side guard — emitting a settlement while nothing is in
    // flight must NOT buffer it for a subsequent retry on the same action id.
    h.setPendingActions([
      permissionAction({ actionId: 'act-idle' }),
      permissionAction({ actionId: 'act-acc-drain' }),
      permissionAction({ actionId: 'act-catch-drain' }),
    ]);
    await h.controller.respondApproval('act-idle', 'allow');
    h.emitAction({ actionId: 'act-idle', outcome: 'failed' });
    // Now idle (inFlightDispatches === 0); re-delivered 'resolved' must not buffer.
    h.emitAction({ actionId: 'act-idle', outcome: 'resolved' });
    const afterIdle = await h.controller.respondApproval('act-idle', 'allow');
    expect(afterIdle.admission).toBe('accepted');
    expect(afterIdle.outcome).toBe('unsettled');
    expect(
      h.controller.operations.find(
        (op) => op.kind === 'approval' && op.target.requestId === 'act-idle',
      )?.state,
    ).toBe('pending');

    // R2-1 (2): accepted-path pruneBuffers() — an orphan action failure buffered
    // while another dispatch is in flight must clear when that dispatch resolves
    // accepted, so the action's later approval starts unsettled and can establish.
    const dAccHold = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(dAccHold.promise);
    const accHold = h.controller.submit({ text: 'hold for accepted drain' });
    h.emitAction({ actionId: 'act-acc-drain', outcome: 'failed' });
    dAccHold.resolve({
      admission: 'accepted',
      operationId: 'op-acc-drain',
      turnId: 't-acc-drain',
    });
    await accHold;
    const afterAccDrain = await h.controller.respondApproval(
      'act-acc-drain',
      'allow',
    );
    expect(afterAccDrain.admission).toBe('accepted');
    expect(afterAccDrain.outcome).toBe('unsettled');
    h.emitAction({ actionId: 'act-acc-drain', outcome: 'resolved' });
    expect(
      h.controller.operations.find(
        (op) =>
          op.kind === 'approval' && op.target.requestId === 'act-acc-drain',
      )?.state,
    ).toBe('established');

    // R2-1 (3): thrown-transport catch pruneBuffers() — an orphan buffered during
    // a throwing dispatch must clear when the catch runs.
    const dThrowHold = deferred<ManagedTransportAdmission>();
    h.submitPrompt.mockReturnValueOnce(dThrowHold.promise);
    const throwHold = h.controller.submit({ text: 'hold for catch drain' });
    h.emitAction({ actionId: 'act-catch-drain', outcome: 'failed' });
    dThrowHold.reject(new Error('boom'));
    expect((await throwHold).admission).toBe('unknown');
    const afterCatchDrain = await h.controller.respondApproval(
      'act-catch-drain',
      'allow',
    );
    expect(afterCatchDrain.admission).toBe('accepted');
    expect(afterCatchDrain.outcome).toBe('unsettled');
  });

  it('settles an in-flight cancel even when the shared submit row is still pending, and establishes submit on cancelled turn (G1 / B1 / R2-3)', async () => {
    const h = createHarness();
    // G1 / cell B1: submit is admitted and still PENDING (not terminal yet);
    // cancel(t1) is in flight when turn t1 settles 'completed' and sessionPhase
    // becomes 'completed' -> cancel must fail and phase must return to 'idle'.
    h.setPhase('agent_running');
    h.setActiveTurnId('t1');
    await h.controller.submit({ text: 'running turn' });
    expect(
      h.controller.operations.find((op) => op.kind === 'submit')?.state,
    ).toBe('pending');

    const dCan = deferred<ManagedTransportAdmission>();
    h.cancelTurn.mockReturnValueOnce(dCan.promise);
    const cancelPromise = h.controller.cancel();
    expect(h.controller.phase).toBe('cancelling');

    h.emitTurn({ turnId: 't1', outcome: 'completed' });
    h.setPhase('completed');
    h.setActiveTurnId(undefined);
    dCan.resolve({ admission: 'accepted', operationId: 'op-can-b1' });

    const cancelRes = await cancelPromise;
    expect(cancelRes.admission).toBe('accepted');
    expect(cancelRes.outcome).toBe('failed');
    expect(
      h.controller.operations.find((op) => op.kind === 'submit')?.state,
    ).toBe('established');
    expect(
      h.controller.operations.find((op) => op.kind === 'cancel')?.state,
    ).toBe('failed');
    expect(h.controller.phase).toBe('idle');

    // R2-3: submit × cancelled turn settles the submit row as 'established'.
    h.submitPrompt.mockResolvedValueOnce({
      admission: 'accepted',
      operationId: 'op-sub-can',
      turnId: 't-can',
    });
    await h.controller.submit({ text: 'will be cancelled' });
    h.emitTurn({ turnId: 't-can', outcome: 'cancelled' });
    expect(
      h.controller.operations.find((op) => op.kind === 'submit')?.state,
    ).toBe('established');
  });

  it('filters expired managed actions from projection and rejects responses to them (R2-4)', async () => {
    let nowMs = 10_000;
    const h = createHarness({ now: () => nowMs });
    h.setPendingActions([
      permissionAction({ actionId: 'perm-exp', expiresAt: 10_000 }),
      permissionAction({ actionId: 'perm-live', expiresAt: 10_001 }),
      questionAction({ actionId: 'q-exp', expiresAt: 9_999 }),
      questionAction({ actionId: 'q-live', expiresAt: 10_001 }),
    ]);

    expect(h.controller.pendingApprovals.map((a) => a.id)).toEqual([
      'perm-live',
    ]);
    expect(h.controller.pendingQuestions.map((q) => q.id)).toEqual(['q-live']);

    const expApp = await h.controller.respondApproval('perm-exp', 'allow');
    expect(expApp.admission).toBe('rejected');
    expect(expApp.outcome).toBeUndefined();
    const expQ = await h.controller.respondQuestion('q-exp', [
      { questionId: '0', value: 'Dev' },
      { questionId: '1', value: 'Dry run' },
    ]);
    expect(expQ.admission).toBe('rejected');
    expect(expQ.outcome).toBeUndefined();
    expect(h.submitApproval).not.toHaveBeenCalled();
    expect(h.submitQuestion).not.toHaveBeenCalled();

    // Advancing clock past 10_001 expires the remaining actions too.
    nowMs = 10_001;
    expect(h.controller.pendingApprovals).toEqual([]);
    expect(h.controller.pendingQuestions).toEqual([]);

    // Default clock (omitting deps.now) also filters already-expired actions.
    const defaultClock = createHarness();
    defaultClock.setPendingActions([
      questionAction({ actionId: 'q-past', expiresAt: Date.now() - 60_000 }),
    ]);
    expect(defaultClock.controller.pendingQuestions).toEqual([]);
  });

  it('refuses a second decision while an accepted approval or question row is still non-terminal (R2-5)', async () => {
    const h = createHarness();
    h.setPendingActions([
      permissionAction({ actionId: 'act-live' }),
      questionAction({ actionId: 'q-live' }),
    ]);

    // Approval accepted, settlement not yet received -> second click rejected.
    const firstApp = await h.controller.respondApproval('act-live', 'allow');
    expect(firstApp.admission).toBe('accepted');
    expect(firstApp.outcome).toBe('unsettled');
    const secondApp = await h.controller.respondApproval('act-live', 'deny');
    expect(secondApp.admission).toBe('rejected');
    expect(secondApp.outcome).toBeUndefined();
    expect(h.submitApproval).toHaveBeenCalledTimes(1);

    // Question accepted, settlement not yet received -> second submit rejected.
    const firstQ = await h.controller.respondQuestion('q-live', [
      { questionId: '0', value: 'Dev' },
      { questionId: '1', value: 'Dry run' },
    ]);
    expect(firstQ.admission).toBe('accepted');
    expect(firstQ.outcome).toBe('unsettled');
    const secondQ = await h.controller.respondQuestion('q-live', [
      { questionId: '0', value: 'Prod' },
      { questionId: '1', value: 'Verbose' },
    ]);
    expect(secondQ.admission).toBe('rejected');
    expect(secondQ.outcome).toBeUndefined();
    expect(h.submitQuestion).toHaveBeenCalledTimes(1);
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
