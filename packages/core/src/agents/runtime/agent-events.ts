/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolResultDisplay,
} from '../../tools/tools.js';
import type { Part, GenerateContentResponseUsageMetadata } from '@google/genai';

export type AgentEvent =
  | 'start'
  | 'round_start'
  | 'round_end'
  | 'stream_text'
  | 'tool_call'
  | 'tool_result'
  | 'tool_waiting_approval'
  | 'usage_metadata'
  | 'finish'
  | 'error';

export enum AgentEventType {
  START = 'start',
  ROUND_START = 'round_start',
  ROUND_END = 'round_end',
  STREAM_TEXT = 'stream_text',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  TOOL_WAITING_APPROVAL = 'tool_waiting_approval',
  USAGE_METADATA = 'usage_metadata',
  FINISH = 'finish',
  ERROR = 'error',
}

export interface AgentStartEvent {
  subagentId: string;
  name: string;
  model?: string;
  tools: string[];
  timestamp: number;
}

export interface AgentRoundEvent {
  subagentId: string;
  round: number;
  promptId: string;
  timestamp: number;
}

export interface AgentStreamTextEvent {
  subagentId: string;
  round: number;
  text: string;
  /** Whether this text is reasoning/thinking content (as opposed to regular output) */
  thought?: boolean;
  timestamp: number;
}

export interface AgentUsageEvent {
  subagentId: string;
  round: number;
  usage: GenerateContentResponseUsageMetadata;
  durationMs?: number;
  timestamp: number;
}

export interface AgentToolCallEvent {
  subagentId: string;
  round: number;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  description: string;
  timestamp: number;
}

export interface AgentToolResultEvent {
  subagentId: string;
  round: number;
  callId: string;
  name: string;
  success: boolean;
  error?: string;
  responseParts?: Part[];
  resultDisplay?: ToolResultDisplay;
  durationMs?: number;
  timestamp: number;
}

export interface AgentApprovalRequestEvent {
  subagentId: string;
  round: number;
  callId: string;
  name: string;
  description: string;
  confirmationDetails: Omit<ToolCallConfirmationDetails, 'onConfirm'> & {
    type: ToolCallConfirmationDetails['type'];
  };
  respond: (
    outcome: ToolConfirmationOutcome,
    payload?: Parameters<ToolCallConfirmationDetails['onConfirm']>[1],
  ) => Promise<void>;
  timestamp: number;
}

export interface AgentFinishEvent {
  subagentId: string;
  terminateReason: string;
  timestamp: number;
  rounds?: number;
  totalDurationMs?: number;
  totalToolCalls?: number;
  successfulToolCalls?: number;
  failedToolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentErrorEvent {
  subagentId: string;
  error: string;
  timestamp: number;
}

export class AgentEventEmitter {
  private ee = new EventEmitter();

  on(event: AgentEvent, listener: (...args: unknown[]) => void) {
    this.ee.on(event, listener);
  }

  off(event: AgentEvent, listener: (...args: unknown[]) => void) {
    this.ee.off(event, listener);
  }

  emit(event: AgentEvent, payload: unknown) {
    this.ee.emit(event, payload);
  }
}
