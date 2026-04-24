/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type DesktopClientMessage =
  | { type: 'ping' }
  | { type: 'stop_generation' }
  | { type: 'user_message'; content: string };

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
  | {
      type: 'available_commands';
      commands: DesktopAvailableCommand[];
      skills: string[];
    }
  | { type: 'message_complete'; stopReason?: string }
  | { type: 'error'; code: string; message: string; retryable?: boolean };
