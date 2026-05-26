/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  ModelInfo,
  AvailableCommand,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk';
import type {
  AskUserQuestionRequest,
  SlashCommandNotification,
} from './acpTypes.js';
import type { ApprovalModeValue } from './approvalModeValueTypes.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: number;
  source?: string;
  /**
   * The ACP session id that produced this message, if known. The webview
   * persists messages keyed by the local conversation id, which equals the
   * ACP session id once a session is bound (see SessionMessageHandler.
   * updateCurrentConversationId). Forwarding the originating session id with
   * the message lets receivers attribute it to the conversation that owns
   * the work even if the user has since switched the active panel to a
   * different conversation (e.g. for background notification follow-ups).
   */
  sessionId?: string;
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
  rawOutput?: unknown;
  content?: Array<Record<string, unknown>>;
  locations?: Array<{ path: string; line?: number | null }>;
  timestamp?: number;
}

export interface UsageStatsPayload {
  usage?: {
    // SDK field names (primary)
    inputTokens?: number | null;
    outputTokens?: number | null;
    thoughtTokens?: number | null;
    totalTokens?: number | null;
    cachedReadTokens?: number | null;
    cachedWriteTokens?: number | null;
    // Legacy field names (compat with older CLI builds)
    promptTokens?: number | null;
    completionTokens?: number | null;
    thoughtsTokens?: number | null;
    cachedTokens?: number | null;
  } | null;
  durationMs?: number | null;
  tokenLimit?: number | null;
}

export interface QwenAgentCallbacks {
  onMessage?: (message: ChatMessage) => void;
  onStreamChunk?: (chunk: string) => void;
  onThoughtChunk?: (chunk: string) => void;
  onToolCall?: (update: ToolCallUpdateData) => void;
  onPlan?: (entries: PlanEntry[]) => void;
  onPermissionRequest?: (request: RequestPermissionRequest) => Promise<string>;
  onAskUserQuestion?: (
    request: AskUserQuestionRequest,
  ) => Promise<{ optionId: string; answers?: Record<string, string> }>;
  onEndTurn?: (reason?: string, source?: string) => void;
  onModeInfo?: (info: {
    currentModeId?: ApprovalModeValue;
    availableModes?: Array<{
      id: ApprovalModeValue;
      name: string;
      description: string;
    }>;
  }) => void;
  onModeChanged?: (modeId: ApprovalModeValue) => void;
  onUsageUpdate?: (stats: UsageStatsPayload) => void;
  onModelInfo?: (info: ModelInfo) => void;
  onModelChanged?: (model: ModelInfo) => void;
  onAvailableCommands?: (commands: AvailableCommand[]) => void;
  onAvailableSkills?: (skills: string[]) => void;
  onAvailableModels?: (models: ModelInfo[]) => void;
  onDisconnected?: (code: number | null, signal: string | null) => void;
  onSlashCommandNotification?: (event: SlashCommandNotification) => void;
}

export interface ToolCallUpdate {
  type: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  rawInput?: unknown;
  rawOutput?: unknown;
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
  /** Server-side metadata including timestamp for correct ordering */
  _meta?: {
    timestamp?: number;
    toolName?: string;
    [key: string]: unknown;
  };
}
