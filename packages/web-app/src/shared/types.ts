/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session information for the Web GUI
 */
export interface Session {
  id: string;
  title: string;
  lastUpdated: string;
  startTime?: string;
  isRunning?: boolean;
}

/**
 * Message types
 */
export type MessageType =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking'
  | 'system';

/**
 * Message content part
 */
export interface MessagePart {
  text: string;
  thought?: boolean;
}

/**
 * Tool call content
 */
export interface ToolCallContent {
  type: 'content' | 'diff';
  content?: {
    type: string;
    text?: string;
    error?: unknown;
    [key: string]: unknown;
  };
  path?: string;
  oldText?: string | null;
  newText?: string;
}

/**
 * Tool call location
 */
export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

/**
 * Tool call status
 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Tool call data
 */
export interface ToolCallData {
  toolCallId: string;
  kind: string;
  title: string | object;
  status: ToolCallStatus;
  rawInput?: string | object;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  timestamp?: number;
}

/**
 * Chat message
 */
export interface Message {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  type: MessageType;
  message?: {
    role: string;
    parts?: MessagePart[];
    content?: string | unknown[];
  };
  toolCall?: ToolCallData;
}

/**
 * Permission request
 */
export interface PermissionOption {
  name: string;
  kind: string;
  optionId: string;
}

export interface PermissionRequest {
  id: string;
  operation: string;
  args: Record<string, unknown>;
  description?: string;
  options?: PermissionOption[];
  toolCall?: ToolCallData;
}

/**
 * WebSocket message types
 */
export type WSMessageType =
  | 'join_session'
  | 'leave_session'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'thinking'
  | 'stream_start'
  | 'stream_end'
  | 'history'
  | 'permission_request'
  | 'permission_response'
  | 'cancel'
  | 'error';

/**
 * WebSocket message base
 */
export interface WSMessage {
  type: WSMessageType;
  sessionId?: string;
  [key: string]: unknown;
}

/**
 * API response for listing sessions
 */
export interface SessionsListResponse {
  sessions: Session[];
  hasMore: boolean;
}

/**
 * API response for session details
 */
export interface SessionDetailResponse {
  id: string;
  title: string;
  messages: Message[];
  lastUpdated: string;
}

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  host: string;
  open: boolean;
}
