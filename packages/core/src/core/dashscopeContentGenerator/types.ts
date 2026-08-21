/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DashScopeCacheControl {
  type: 'ephemeral';
}

export interface DashScopeContentBlock {
  text?: string;
  image?: string;
  video?: string;
  audio?: string;
  file?: string;
  cache_control?: DashScopeCacheControl;
}

export interface DashScopeToolCall {
  id: string;
  index?: number;
  type: 'function';
  function: { name?: string; arguments?: string };
}

export interface DashScopeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | DashScopeContentBlock[];
  reasoning_content?: string;
  tool_calls?: DashScopeToolCall[];
  tool_call_id?: string;
}

export interface DashScopeTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  cache_control?: DashScopeCacheControl;
}

export interface DashScopeRequest {
  model: string;
  input: { messages: DashScopeMessage[] };
  parameters: Record<string, unknown>;
}

export interface DashScopeUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_type?: string;
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number };
  };
  input_tokens_details?: Record<string, number | null | undefined>;
  output_tokens_details?: { text_tokens?: number; reasoning_tokens?: number };
}

export interface DashScopeChoice {
  index?: number;
  finish_reason?: string | null;
  message?: DashScopeMessage & { tool_calls?: DashScopeToolCall[] };
}

export interface DashScopeResponsePayload {
  output?: { choices?: DashScopeChoice[] };
  usage?: DashScopeUsage;
  request_id?: string;
}

export interface DashScopeErrorEnvelope {
  code?: string;
  message?: string;
  request_id?: string;
}
