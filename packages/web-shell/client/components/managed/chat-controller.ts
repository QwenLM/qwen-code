/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, PermissionRequest } from '../../adapters/types.js';
import type {
  Admission,
  ApprovalSelectionController,
  ChatCapabilities,
  ChatOperation,
  ChatPhase,
  ChatStatusFacts,
  ComposerSubmit,
  ContextUsageController,
  IntentKind,
  IntentResult,
  IntentTarget,
  ModelSelectionController,
  PendingApproval,
  PendingQuestion,
  QuestionAnswer,
  SessionChatController,
  SessionOpsController,
} from '../../chat-core/contract.js';
import { deriveChatPhase, retainOperations } from '../../chat-core/intent.js';
import type {
  ManagedAgentPendingAction,
  ManagedAgentPendingQuestionAction,
  ManagedAgentQuestionAnswer,
  ManagedAgentSessionPhase,
} from './managed-agent-provider.js';
import { toManagedPermissionRequest } from './managed-approval.js';
import { canonicalQuestionAnswers } from './managed-question-response.js';

type OperationState = ChatOperation['state'];

export interface ManagedTransportAdmission {
  readonly admission: Admission;
  readonly operationId?: string;
  readonly turnId?: string;
}

export interface ManagedOperationSettlement {
  readonly operationId: string;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'recovery_blocked';
}

export interface ManagedTurnSettlement {
  readonly turnId: string;
  readonly outcome: 'completed' | 'cancelled' | 'failed';
}

export interface ManagedActionSettlement {
  readonly actionId: string;
  readonly outcome: 'resolved' | 'expired' | 'superseded' | 'failed';
}

export interface ManagedChatControllerDeps {
  readonly sessionId: string;
  readonly storageKey: string;
  readonly activeTurnId?: string;
  readonly sessionPhase: ManagedAgentSessionPhase;

  // Pass-through transcript facts.
  readonly messages: readonly Message[];
  readonly transcriptState: 'loading' | 'ready' | 'error';
  readonly hasOlderHistory?: boolean;
  readonly loadingOlderHistory?: boolean;
  readonly historyCapacityReached?: boolean;
  readonly historyPaginationError?: boolean;
  loadOlder?(options?: { force?: boolean }): Promise<void>;

  // Live pending actions (permissions and questions) for this session.
  readonly pendingActions: readonly ManagedAgentPendingAction[];

  // Pass-through status and capability facts.
  readonly statusFacts: ChatStatusFacts;
  readonly capabilities: ChatCapabilities;

  // Optional capability-gated sub-controllers.
  readonly modelSelection?: ModelSelectionController;
  readonly approvalSelection?: ApprovalSelectionController;
  readonly contextUsage?: ContextUsageController;
  readonly sessionOps?: SessionOpsController;

  // Intent transports. Each resolves to an admission only; admission is never
  // evidence that the effect is established.
  submitPrompt(input: ComposerSubmit): Promise<ManagedTransportAdmission>;
  cancelTurn(turnId: string): Promise<ManagedTransportAdmission>;
  submitApproval(
    actionId: string,
    optionId: string,
  ): Promise<ManagedTransportAdmission>;
  submitQuestion(
    actionId: string,
    answers: readonly ManagedAgentQuestionAnswer[],
  ): Promise<ManagedTransportAdmission>;

  // Authoritative settlement subscriptions.
  subscribeOperationSettlement?(
    listener: (event: ManagedOperationSettlement) => void,
  ): () => void;
  subscribeTurnSettlement?(
    listener: (event: ManagedTurnSettlement) => void,
  ): () => void;
  subscribeActionSettlement?(
    listener: (event: ManagedActionSettlement) => void,
  ): () => void;

  // When aborted, all settlement subscriptions are released.
  readonly signal?: AbortSignal;
}

export const MANAGED_QUESTION_SUBMIT_OPTION_ID = 'submit';
export const MAX_MANAGED_QUESTION_TEXT_LENGTH = 8192;

export function mapManagedPhase(
  phase: ManagedAgentSessionPhase,
): 'idle' | 'running' | 'cancelling' | 'failed' {
  switch (phase) {
    case 'created':
    case 'completed':
    case 'cancelled':
      return 'idle';
    case 'failed':
      return 'failed';
    case 'cancelling':
      return 'cancelling';
    case 'admitted':
    case 'runtime_starting':
    case 'agent_running':
    case 'waiting_runtime':
    case 'tool_running':
      return 'running';
  }
}

