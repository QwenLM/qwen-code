/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AcpPermissionRequest } from '../constants/acpTypes.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * Plan Entry
 */
export interface PlanEntry {
  /** Entry content */
  content: string;
  /** Priority */
  priority: 'high' | 'medium' | 'low';
  /** Status */
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Tool Call Update Data
 */
export interface ToolCallUpdateData {
  /** Tool call ID */
  toolCallId: string;
  /** Tool type */
  kind?: string;
  /** Tool title */
  title?: string;
  /** Status */
  status?: string;
  /** Raw input */
  rawInput?: unknown;
  /** Content */
  content?: Array<Record<string, unknown>>;
  /** Location information */
  locations?: Array<{ path: string; line?: number | null }>;
}

/**
 * Callback Functions Collection
 */
export interface QwenAgentCallbacks {
  /** Message callback */
  onMessage?: (message: ChatMessage) => void;
  /** Stream text chunk callback */
  onStreamChunk?: (chunk: string) => void;
  /** Thought text chunk callback */
  onThoughtChunk?: (chunk: string) => void;
  /** Tool call callback */
  onToolCall?: (update: ToolCallUpdateData) => void;
  /** Plan callback */
  onPlan?: (entries: PlanEntry[]) => void;
  /** Permission request callback */
  onPermissionRequest?: (request: AcpPermissionRequest) => Promise<string>;
  /** End of turn callback (e.g., stopReason === 'end_turn') */
  onEndTurn?: () => void;
}
