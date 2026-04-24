/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type DesktopClientMessage =
  | { type: 'ping' }
  | { type: 'stop_generation' }
  | { type: 'user_message'; content: string }
  | { type: 'set_permission_mode'; mode: DesktopApprovalMode }
  | { type: 'set_model'; modelId: string }
  | { type: 'permission_response'; requestId: string; optionId: string }
  | {
      type: 'ask_user_question_response';
      requestId: string;
      optionId: string;
      answers?: Record<string, string>;
    };

export type DesktopApprovalMode = 'plan' | 'default' | 'auto-edit' | 'yolo';

export interface DesktopModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface DesktopSessionModelState {
  currentModelId: string;
  availableModels: DesktopModelInfo[];
}

export interface DesktopSessionModeState {
  currentModeId: DesktopApprovalMode;
  availableModes: Array<{
    id: DesktopApprovalMode;
    name: string;
    description: string;
  }>;
}

export interface DesktopPlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface DesktopToolCallUpdate {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: Array<{ path: string; line?: number | null }>;
  timestamp?: number;
}

export interface DesktopUsageStats {
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    thoughtTokens?: number | null;
    totalTokens?: number | null;
    cachedReadTokens?: number | null;
    cachedWriteTokens?: number | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    thoughtsTokens?: number | null;
    cachedTokens?: number | null;
  } | null;
  durationMs?: number | null;
  tokenLimit?: number | null;
  cost?: unknown;
}

export interface DesktopAvailableCommand {
  name: string;
  description: string;
  input?: unknown;
}

export interface DesktopPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface DesktopPermissionRequest {
  sessionId: string;
  options: DesktopPermissionOption[];
  toolCall: DesktopToolCallUpdate;
}

export interface DesktopAskUserQuestionOption {
  label: string;
  description: string;
}

export interface DesktopAskUserQuestion {
  question: string;
  header: string;
  options: DesktopAskUserQuestionOption[];
  multiSelect: boolean;
}

export interface DesktopAskUserQuestionRequest {
  sessionId: string;
  questions: DesktopAskUserQuestion[];
  metadata?: Record<string, unknown>;
}

export type DesktopServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'pong' }
  | {
      type: 'message_delta';
      role: 'assistant' | 'thinking' | 'user';
      text: string;
    }
  | { type: 'tool_call'; data: DesktopToolCallUpdate }
  | { type: 'plan'; entries: DesktopPlanEntry[] }
  | { type: 'usage'; data: DesktopUsageStats }
  | { type: 'mode_changed'; mode: string }
  | { type: 'model_changed'; modelId: string }
  | {
      type: 'available_commands';
      commands: DesktopAvailableCommand[];
      skills: string[];
    }
  | {
      type: 'permission_request';
      requestId: string;
      request: DesktopPermissionRequest;
    }
  | {
      type: 'ask_user_question';
      requestId: string;
      request: DesktopAskUserQuestionRequest;
    }
  | { type: 'message_complete'; stopReason?: string }
  | { type: 'error'; code: string; message: string; retryable?: boolean };