export function mapManagedOperationStatus(
  status: ManagedOperationSettlement['status'],
): Exclude<OperationState, 'pending'> {
  switch (status) {
    case 'completed':
      return 'established';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'recovery_blocked':
      return 'unsettled';
  }
}

export function toManagedQuestionPermissionRequest(
  action: ManagedAgentPendingQuestionAction,
): PermissionRequest {
  const toolCallId = action.turnId
    ? `${action.turnId}:${action.functionCallId}`
    : action.functionCallId;
  return {
    id: action.actionId,
    sessionId: action.sessionId,
    toolCallId,
    toolName: action.toolName,
    title: action.questions[0]?.prompt ?? action.toolName,
    content: [],
    rawInput: {
      questions: action.questions.map((question) => ({
        question: question.prompt,
        header: question.id,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description ?? '',
        })),
        multiSelect: question.multiple,
      })),
    },
    // Managed question actions carry no dismiss wire variant (sending a string
    // option id to a question action is rejected by the provider), so project
    // only the allow_once submit option.
    options: [
      {
        id: MANAGED_QUESTION_SUBMIT_OPTION_ID,
        label: 'Submit',
        kind: 'allow_once',
      },
    ],
  };
}

const DECIMAL_INDEX_RE = /^(0|[1-9]\d*)$/;

function matchExactMultiSelectOptions(
  raw: string,
  options: readonly { id: string; label: string }[],
): string[] | null {
  // Match option labels/ids longest-first at comma boundaries. Require an exact
  // cover of the entire value so free text that happens to start with an option
  // label followed by a comma (e.g. "Verbose, but only for the parser") is
  // never misread as selecting that option and amputating the text.
  const candidates: Array<{ token: string; id: string }> = [];
  for (const option of options) {
    if (option.label.length > 0) {
      candidates.push({ token: option.label, id: option.id });
    }
    if (option.id.length > 0 && option.id !== option.label) {
      candidates.push({ token: option.id, id: option.id });
    }
  }
  candidates.sort((a, b) => b.token.length - a.token.length);

  const optionIds: string[] = [];
  let pos = 0;
  while (pos < raw.length) {
    while (pos < raw.length && (raw[pos] === ',' || /\s/.test(raw[pos]!))) {
      pos++;
    }
    if (pos >= raw.length) break;
    const remaining = raw.slice(pos);
    const matched = candidates.find(({ token }) => {
      if (!remaining.startsWith(token)) return false;
      const trimmedAfter = remaining.slice(token.length).trimStart();
      return trimmedAfter.length === 0 || trimmedAfter.startsWith(',');
    });
    if (!matched) return null;
    if (!optionIds.includes(matched.id)) optionIds.push(matched.id);
    pos += matched.token.length;
    while (pos < raw.length && /\s/.test(raw[pos]!)) pos++;
    if (pos < raw.length && raw[pos] === ',') pos++;
  }
  return optionIds.length > 0 ? optionIds : null;
}

export function normalizeManagedQuestionAnswers(
  action: ManagedAgentPendingQuestionAction,
  answers: readonly QuestionAnswer[],
): ManagedAgentQuestionAnswer[] | null {
  const byQuestionId = new Map<string, ManagedAgentQuestionAnswer>();
  for (const entry of answers) {
    let question = action.questions.find(
      (candidate) => candidate.id === entry.questionId,
    );
    if (!question && DECIMAL_INDEX_RE.test(entry.questionId)) {
      const index = Number(entry.questionId);
      if (index >= 0 && index < action.questions.length) {
        question = action.questions[index];
      }
    }
    if (!question) return null;
    if (byQuestionId.has(question.id)) return null;

    const trimmed = entry.value.trim();
    if (trimmed === '') {
      if (question.required) return null;
      byQuestionId.set(question.id, { questionId: question.id });
      continue;
    }

    if (question.multiple) {
      const matchedOptionIds = matchExactMultiSelectOptions(
        entry.value,
        question.options,
      );
      if (matchedOptionIds !== null) {
        byQuestionId.set(question.id, {
          questionId: question.id,
          optionIds: matchedOptionIds,
        });
      } else if (question.allowText) {
        byQuestionId.set(question.id, {
          questionId: question.id,
          text: entry.value,
        });
      } else {
        return null;
      }
    } else {
      const matched = question.options.find(
        (option) =>
          option.id === entry.value ||
          option.label === entry.value ||
          option.id === trimmed ||
          option.label === trimmed,
      );
      if (matched) {
        byQuestionId.set(question.id, {
          questionId: question.id,
          optionIds: [matched.id],
        });
      } else if (question.allowText) {
        byQuestionId.set(question.id, {
          questionId: question.id,
          text: entry.value,
        });
      } else {
        return null;
      }
    }
    const recorded = byQuestionId.get(question.id);
    if (
      recorded?.text !== undefined &&
      recorded.text.length > MAX_MANAGED_QUESTION_TEXT_LENGTH
    ) {
      return null;
    }
  }

  for (const question of action.questions) {
    if (!question.required) continue;
    const answer = byQuestionId.get(question.id);
    if (
      !answer ||
      ((!answer.optionIds || answer.optionIds.length === 0) &&
        (!answer.text || answer.text.trim() === ''))
    ) {
      return null;
    }
  }

  const collected = action.questions
    .map((question) => byQuestionId.get(question.id))
    .filter(
      (answer): answer is ManagedAgentQuestionAnswer => answer !== undefined,
    );
  try {
    return canonicalQuestionAnswers(action, collected);
  } catch {
    return null;
  }
}

