/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type StreamJsonFormat = 'text' | 'stream-json';

export interface StreamJsonAnnotation {
  type: string;
  value: string;
}

export interface StreamJsonTextBlock {
  type: 'text';
  text: string;
  annotations?: StreamJsonAnnotation[];
}

export interface StreamJsonThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  annotations?: StreamJsonAnnotation[];
}

export interface StreamJsonToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  annotations?: StreamJsonAnnotation[];
}

export interface StreamJsonToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: StreamJsonContentBlock[] | string;
  is_error?: boolean;
  annotations?: StreamJsonAnnotation[];
}

export type StreamJsonContentBlock =
  | StreamJsonTextBlock
  | StreamJsonThinkingBlock
  | StreamJsonToolUseBlock
  | StreamJsonToolResultBlock;

export interface StreamJsonAssistantEnvelope {
  type: 'assistant';
  message: {
    role: 'assistant';
    model?: string;
    content: StreamJsonContentBlock[];
  };
  parent_tool_use_id?: string;
}

export interface StreamJsonUserEnvelope {
  type: 'user';
  message: {
    role?: 'user';
    content: string | StreamJsonContentBlock[];
  };
  parent_tool_use_id?: string;
  options?: Record<string, unknown>;
}

export interface StreamJsonSystemEnvelope {
  type: 'system';
  subtype?: string;
  session_id?: string;
  data?: unknown;
}

export interface StreamJsonUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface StreamJsonResultEnvelope {
  type: 'result';
  subtype?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  session_id?: string;
  is_error?: boolean;
  summary?: string;
  usage?: StreamJsonUsage;
  total_cost_usd?: number;
  error?: { type?: string; message: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface StreamJsonMessageStreamEvent {
  type: string;
  index?: number;
  delta?: unknown;
  [key: string]: unknown;
}

export interface StreamJsonStreamEventEnvelope {
  type: 'stream_event';
  uuid: string;
  session_id?: string;
  event: StreamJsonMessageStreamEvent;
}

export interface StreamJsonControlRequestEnvelope {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: string;
    [key: string]: unknown;
  };
}

export interface StreamJsonControlResponseEnvelope {
  type: 'control_response';
  request_id: string;
  success?: boolean;
  response?: unknown;
  error?: string | { message: string; [key: string]: unknown };
}

export interface StreamJsonControlCancelRequestEnvelope {
  type: 'control_cancel_request';
  request_id?: string;
  reason?: string;
}

export type StreamJsonOutputEnvelope =
  | StreamJsonAssistantEnvelope
  | StreamJsonUserEnvelope
  | StreamJsonSystemEnvelope
  | StreamJsonResultEnvelope
  | StreamJsonStreamEventEnvelope
  | StreamJsonControlRequestEnvelope
  | StreamJsonControlResponseEnvelope
  | StreamJsonControlCancelRequestEnvelope;

export type StreamJsonInputEnvelope =
  | StreamJsonUserEnvelope
  | StreamJsonControlRequestEnvelope
  | StreamJsonControlResponseEnvelope
  | StreamJsonControlCancelRequestEnvelope;

export type StreamJsonEnvelope =
  | StreamJsonOutputEnvelope
  | StreamJsonInputEnvelope;

export function serializeStreamJsonEnvelope(
  envelope: StreamJsonOutputEnvelope,
): string {
  return JSON.stringify(envelope);
}

export class StreamJsonParseError extends Error {}

export function parseStreamJsonEnvelope(line: string): StreamJsonEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as StreamJsonEnvelope;
  } catch (error) {
    throw new StreamJsonParseError(
      `Failed to parse stream-json line: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new StreamJsonParseError('Parsed value is not an object');
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string') {
    throw new StreamJsonParseError('Missing required "type" field');
  }
  return parsed as StreamJsonEnvelope;
}
