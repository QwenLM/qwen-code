/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
  type ToolCallConfirmationDetails,
  type WaitingToolCall,
} from '@qwen-code/qwen-code-core';
import type {
  AgentViewSessionState,
  AgentViewWorkerAnswerOutcome,
  AgentViewWorkerControlEvent,
} from '../../agent-view/protocol.js';
import { StreamingState, type HistoryItemWithoutId } from '../types.js';

interface AgentViewStatusToolCall {
  status: string;
  request?: {
    callId?: string;
    name?: string;
  };
  liveOutput?: unknown;
  confirmationDetails?: ToolCallConfirmationDetails;
}

export interface AgentViewWorkerUiStateReport {
  sessionState: AgentViewSessionState;
  summary?: string;
  waitingFor?: string;
  inputKind?: 'blocking' | 'soft';
  lastResult?: string;
}

export function retainAnsweredAgentViewSoftQuestion(
  answeredQuestion: string | undefined,
  lastResult: string | undefined,
): string | undefined {
  return answeredQuestion === lastResult ? answeredQuestion : undefined;
}

export function getAgentViewWorkerStateForUi({
  initError,
  streamingState,
  pendingToolCalls,
  lastResult,
  answeredSoftQuestion,
}: {
  initError: unknown;
  streamingState: StreamingState;
  pendingToolCalls?: AgentViewStatusToolCall[];
  lastResult?: string;
  answeredSoftQuestion?: string;
}): AgentViewWorkerUiStateReport {
  if (initError) {
    const summary =
      initError instanceof Error ? initError.message : String(initError);
    return { sessionState: 'failed', summary };
  }

  const toolCalls = pendingToolCalls ?? [];
  const waitingTool = toolCalls.find(
    (tool) => tool.status === 'awaiting_approval',
  );
  const waitingFor =
    waitingTool?.request?.name ?? getNestedAgentViewWaitingFor(toolCalls);
  if (streamingState === StreamingState.WaitingForConfirmation) {
    return {
      sessionState: 'needs_input',
      ...(waitingFor ? { waitingFor } : {}),
      inputKind: 'blocking',
      ...(lastResult ? { lastResult } : {}),
    };
  }

  if (streamingState === StreamingState.Responding) {
    return {
      sessionState: 'working',
      ...(lastResult ? { lastResult } : {}),
    };
  }

  if (
    lastResult &&
    lastResult !== answeredSoftQuestion &&
    looksLikeUserQuestion(lastResult)
  ) {
    return {
      sessionState: 'needs_input',
      waitingFor: 'response',
      inputKind: 'soft',
      lastResult,
    };
  }

  return {
    sessionState: 'idle',
    ...(lastResult ? { lastResult } : {}),
  };
}

function looksLikeUserQuestion(text: string): boolean {
  // Rhetorical questions tend to trail long explanations; a real follow-up
  // question is usually a short standalone line. Keep the heuristic soft —
  // misclassifying only affects the roster's idle/needs-input hint.
  const trimmed = text.trim();
  return trimmed.length <= 120 && /[?？]\s*$/.test(trimmed);
}

export function getLastAgentViewModelOutputLine(
  items: readonly HistoryItemWithoutId[],
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || (item.type !== 'gemini' && item.type !== 'gemini_content')) {
      continue;
    }
    const lastLine = item.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (lastLine) return lastLine;
  }
  return undefined;
}

export async function answerAgentViewPendingToolCall(
  event: Extract<AgentViewWorkerControlEvent, { type: 'answer' }>,
  pendingToolCalls: WaitingToolCall[],
): Promise<boolean> {
  const toolCall = pendingToolCalls.find(
    (call) =>
      call.status === 'awaiting_approval' &&
      (!event.callId || call.request.callId === event.callId),
  );
  if (!toolCall?.confirmationDetails?.onConfirm) {
    return false;
  }
  const confirmationDetails = toolCall.confirmationDetails;

  // Questions deliver the text as the answer payload; the negative-text
  // heuristic below must not turn a real "no" answer into a refusal.
  const isQuestion = confirmationDetails.type === 'ask_user_question';
  const outcome = toToolConfirmationOutcome(
    event.outcome,
    event.text,
    isQuestion,
  );
  if (isQuestion) {
    await confirmationDetails.onConfirm(
      outcome,
      getAgentViewAnswerPayload(event, confirmationDetails.questions.length),
    );
    return true;
  }

  await confirmationDetails.onConfirm(outcome);
  return true;
}