interface TrackedOperation {
  readonly id: string;
  readonly kind: IntentKind;
  readonly target: IntentTarget;
  state: OperationState;
  backendOperationId?: string;
  boundTurnId?: string;
  boundActionId?: string;
}

function projectTurnOutcomeForKind(
  kind: IntentKind,
  outcome: ManagedTurnSettlement['outcome'],
): 'established' | 'failed' {
  if (kind === 'cancel') {
    return outcome === 'cancelled' ? 'established' : 'failed';
  }
  return outcome === 'failed' ? 'failed' : 'established';
}

function isTerminal(state: OperationState): boolean {
  return state === 'established' || state === 'failed';
}

export function createManagedChatController(
  deps: ManagedChatControllerDeps,
): SessionChatController {
  let seq = 0;
  let inFlightDispatches = 0;
  const tracked: TrackedOperation[] = [];
  const inFlightActionIds = new Set<string>();
  const bufferedOperationSettlement = new Map<
    string,
    Exclude<OperationState, 'pending'>
  >();
  const bufferedTurnOutcome = new Map<
    string,
    ManagedTurnSettlement['outcome']
  >();
  const bufferedActionOutcome = new Map<
    string,
    ManagedActionSettlement['outcome']
  >();
  let cachedOperations: readonly ChatOperation[] = Object.freeze([]);
  let dirty = false;

  const pruneBuffers = (): void => {
    if (inFlightDispatches === 0) {
      bufferedOperationSettlement.clear();
      bufferedTurnOutcome.clear();
      bufferedActionOutcome.clear();
    }
  };

  const target = (extra?: Omit<IntentTarget, 'sessionId'>): IntentTarget =>
    Object.freeze({ sessionId: deps.sessionId, ...extra });

  const rebuildOperations = (): readonly ChatOperation[] => {
    if (!dirty) return cachedOperations;
    const projected: ChatOperation[] = tracked.map((entry) =>
      Object.freeze({
        id: entry.id,
        kind: entry.kind,
        target: entry.target,
        state: entry.state,
      }),
    );
    cachedOperations = Object.freeze(retainOperations(projected));
    dirty = false;
    return cachedOperations;
  };

  const removeTracked = (entry: TrackedOperation): void => {
    const index = tracked.indexOf(entry);
    if (index !== -1) {
      tracked.splice(index, 1);
      dirty = true;
    }
  };

  const applyState = (
    entry: TrackedOperation,
    next: Exclude<OperationState, 'pending'>,
  ): void => {
    if (isTerminal(entry.state)) return;
    if (entry.state !== next) {
      entry.state = next;
      dirty = true;
    }
  };

  const settleByOperationId = (event: ManagedOperationSettlement): void => {
    const next = mapManagedOperationStatus(event.status);
    let matched = false;
    for (const entry of tracked) {
      if (entry.backendOperationId !== event.operationId) continue;
      if (isTerminal(entry.state)) continue;
      matched = true;
      applyState(entry, next);
    }
    if (!matched && inFlightDispatches > 0) {
      bufferedOperationSettlement.set(event.operationId, next);
    }
  };

  const settleByTurnId = (event: ManagedTurnSettlement): void => {
    let matched = false;
    for (const entry of tracked) {
      if (entry.boundTurnId !== event.turnId) continue;
      if (isTerminal(entry.state)) continue;
      matched = true;
      applyState(entry, projectTurnOutcomeForKind(entry.kind, event.outcome));
    }
    if (!matched && inFlightDispatches > 0) {
      bufferedTurnOutcome.set(event.turnId, event.outcome);
    }
  };

  const settleByActionId = (event: ManagedActionSettlement): void => {
    const next: 'established' | 'failed' =
      event.outcome === 'resolved' ? 'established' : 'failed';
    let matched = false;
    for (const entry of tracked) {
      if (entry.boundActionId !== event.actionId) continue;
      if (isTerminal(entry.state)) continue;
      matched = true;
      applyState(entry, next);
    }
    if (!matched && inFlightDispatches > 0) {
      bufferedActionOutcome.set(event.actionId, event.outcome);
    }
  };

  const unsubscribers: Array<() => void> = [];
  if (!deps.signal?.aborted) {
    if (deps.subscribeOperationSettlement) {
      unsubscribers.push(
        deps.subscribeOperationSettlement(settleByOperationId),
      );
    }
    if (deps.subscribeTurnSettlement) {
      unsubscribers.push(deps.subscribeTurnSettlement(settleByTurnId));
    }
    if (deps.subscribeActionSettlement) {
      unsubscribers.push(deps.subscribeActionSettlement(settleByActionId));
    }
    deps.signal?.addEventListener(
      'abort',
      () => {
        while (unsubscribers.length > 0) {
          unsubscribers.pop()?.();
        }
      },
      { once: true },
    );
  }

  const dispatchIntent = async (
    kind: IntentKind,
    opTarget: IntentTarget,
    transport: () => Promise<ManagedTransportAdmission>,
    bindExtra?: (
      entry: TrackedOperation,
      admitted: ManagedTransportAdmission,
    ) => void,
  ): Promise<IntentResult> => {
    const entry: TrackedOperation = {
      id: `managed-op-${++seq}`,
      kind,
      target: opTarget,
      state: 'pending',
    };
    tracked.push(entry);
    dirty = true;
    inFlightDispatches++;

    let response: ManagedTransportAdmission;
    try {
      response = await transport();
    } catch {
      inFlightDispatches--;
      removeTracked(entry);
      pruneBuffers();
      return {
        admission: 'unknown',
        outcome: 'unsettled',
        target: opTarget,
      };
    }

    inFlightDispatches--;

    if (response.admission === 'rejected') {
      removeTracked(entry);
      pruneBuffers();
      return {
        admission: 'rejected',
        target: opTarget,
      };
    }

    if (response.admission === 'unknown') {
      removeTracked(entry);
      pruneBuffers();
      return {
        admission: 'unknown',
        outcome: 'unsettled',
        target: opTarget,
      };
    }

    if (response.operationId) {
      entry.backendOperationId = response.operationId;
      const buffered = bufferedOperationSettlement.get(response.operationId);
      if (buffered !== undefined) {
        bufferedOperationSettlement.delete(response.operationId);
        applyState(entry, buffered);
      }
    }
    bindExtra?.(entry, response);
    pruneBuffers();

    return {
      admission: 'accepted',
      outcome:
        entry.state === 'established' || entry.state === 'failed'
          ? entry.state
          : 'unsettled',
      target: opTarget,
    };
  };

  return {
    kind: 'managed',
    get sessionId() {
      return deps.sessionId;
    },
    get storageKey() {
      return deps.storageKey;
    },
    get activeTurnId() {
      return deps.activeTurnId;
    },
    get operations(): readonly ChatOperation[] {
      return rebuildOperations();
    },
    get messages() {
      return deps.messages;
    },
    get transcriptState() {
      return deps.transcriptState;
    },
    get hasOlderHistory() {
      return deps.hasOlderHistory;
    },
    get loadingOlderHistory() {
      return deps.loadingOlderHistory;
    },
    get historyCapacityReached() {
      return deps.historyCapacityReached;
    },
    get historyPaginationError() {
      return deps.historyPaginationError;
    },
    loadOlder: deps.loadOlder?.bind(deps),
    get phase(): ChatPhase {
      const ops = rebuildOperations();
      const base = mapManagedPhase(deps.sessionPhase);
      if (base === 'cancelling') return 'cancelling';
      if (base === 'running') {
        const cancelling = ops.some(
          (op) => op.kind === 'cancel' && !isTerminal(op.state),
        );
        return cancelling ? 'cancelling' : 'running';
      }
      return deriveChatPhase(ops, base);
    },
    submit(input: ComposerSubmit): Promise<IntentResult> {
      return dispatchIntent(
        'submit',
        target(),
        () => deps.submitPrompt(input),
        (entry, response) => {
          if (response.turnId) {
            entry.boundTurnId = response.turnId;
            const outcome = bufferedTurnOutcome.get(response.turnId);
            if (outcome !== undefined) {
              applyState(entry, projectTurnOutcomeForKind('submit', outcome));
            }
          }
        },
      );
    },
    async cancel(): Promise<IntentResult> {
      const cancelTarget = deps.activeTurnId;
      if (cancelTarget === undefined) {
        return {
          admission: 'rejected',
          target: target(),
        };
      }
      const out = await dispatchIntent(
        'cancel',
        target(),
        () => deps.cancelTurn(cancelTarget),
        (entry) => {
          entry.boundTurnId = cancelTarget;
          const outcome = bufferedTurnOutcome.get(cancelTarget);
          if (outcome !== undefined) {
            applyState(entry, projectTurnOutcomeForKind('cancel', outcome));
          }
        },
      );
      return { ...out, target: { ...out.target, turnId: cancelTarget } };
    },
    get pendingApprovals(): readonly PendingApproval[] {
      const messages = deps.messages;
      return deps.pendingActions
        .filter((action) => action.kind !== 'question')
        .map((action) => ({
          id: action.actionId,
          status: 'pending' as const,
          request: toManagedPermissionRequest(action, messages),
        }));
    },
    get pendingQuestions(): readonly PendingQuestion[] {
      return deps.pendingActions
        .filter(
          (action): action is ManagedAgentPendingQuestionAction =>
            action.kind === 'question',
        )
        .map((action) => ({
          id: action.actionId,
          request: toManagedQuestionPermissionRequest(action),
        }));
    },
    async respondApproval(
      requestId: string,
      optionId: string,
    ): Promise<IntentResult> {
      const opTarget = target({ requestId });
      const action = deps.pendingActions.find(
        (candidate) => candidate.actionId === requestId,
      );
      if (
        !action ||
        action.kind === 'question' ||
        inFlightActionIds.has(requestId) ||
        !action.options.some((option) => option.id === optionId)
      ) {
        return {
          admission: 'rejected',
          target: opTarget,
        };
      }
      inFlightActionIds.add(requestId);
      try {
        return await dispatchIntent(
          'approval',
          opTarget,
          () => deps.submitApproval(requestId, optionId),
          (entry) => {
            entry.boundActionId = requestId;
            const outcome = bufferedActionOutcome.get(requestId);
            if (outcome !== undefined) {
              bufferedActionOutcome.delete(requestId);
              applyState(
                entry,
                outcome === 'resolved' ? 'established' : 'failed',
              );
            }
          },
        );
      } finally {
        inFlightActionIds.delete(requestId);
      }
    },
    async respondQuestion(
      requestId: string,
      answers: readonly QuestionAnswer[],
    ): Promise<IntentResult> {
      const opTarget = target({ requestId });
      const action = deps.pendingActions.find(
        (candidate): candidate is ManagedAgentPendingQuestionAction =>
          candidate.actionId === requestId && candidate.kind === 'question',
      );
      if (!action || inFlightActionIds.has(requestId)) {
        return {
          admission: 'rejected',
          target: opTarget,
        };
      }
      const normalized = normalizeManagedQuestionAnswers(action, answers);
      if (normalized === null) {
        return {
          admission: 'rejected',
          target: opTarget,
        };
      }
      inFlightActionIds.add(requestId);
      try {
        return await dispatchIntent(
          'question',
          opTarget,
          () => deps.submitQuestion(requestId, normalized),
          (entry) => {
            entry.boundActionId = requestId;
            const outcome = bufferedActionOutcome.get(requestId);
            if (outcome !== undefined) {
              bufferedActionOutcome.delete(requestId);
              applyState(
                entry,
                outcome === 'resolved' ? 'established' : 'failed',
              );
            }
          },
        );
      } finally {
        inFlightActionIds.delete(requestId);
      }
    },
    get statusFacts() {
      return deps.statusFacts;
    },
    get capabilities() {
      return deps.capabilities;
    },
    get modelSelection() {
      return deps.modelSelection;
    },
    get approvalSelection() {
      return deps.approvalSelection;
    },
    get contextUsage() {
      return deps.contextUsage;
    },
    get sessionOps() {
      return deps.sessionOps;
    },
  };
}
