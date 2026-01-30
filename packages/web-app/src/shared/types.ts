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
}

/**
 * Tool call data
 */
export interface ToolCallData {
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'success' | 'error';
  result?: unknown;
  error?: string;
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
    content?: string;
  };
  toolCall?: ToolCallData;
}

/**
 * Permission request
 */
export interface PermissionRequest {
  id: string;
  operation: string;
  args: Record<string, unknown>;
  description?: string;
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
