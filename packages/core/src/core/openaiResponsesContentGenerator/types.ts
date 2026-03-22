/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// ── Request types ──────────────────────────────────────────────────────

export type ResponsesApiVerbosity = 'low' | 'medium' | 'high';
export type ResponsesApiReasoningEffort = 'low' | 'medium' | 'high';
export type ResponsesApiReasoningSummary = 'auto' | 'concise' | 'detailed';
export type ResponsesApiServiceTier = 'auto' | 'priority';

export interface ResponsesApiTextControls {
  format?: ResponsesApiTextFormat;
  verbosity?: ResponsesApiVerbosity;
}

export interface ResponsesApiTextFormat {
  type: 'text' | 'json_schema';
  strict?: boolean;
  schema?: Record<string, unknown>;
  name?: string;
}

export interface ResponsesApiReasoning {
  effort?: ResponsesApiReasoningEffort;
  summary?: ResponsesApiReasoningSummary;
}

export interface ResponsesApiToolFunction {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export type ResponsesApiTool = ResponsesApiToolFunction;

export interface ResponsesApiTruncation {
  type: 'auto' | 'disabled';
}

export interface ResponsesApiRequest {
  model: string;
  input: ResponsesApiInputItem[];
  instructions?: string;
  tools?: ResponsesApiTool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  truncation?: ResponsesApiTruncation;
  previous_response_id?: string;
  prompt_cache_key?: string;
  reasoning?: ResponsesApiReasoning;
  text?: ResponsesApiTextControls;
  service_tier?: ResponsesApiServiceTier;
  include?: string[];
  store?: boolean;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  metadata?: Record<string, string>;
}

// ── Input item types (what we send) ────────────────────────────────────

export type ResponsesApiInputItem =
  | ResponsesApiMessageItem
  | ResponsesApiFunctionCallItem
  | ResponsesApiFunctionCallOutputItem
  | ResponsesApiItemReference
  | ResponsesApiReasoningItem
  | ResponsesApiCompactionItem;

export interface ResponsesApiReasoningItem {
  type: 'reasoning';
  id: string;
  encrypted_content: string;
}

export interface ResponsesApiCompactionItem {
  type: 'compaction';
  encrypted_content: string;
}

export interface ResponsesApiMessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesApiContentPart[];
}

export type ResponsesApiContentPart =
  | ResponsesApiTextPart
  | ResponsesApiImagePart;

export interface ResponsesApiTextPart {
  type: 'input_text';
  text: string;
}

export interface ResponsesApiImagePart {
  type: 'input_image';
  image_url: string;
  detail?: 'auto' | 'low' | 'high';
}

export interface ResponsesApiFunctionCallItem {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesApiFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface ResponsesApiItemReference {
  type: 'item_reference';
  item_id: string;
}

// ── Output item types (what we receive) ────────────────────────────────

export interface ResponsesApiOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  content: ResponsesApiOutputContentPart[];
}

export interface ResponsesApiOutputTextPart {
  type: 'output_text';
  text: string;
}

export type ResponsesApiOutputContentPart = ResponsesApiOutputTextPart;

export interface ResponsesApiOutputFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesApiOutputReasoningSummary {
  type: 'reasoning';
  id: string;
  summary: ResponsesApiReasoningSummaryContent[];
  encrypted_content?: string;
}

export interface ResponsesApiReasoningSummaryContent {
  type: 'summary_text';
  text: string;
}

export type ResponsesApiOutputItem =
  | ResponsesApiOutputMessage
  | ResponsesApiOutputFunctionCall
  | ResponsesApiOutputReasoningSummary;

// ── Response envelope ──────────────────────────────────────────────────

export interface ResponsesApiUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface ResponsesApiResponse {
  id: string;
  object: 'response';
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress';
  output: ResponsesApiOutputItem[];
  usage?: ResponsesApiUsage;
  model?: string;
  error?: {
    code: string;
    message: string;
  };
}

// ── SSE event types ────────────────────────────────────────────────────

export type ResponsesSSEEventType =
  | 'response.created'
  | 'response.in_progress'
  | 'response.output_item.added'
  | 'response.output_item.done'
  | 'response.content_part.added'
  | 'response.content_part.done'
  | 'response.output_text.delta'
  | 'response.output_text.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done'
  | 'response.reasoning_summary_part.added'
  | 'response.reasoning_summary_part.done'
  | 'response.reasoning_summary_text.delta'
  | 'response.reasoning_summary_text.done'
  | 'response.completed'
  | 'response.failed'
  | 'response.incomplete'
  | 'error';

export interface ResponsesSSEEvent {
  event: ResponsesSSEEventType;
  data: Record<string, unknown>;
}

export interface ResponseCreatedEvent {
  event: 'response.created';
  data: ResponsesApiResponse;
}

export interface OutputItemAddedEvent {
  event: 'response.output_item.added';
  data: {
    output_index: number;
    item: ResponsesApiOutputItem;
  };
}

export interface OutputTextDeltaEvent {
  event: 'response.output_text.delta';
  data: {
    output_index: number;
    content_index: number;
    delta: string;
  };
}

export interface FunctionCallArgumentsDeltaEvent {
  event: 'response.function_call_arguments.delta';
  data: {
    output_index: number;
    delta: string;
  };
}

export interface ReasoningSummaryTextDeltaEvent {
  event: 'response.reasoning_summary_text.delta';
  data: {
    output_index: number;
    summary_index: number;
    delta: string;
  };
}

export interface OutputItemDoneEvent {
  event: 'response.output_item.done';
  data: {
    output_index: number;
    item: ResponsesApiOutputItem;
  };
}

export interface ResponseCompletedEvent {
  event: 'response.completed';
  data: ResponsesApiResponse;
}

export interface ResponseFailedEvent {
  event: 'response.failed';
  data: ResponsesApiResponse;
}

export interface SSEErrorEvent {
  event: 'error';
  data: {
    code: string;
    message: string;
  };
}
