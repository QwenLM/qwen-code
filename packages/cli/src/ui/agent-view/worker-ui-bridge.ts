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

export function getAgentViewWorkerStateForUi({
  initError,
  streamingState,
  pendingToolCalls,
  lastResult,
}: {
  initError: unknown;
  streamingState: StreamingState;
  pendingToolCalls?: AgentViewStatusToolCall[];
  lastResult?: string;
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

  if (lastResult && looksLikeUserQuestion(lastResult)) {
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

  const outcome = toToolConfirmationOutcome(event.outcome, event.text);
  if (toolCall.confirmationDetails.type === 'ask_user_question') {
    await toolCall.confirmationDetails.onConfirm(
      outcome,
      getAgentViewAnswerPayload(event),
    );
    return true;
  }

  await toolCall.confirmationDetails.onConfirm(outcome);
  return true;
}

export function getAgentViewAnswerableToolCalls(
  pendingToolCalls: readonly unknown[],
): WaitingToolCall[] {
  const answerable: WaitingToolCall[] = [];
  for (const toolCall of pendingToolCalls) {
    if (!isRecord(toolCall)) continue;
    if (
      toolCall['status'] === 'awaiting_approval' &&
      isRecord(toolCall['confirmationDetails'])
    ) {
      answerable.push(toolCall as unknown as WaitingToolCall);
      continue;
    }

    const pendingConfirmation = getNestedAgentViewPendingConfirmation(
      toolCall['liveOutput'],
    );
    if (pendingConfirmation) {
      answerable.push({
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
  return answerable;
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

  const answeredToolCall = await answerAgentViewPendingToolCall(
    event,
    getAgentViewAnswerableToolCalls(pendingToolCalls),
  );
  if (!answeredToolCall && event.text?.trim()) {
    enqueuePrompt(event.text);
  }
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

  const normalized = text?.trim().toLowerCase();
  if (
    normalized === 'n' ||
    normalized === 'no' ||
    normalized === 'deny' ||
    normalized === 'cancel'
  ) {
    return ToolConfirmationOutcome.Cancel;
  }
  return ToolConfirmationOutcome.ProceedOnce;
}

function getAgentViewAnswerPayload(
  event: Extract<AgentViewWorkerControlEvent, { type: 'answer' }>,
): ToolConfirmationPayload | undefined {
  if (isRecord(event.payload)) {
    return event.payload as unknown as ToolConfirmationPayload;
  }
  const text = event.text?.trim();
  if (!text) {
    return undefined;
  }
  return { answers: { 0: text } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
