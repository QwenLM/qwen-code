/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Universal export message format - SSOT for all export formats.
 * This is format-agnostic and contains all information needed for any export type.
 */
export interface ExportMessage {
  uuid: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'system' | 'tool_call';

  /** For user/assistant messages */
  message?: {
    role?: string;
    parts?: Array<{ text: string }>;
    content?: string;
  };

  /** Model used for assistant messages */
  model?: string;

  /** For tool_call messages */
  toolCall?: {
    toolCallId: string;
    kind: string;
    title: string | object;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    rawInput?: string | object;
    content?: Array<{
      type: string;
      [key: string]: unknown;
    }>;
    locations?: Array<{
      path: string;
      line?: number | null;
    }>;
    timestamp?: number;
  };
}

/**
 * Complete export session data - the single source of truth.
 */
export interface ExportSessionData {
  sessionId: string;
  startTime: string;
  messages: ExportMessage[];
}
