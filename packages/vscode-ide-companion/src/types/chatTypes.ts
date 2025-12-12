/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AcpPermissionRequest, ApprovalModeValue } from './acpTypes.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface PlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolCallUpdateData {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  content?: Array<Record<string, unknown>>;
  locations?: Array<{ path: string; line?: number | null }>;
}

export interface QwenAgentCallbacks {
  onMessage?: (message: ChatMessage) => void;
  onStreamChunk?: (chunk: string) => void;
  onThoughtChunk?: (chunk: string) => void;
  onToolCall?: (update: ToolCallUpdateData) => void;
  onPlan?: (entries: PlanEntry[]) => void;
  onPermissionRequest?: (request: AcpPermissionRequest) => Promise<string>;
  onEndTurn?: () => void;
  onModeInfo?: (info: {
    currentModeId?: ApprovalModeValue;
    availableModes?: Array<{
      id: ApprovalModeValue;
      name: string;
      description: string;
    }>;
  }) => void;
  onModeChanged?: (modeId: ApprovalModeValue) => void;
}

export interface ToolCallUpdate {
  type: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  rawInput?: unknown;
  content?: Array<{
    type: 'content' | 'diff';
    content?: {
      type: string;
      text?: string;
      [key: string]: unknown;
    };
    path?: string;
    oldText?: string | null;
    newText?: string;
    [key: string]: unknown;
  }>;
  locations?: Array<{
    path: string;
    line?: number | null;
  }>;
  timestamp?: number; // Add timestamp field for message ordering
}