export function getAgentViewAnswerableToolCalls(
  pendingToolCalls: readonly unknown[],
): WaitingToolCall[] {
  // Two passes so genuinely awaiting calls always precede synthesized
  // nested-Agent confirmations — mirroring the display rule, so the call
  // that receives the answer is the one the roster shows as waiting.
  const awaiting: WaitingToolCall[] = [];
  const nested: WaitingToolCall[] = [];
  for (const toolCall of pendingToolCalls) {
    if (!isRecord(toolCall)) continue;
    if (
      toolCall['status'] === 'awaiting_approval' &&
      isRecord(toolCall['confirmationDetails'])
    ) {
      awaiting.push(toolCall as unknown as WaitingToolCall);
      continue;
    }

    const pendingConfirmation = getNestedAgentViewPendingConfirmation(
      toolCall['liveOutput'],
    );
    if (pendingConfirmation) {
      nested.push({
        status: 'awaiting_approval',
        request: isRecord(toolCall['request'])
          ? {
              callId:
                typeof toolCall['request']['callId'] === 'string'
                  ? toolCall['request']['callId']
                  : '',
              name:
                typeof toolCall['request']['name'] === 'string'
                  ? toolCall['request']['name']
                  : 'Agent',
            }
          : { callId: '', name: 'Agent' },
        confirmationDetails: pendingConfirmation,
      } as unknown as WaitingToolCall);
    }
  }
  return [...awaiting, ...nested];
}

export async function applyAgentViewWorkerControlEventForUi(
  event: AgentViewWorkerControlEvent,
  pendingToolCalls: readonly unknown[],
  enqueuePrompt: (text: string) => void,
  stopCurrentTurn?: () => void,
): Promise<void> {
  if (event.type === 'prompt') {
    enqueuePrompt(event.text);
    return;
  }

  if (event.type === 'stop') {
    stopCurrentTurn?.();
    return;
  }

  if (event.type !== 'answer') {
    return;
  }

  // An answer without a matching pending confirmation is stale. Soft
  // questions are converted to prompt controls by the supervisor before
  // reaching this worker-side path.
  await answerAgentViewPendingToolCall(
    event,
    getAgentViewAnswerableToolCalls(pendingToolCalls),
  );
}

function getNestedAgentViewWaitingFor(
  toolCalls: readonly AgentViewStatusToolCall[],
): string {
  const nested = toolCalls.find((toolCall) =>
    Boolean(getNestedAgentViewPendingConfirmation(toolCall.liveOutput)),
  );
  return nested?.request?.name ?? 'user input';
}

function getNestedAgentViewPendingConfirmation(
  liveOutput: unknown,
): ToolCallConfirmationDetails | undefined {
  if (
    !isRecord(liveOutput) ||
    liveOutput['type'] !== 'task_execution' ||
    !isRecord(liveOutput['pendingConfirmation'])
  ) {
    return undefined;
  }
  return liveOutput[
    'pendingConfirmation'
  ] as unknown as ToolCallConfirmationDetails;
}

function toToolConfirmationOutcome(
  outcome: AgentViewWorkerAnswerOutcome | undefined,
  text: string | undefined,
  isQuestion = false,
): ToolConfirmationOutcome {
  switch (outcome) {
    case 'proceed_always':
      return ToolConfirmationOutcome.ProceedAlways;
    case 'proceed_always_project':
      return ToolConfirmationOutcome.ProceedAlwaysProject;
    case 'proceed_always_user':
      return ToolConfirmationOutcome.ProceedAlwaysUser;
    case 'modify_with_editor':
      return ToolConfirmationOutcome.ModifyWithEditor;
    case 'restore_previous':
      return ToolConfirmationOutcome.RestorePrevious;
    case 'cancel':
      return ToolConfirmationOutcome.Cancel;
    case 'proceed_once':
      return ToolConfirmationOutcome.ProceedOnce;
    default:
      break;
  }

  // For ask_user_question the text is the answer itself (a "no" answer must
  // still be delivered), matching AskUserQuestionDialog behavior.
  if (isQuestion) {
    return ToolConfirmationOutcome.ProceedOnce;
  }

  // Fail closed for approval decisions: only explicit positive tokens
  // approve, so refusal phrasings outside a fixed vocabulary ("stop",
  // "wait", "don't delete that", ...) can never approve the pending action.
  const normalized = text?.trim().toLowerCase();
  if (
    normalized === 'y' ||
    normalized === 'yes' ||
    normalized === 'ok' ||
    normalized === 'approve' ||
    normalized === 'allow' ||
    normalized === 'proceed'
  ) {
    return ToolConfirmationOutcome.ProceedOnce;
  }
  return ToolConfirmationOutcome.Cancel;
}

function getAgentViewAnswerPayload(
  event: Extract<AgentViewWorkerControlEvent, { type: 'answer' }>,
  questionCount: number,
): ToolConfirmationPayload | undefined {
  if (isRecord(event.payload)) {
    return event.payload as unknown as ToolConfirmationPayload;
  }
  const text = event.text?.trim();
  if (!text) {
    return undefined;
  }
  return {
    answers: Object.fromEntries(
      Array.from({ length: questionCount }, (_, index) => [index, text]),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
