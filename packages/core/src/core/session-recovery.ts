/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import {
  buildApiHistoryFromConversation,
  type ConversationRecord,
} from '../services/sessionService.js';
import type { HistoryGap } from '../utils/conversation-chain.js';
import {
  detectTurnInterruption,
  buildSyntheticToolResponseParts,
} from './turn-interruption.js';
import {
  ORPHAN_TOOL_USE_REPAIR_REASON,
  repairOrphanedToolUseTurns,
} from './geminiChat.js';

export type SessionRecoveryKind =
  | 'clean'
  | 'interrupted_prompt'
  | 'interrupted_turn'
  | 'degraded_history';

export type RecoveryRepair =
  | { type: 'synthesized_tool_result'; callId: string; name: string }
  | { type: 'dropped_duplicate_tool_result'; callId: string; name: string }
  | { type: 'history_gap'; childUuid: string; missingParentUuid: string };

export interface SessionRecoveryContinuation {
  mode: 'retry_user_parts' | 'tool_result_parts';
  parts: Part[];
  displayText: string;
}

export interface SessionRecoveryPlan {
  planId: string;
  sessionId: string;
  kind: SessionRecoveryKind;
  originalApiHistory: Content[];
  apiHistory: Content[];
  repairs: RecoveryRepair[];
  canContinue: boolean;
  canAutoContinue: boolean;
  requiresUserConfirmation: boolean;
  visibleNotice?: string;
  continuation?: SessionRecoveryContinuation;
}

export interface BuildSessionRecoveryPlanInput {
  sessionId: string;
  conversation: ConversationRecord;
  historyGaps?: HistoryGap[];
  options?: {
    allowAutoContinue?: boolean;
  };
}

export interface BuildSessionRecoveryPlanFromApiHistoryInput {
  sessionId: string;
  apiHistory: Content[];
  historyGaps?: HistoryGap[];
  options?: {
    allowAutoContinue?: boolean;
  };
}

function createPlanId(sessionId: string, historyLength: number): string {
  return `${sessionId}:${historyLength}`;
}

function buildVisibleNotice(
  kind: SessionRecoveryKind,
  repairs: RecoveryRepair[],
  historyGaps: HistoryGap[],
): string | undefined {
  if (kind === 'clean') {
    return undefined;
  }

  if (kind === 'degraded_history') {
    return (
      `Resumed session history is incomplete: detected ` +
      `${historyGaps.length} missing parent link(s). Automatic continuation ` +
      `is disabled for this recovery.`
    );
  }

  if (kind === 'interrupted_prompt') {
    return 'Previous session appears to have stopped after user input before the model completed a response.';
  }

  const synthesized = repairs.filter(
    (repair) => repair.type === 'synthesized_tool_result',
  ).length;
  if (synthesized > 0) {
    return (
      `Previous session appears to have stopped during tool execution. ` +
      `Synthesized ${synthesized} failed tool result(s) so the history can continue safely.`
    );
  }

  return 'Previous session appears to have stopped during tool execution.';
}

export function buildSessionRecoveryPlan({
  sessionId,
  conversation,
  historyGaps,
  options,
}: BuildSessionRecoveryPlanInput): SessionRecoveryPlan {
  return buildSessionRecoveryPlanFromApiHistory({
    sessionId,
    apiHistory: buildApiHistoryFromConversation(conversation),
    historyGaps,
    options,
  });
}

export function buildSessionRecoveryPlanFromApiHistory({
  sessionId,
  apiHistory: inputApiHistory,
  historyGaps,
  options,
}: BuildSessionRecoveryPlanFromApiHistoryInput): SessionRecoveryPlan {
  const originalApiHistory = structuredClone(inputApiHistory);
  const gaps = historyGaps ?? [];
  const planId = createPlanId(sessionId, originalApiHistory.length);

  const apiHistory = structuredClone(originalApiHistory);
  const repairResult = repairOrphanedToolUseTurns(apiHistory);
  const repairs: RecoveryRepair[] = [
    ...repairResult.injected.map((repair) => ({
      type: 'synthesized_tool_result' as const,
      callId: repair.callId,
      name: repair.name,
    })),
    ...repairResult.droppedDuplicates.map((repair) => ({
      type: 'dropped_duplicate_tool_result' as const,
      callId: repair.callId,
      name: repair.name,
    })),
    ...gaps.map((gap) => ({
      type: 'history_gap' as const,
      childUuid: gap.childUuid,
      missingParentUuid: gap.missingParentUuid,
    })),
  ];

  if (gaps.length > 0) {
    return {
      planId,
      sessionId,
      kind: 'degraded_history',
      originalApiHistory,
      apiHistory,
      repairs,
      canContinue: false,
      canAutoContinue: false,
      requiresUserConfirmation: true,
      visibleNotice: buildVisibleNotice('degraded_history', repairs, gaps),
    };
  }

  const interruption = detectTurnInterruption(originalApiHistory);
  if (interruption.kind === 'none') {
    return {
      planId,
      sessionId,
      kind: 'clean',
      originalApiHistory,
      apiHistory,
      repairs,
      canContinue: false,
      canAutoContinue: false,
      requiresUserConfirmation: false,
    };
  }

  if (interruption.kind === 'interrupted_prompt') {
    const continuation: SessionRecoveryContinuation = {
      mode: 'retry_user_parts',
      parts: interruption.parts,
      displayText: 'Continue interrupted user prompt',
    };
    return {
      planId,
      sessionId,
      kind: 'interrupted_prompt',
      originalApiHistory,
      apiHistory,
      repairs,
      canContinue: true,
      canAutoContinue: options?.allowAutoContinue === true,
      requiresUserConfirmation: options?.allowAutoContinue !== true,
      visibleNotice: buildVisibleNotice('interrupted_prompt', repairs, gaps),
      continuation,
    };
  }

  const continuation: SessionRecoveryContinuation = {
    mode: 'tool_result_parts',
    parts: buildSyntheticToolResponseParts(
      interruption.danglingCalls,
      ORPHAN_TOOL_USE_REPAIR_REASON,
    ),
    displayText: 'Continue interrupted tool turn',
  };

  return {
    planId,
    sessionId,
    kind: 'interrupted_turn',
    originalApiHistory,
    apiHistory,
    repairs,
    canContinue: true,
    canAutoContinue: false,
    requiresUserConfirmation: true,
    visibleNotice: buildVisibleNotice('interrupted_turn', repairs, gaps),
    continuation,
  };
}
