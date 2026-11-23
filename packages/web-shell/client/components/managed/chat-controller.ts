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
import {
  deriveChatPhase,
  isTerminalOperation,
  retainOperations,
} from '../../chat-core/intent.js';
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

  // Optional clock used to filter expired actions (defaults to Date.now).
  readonly now?: () => number;

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
        id: question.id,
        question: question.prompt,
        header: question.id,
        options: question.options.map((option) => ({
          id: option.id,
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

type MultiSelectMatch =
  | { readonly kind: 'unique'; readonly optionIds: string[] }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'none' };

function normalizeRenderedOption(value: string): string {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

function matchUniqueMultiSelectOptions(
  raw: string,
  options: readonly { id: string; label: string }[],
): MultiSelectMatch {
  // Bounded DP over comma-delimited segment boundaries (O(k * |options|)):
  // requires a unique full cover of the rendered value so duplicate labels
  // (e.g. two options labelled "Same, label") and join collisions (e.g.
  // "Alpha" + "Beta" vs "Alpha, Beta") fail closed instead of silently
  // recording a different option than the user clicked.
  const segStarts: number[] = [];
  const segEnds: number[] = [];
  let cursor = 0;
  while (cursor <= raw.length) {
    const comma = raw.indexOf(',', cursor);
    const sliceEnd = comma === -1 ? raw.length : comma;
    let s = cursor;
    let e = sliceEnd;
    while (s < e && /\s/.test(raw[s]!)) s++;
    while (e > s && /\s/.test(raw[e - 1]!)) e--;
    if (e > s) {
      segStarts.push(s);
      segEnds.push(e);
    }
    if (comma === -1) break;
    cursor = comma + 1;
  }
  const k = segStarts.length;
  if (k === 0) return { kind: 'none' };

  const candidates: Array<{ token: string; spanLen: number; id: string }> = [];
  for (const option of options) {
    const seenTokens = new Set<string>();
    for (const labelOrId of [option.label, option.id]) {
      const token = normalizeRenderedOption(labelOrId);
      if (token.length === 0 || seenTokens.has(token)) continue;
      seenTokens.add(token);
      const spanLen = token
        .split(',')
        .filter((part) => part.trim().length > 0).length;
      candidates.push({ token, spanLen, id: option.id });
    }
  }

  // count[i] is capped at 2: 0 = unreachable, 1 = unique cover, 2 = ambiguous.
  const count = new Uint8Array(k + 1);
  const cover: Array<string[] | undefined> = new Array(k + 1);
  count[0] = 1;
  cover[0] = [];

  for (let i = 0; i < k; i++) {
    const c = count[i]!;
    if (c === 0) continue;
    for (const candidate of candidates) {
      const j = i + candidate.spanLen;
      if (j > k) continue;
      if (
        normalizeRenderedOption(raw.slice(segStarts[i]!, segEnds[j - 1]!)) !==
        candidate.token
      ) {
        continue;
      }
      if (count[j] === 0) {
        count[j] = c;
        if (c === 1) {
          const prev = cover[i]!;
          cover[j] = prev.includes(candidate.id)
            ? prev
            : [...prev, candidate.id];
        }
      } else {
        count[j] = 2;
        cover[j] = undefined;
      }
    }
  }

  if (count[k] === 0) return { kind: 'none' };
  if (count[k] > 1) return { kind: 'ambiguous' };
  return { kind: 'unique', optionIds: cover[k]! };
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

    if (entry.optionIds !== undefined || entry.text !== undefined) {
      const optionIds = entry.optionIds ?? [];
      const optionIdSet = new Set(question.options.map((option) => option.id));
      const text = entry.text?.trim() ? entry.text : undefined;
      if (
        optionIdSet.size !== question.options.length ||
        new Set(optionIds).size !== optionIds.length ||
        optionIds.some((id) => !optionIdSet.has(id)) ||
        (!question.multiple &&
          (optionIds.length > 1 ||
            (optionIds.length > 0 && text !== undefined))) ||
        (text !== undefined && !question.allowText) ||
        (text !== undefined && text.length > MAX_MANAGED_QUESTION_TEXT_LENGTH)
      ) {
        return null;
      }
      byQuestionId.set(question.id, {
        questionId: question.id,
        ...(optionIds.length > 0 ? { optionIds: [...optionIds] } : {}),
        ...(text !== undefined ? { text } : {}),
      });
      continue;
    }

    const trimmed = entry.value.trim();
    if (trimmed === '') {
      if (question.required) return null;
      byQuestionId.set(question.id, { questionId: question.id });
      continue;
    }

    if (question.multiple) {
      const match = matchUniqueMultiSelectOptions(
        entry.value,
        question.options,
      );
      if (match.kind === 'ambiguous') return null;
      if (match.kind === 'unique') {
        byQuestionId.set(question.id, {
          questionId: question.id,
          optionIds: match.optionIds,
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
      const byId = question.options.filter(
        (option) => option.id === entry.value || option.id === trimmed,
      );
      const byLabel = question.options.filter(
        (option) => option.label === entry.value || option.label === trimmed,
      );
      const uniqueMatches = new Set([
        ...byId.map((option) => option.id),
        ...byLabel.map((option) => option.id),
      ]);
      if (uniqueMatches.size > 1) return null;
      if (uniqueMatches.size === 1) {
        const [onlyId] = uniqueMatches;
        byQuestionId.set(question.id, {
          questionId: question.id,
          optionIds: [onlyId!],
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
  readonly sequence: number;
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

function isActionExpired(
  action: ManagedAgentPendingAction,
  nowMs: number,
): boolean {
  return action.expiresAt <= nowMs;
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
    {
      readonly state: Exclude<OperationState, 'pending'>;
      readonly dispatchSequence: number;
    }
  >();
  const bufferedTurnOutcome = new Map<
    string,
    {
      readonly outcome: ManagedTurnSettlement['outcome'];
      readonly dispatchSequence: number;
    }
  >();
  const bufferedActionOutcome = new Map<
    string,
    {
      readonly outcome: ManagedActionSettlement['outcome'];
      readonly dispatchSequence: number;
    }
  >();
  let cachedOperations: readonly ChatOperation[] = Object.freeze([]);
  let dirty = false;

  const getNow = (): number => (deps.now ? deps.now() : Date.now());

  const pruneBuffers = (): void => {
    if (inFlightDispatches === 0) {
      bufferedOperationSettlement.clear();
      bufferedTurnOutcome.clear();
      bufferedActionOutcome.clear();
    }
  };

  const hasLiveAction = (actionId: string): boolean =>
    tracked.some(
      (entry) =>
        (entry.kind === 'approval' || entry.kind === 'question') &&
        entry.target.requestId === actionId &&
        !isTerminalOperation(entry.state),
    );

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
    if (isTerminalOperation(entry.state)) return;
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
      if (isTerminalOperation(entry.state)) continue;
      matched = true;
      applyState(entry, next);
    }
    if (!matched && inFlightDispatches > 0) {
      bufferedOperationSettlement.set(event.operationId, {
        state: next,
        dispatchSequence: seq,
      });
    }
  };

  const settleByTurnId = (event: ManagedTurnSettlement): void => {
    for (const entry of tracked) {
      if (entry.boundTurnId !== event.turnId) continue;
      if (isTerminalOperation(entry.state)) continue;
      applyState(entry, projectTurnOutcomeForKind(entry.kind, event.outcome));
    }
    // A turn id is unknown until submit's transport response arrives, so tag
    // the event with the newest dispatch already started. A later attempt
    // cannot consume settlement evidence that predates its own dispatch.
    if (inFlightDispatches > 0) {
      bufferedTurnOutcome.set(event.turnId, {
        outcome: event.outcome,
        dispatchSequence: seq,
      });
    }
  };

  const settleByActionId = (event: ManagedActionSettlement): void => {
    const next: 'established' | 'failed' =
      event.outcome === 'resolved' ? 'established' : 'failed';
    for (const entry of tracked) {
      if (entry.boundActionId !== event.actionId) continue;
      if (isTerminalOperation(entry.state)) continue;
      applyState(entry, next);
    }
    if (inFlightActionIds.has(event.actionId)) {
      bufferedActionOutcome.set(event.actionId, {
        outcome: event.outcome,
        dispatchSequence: seq,
      });
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
    const sequence = ++seq;
    const entry: TrackedOperation = {
      id: `managed-op-${sequence}`,
      sequence,
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
      if (
        buffered !== undefined &&
        entry.sequence <= buffered.dispatchSequence
      ) {
        bufferedOperationSettlement.delete(response.operationId);
        applyState(entry, buffered.state);
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
          (op) => op.kind === 'cancel' && !isTerminalOperation(op.state),
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
            const buffered = bufferedTurnOutcome.get(response.turnId);
            if (
              buffered !== undefined &&
              entry.sequence <= buffered.dispatchSequence
            ) {
              applyState(
                entry,
                projectTurnOutcomeForKind('submit', buffered.outcome),
              );
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
          const buffered = bufferedTurnOutcome.get(cancelTarget);
          if (
            buffered !== undefined &&
            entry.sequence <= buffered.dispatchSequence
          ) {
            applyState(
              entry,
              projectTurnOutcomeForKind('cancel', buffered.outcome),
            );
          }
        },
      );
      return { ...out, target: { ...out.target, turnId: cancelTarget } };
    },
    get pendingApprovals(): readonly PendingApproval[] {
      const messages = deps.messages;
      const nowMs = getNow();
      return deps.pendingActions
        .filter(
          (action) =>
            action.kind !== 'question' && !isActionExpired(action, nowMs),
        )
        .map((action) => ({
          id: action.actionId,
          status: 'pending' as const,
          request: toManagedPermissionRequest(action, messages),
        }));
    },
    get pendingQuestions(): readonly PendingQuestion[] {
      const nowMs = getNow();
      return deps.pendingActions
        .filter(
          (action): action is ManagedAgentPendingQuestionAction =>
            action.kind === 'question' && !isActionExpired(action, nowMs),
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
        isActionExpired(action, getNow()) ||
        inFlightActionIds.has(requestId) ||
        hasLiveAction(requestId) ||
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
            const buffered = bufferedActionOutcome.get(requestId);
            if (
              buffered !== undefined &&
              entry.sequence <= buffered.dispatchSequence
            ) {
              bufferedActionOutcome.delete(requestId);
              applyState(
                entry,
                buffered.outcome === 'resolved' ? 'established' : 'failed',
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
      if (
        !action ||
        isActionExpired(action, getNow()) ||
        inFlightActionIds.has(requestId) ||
        hasLiveAction(requestId)
      ) {
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
            const buffered = bufferedActionOutcome.get(requestId);
            if (
              buffered !== undefined &&
              entry.sequence <= buffered.dispatchSequence
            ) {
              bufferedActionOutcome.delete(requestId);
              applyState(
                entry,
                buffered.outcome === 'resolved' ? 'established' : 'failed',
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
