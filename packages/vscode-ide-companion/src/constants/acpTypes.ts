/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP Types for VSCode Extension
 *
 * This file provides types for ACP protocol communication.
 */

// ACP JSON-RPC Protocol Types
export const JSONRPC_VERSION = '2.0' as const;

export type AcpBackend = 'qwen' | 'claude' | 'gemini' | 'codex';

export interface AcpRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number;
  method: string;
  params?: unknown;
}

export interface AcpResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number;
  result?: unknown;
  capabilities?: {
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface AcpNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

// Base interface for all session updates
export interface BaseSessionUpdate {
  sessionId: string;
}

// Content block type (simplified version, use schema.ContentBlock for validation)
export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

// User message chunk update
export interface UserMessageChunkUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'user_message_chunk';
    content: ContentBlock;
  };
}

// Agent message chunk update
export interface AgentMessageChunkUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'agent_message_chunk';
    content: ContentBlock;
  };
}

// Agent thought chunk update
export interface AgentThoughtChunkUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'agent_thought_chunk';
    content: ContentBlock;
  };
}

// Tool call update
export interface ToolCallUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'tool_call';
    toolCallId: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    title: string;
    kind:
      | 'read'
      | 'edit'
      | 'execute'
      | 'delete'
      | 'move'
      | 'search'
      | 'fetch'
      | 'think'
      | 'other';
    rawInput?: unknown;
    content?: Array<{
      type: 'content' | 'diff';
      content?: {
        type: 'text';
        text: string;
      };
      path?: string;
      oldText?: string | null;
      newText?: string;
    }>;
    locations?: Array<{
      path: string;
      line?: number | null;
    }>;
  };
}

// Tool call status update
export interface ToolCallStatusUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'tool_call_update';
    toolCallId: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    title?: string;
    kind?: string;
    rawInput?: unknown;
    content?: Array<{
      type: 'content' | 'diff';
      content?: {
        type: 'text';
        text: string;
      };
      path?: string;
      oldText?: string | null;
      newText?: string;
    }>;
    locations?: Array<{
      path: string;
      line?: number | null;
    }>;
  };
}

// Plan update
export interface PlanUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'plan';
    entries: Array<{
      content: string;
      priority: 'high' | 'medium' | 'low';
      status: 'pending' | 'in_progress' | 'completed';
    }>;
  };
}

// Union type for all session updates
export type AcpSessionUpdate =
  | UserMessageChunkUpdate
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | PlanUpdate;

// Permission request (simplified version, use schema.RequestPermissionRequest for validation)
export interface AcpPermissionRequest {
  sessionId: string;
  options: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
  toolCall: {
    toolCallId: string;
    rawInput?: {
      command?: string;
      description?: string;
      [key: string]: unknown;
    };
    title?: string;
    kind?: string;
  };
}

export type AcpMessage =
  | AcpRequest
  | AcpNotification
  | AcpResponse
  | AcpSessionUpdate;
