/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unified message types for adapter layer
 */

import type { ToolCallData } from '../components/toolcalls/shared/types.js';
import type { FileContext } from '../components/messages/UserMessage.js';

/**
 * Unified message type used by all webui components
 */
export type UnifiedMessageType =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking';

/**
 * Unified message format - normalized from ACP or JSONL sources
 */
export interface UnifiedMessage {
  /** Unique identifier */
  id: string;
  /** Message type */
  type: UnifiedMessageType;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Text content (for user/assistant/thinking messages) */
  content?: string;
  /** Tool call data (for tool_call type) */
  toolCall?: ToolCallData;
  /** Whether this is the first item in an AI response sequence */
  isFirst: boolean;
  /** Whether this is the last item in an AI response sequence */
  isLast: boolean;
  /** File context for user messages */
  fileContext?: FileContext[];
}

// Re-export FileContext for convenience
export type { FileContext };

/**
 * JSONL chat message format (ChatViewer input)
 */
export interface JSONLMessage {
  uuid: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp: string; // ISO timestamp string
  type: 'user' | 'assistant' | 'system' | 'tool_call';
  message?: {
    role?: string;
    parts?: Array<{ text: string }>; // Qwen format
    content?: string | unknown[]; // Claude format
  };
  model?: string;
  toolCall?: ToolCallData;
}

/**
 * ACP message format (vscode-ide-companion input)
 */
export interface ACPMessage {
  type: 'message' | 'in-progress-tool-call' | 'completed-tool-call';
  data: ACPMessageData | ToolCallData;
}

/**
 * ACP text message data
 */
export interface ACPMessageData {
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp?: number;
  fileContext?: FileContext[];
}

export type { ToolCallData };
