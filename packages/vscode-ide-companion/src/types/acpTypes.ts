/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const JSONRPC_VERSION = '2.0' as const;
export const authMethod = 'qwen-oauth';

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

export interface UserMessageChunkUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'user_message_chunk';
    content: ContentBlock;
  };
}

export interface AgentMessageChunkUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'agent_message_chunk';
    content: ContentBlock;
  };
}

export interface AgentThoughtChunkUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'agent_thought_chunk';
    content: ContentBlock;
  };
}

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

export type ApprovalModeValue = 'plan' | 'default' | 'auto-edit' | 'yolo';

export {
  ApprovalMode,
  APPROVAL_MODE_MAP,
  APPROVAL_MODE_INFO,
  getApprovalModeInfoFromString,
} from './approvalModeTypes.js';

// Cyclic next-mode mapping used by UI toggles and other consumers
export const NEXT_APPROVAL_MODE: {
  [k in ApprovalModeValue]: ApprovalModeValue;
} = {
  // Hide "plan" from the public toggle sequence for now
  // Cycle: default -> auto-edit -> yolo -> default
  default: 'auto-edit',
  'auto-edit': 'yolo',
  plan: 'yolo',
  yolo: 'default',
};

// Current mode update (sent by agent when mode changes)
export interface CurrentModeUpdate extends BaseSessionUpdate {
  update: {
    sessionUpdate: 'current_mode_update';
    modeId: ApprovalModeValue;
  };
}

export type AcpSessionUpdate =
  | UserMessageChunkUpdate
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | PlanUpdate
  | CurrentModeUpdate;

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
