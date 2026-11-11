/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 思考记录的回放元数据；响应与请求历史共用，不含协议 DTO 或重复密文。
 */
export interface ModelReasoningMetadata {
  readonly id?: string;
  readonly type?: string;
  readonly status?: 'in_progress' | 'completed' | 'incomplete';
  readonly summary?: ReadonlyArray<{
    readonly type: string;
    readonly text: string;
  }>;
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text: string;
  }>;
}

/**
 * Protocol-neutral token usage reported by a model stream: input, output,
 * cache-read input, cache-creation input, and reasoning tokens.
 *
 * All counters are optional because providers expose different usage details
 * at different stages of the stream.
 */
export interface ModelStreamUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly reasoningTokens?: number;
}

/** Why a normally completed model message stopped producing content. */
export type ModelStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal';

export interface ModelMessageStartEvent {
  readonly type: 'message_start';
  readonly message: {
    readonly id: string;
    readonly role: 'assistant';
    readonly model: string;
    readonly usage?: ModelStreamUsage;
  };
}

export interface ModelTextBlockStartEvent {
  readonly type: 'content_block_start';
  readonly index: number;
  readonly contentBlock: {
    readonly type: 'text';
    readonly text: '';
  };
}

export interface ModelThinkingBlockStartEvent {
  readonly type: 'content_block_start';
  readonly index: number;
  readonly contentBlock: {
    readonly type: 'thinking';
    readonly thinking: '';
    readonly reasoning?: ModelReasoningMetadata;
  };
}

export interface ModelRedactedThinkingBlockStartEvent {
  readonly type: 'content_block_start';
  readonly index: number;
  readonly contentBlock: {
    readonly type: 'redacted_thinking';
    /** Opaque provider data required to replay the reasoning context. */
    readonly data: string;
    readonly reasoning?: ModelReasoningMetadata;
  };
}

export interface ModelToolUseBlockStartEvent {
  readonly type: 'content_block_start';
  readonly index: number;
  readonly contentBlock: {
    readonly type: 'tool_use';
    readonly id: string;
    readonly name: string;
    /** Tool input arrives incrementally through `input_json_delta` events. */
    readonly input: Readonly<Record<string, never>>;
    /** Opaque provider data (Gemini thought signature) replayed with history. */
    readonly thoughtSignature?: string;
  };
}

export type ModelContentBlockStartEvent =
  | ModelTextBlockStartEvent
  | ModelThinkingBlockStartEvent
  | ModelRedactedThinkingBlockStartEvent
  | ModelToolUseBlockStartEvent;

export interface ModelTextBlockDeltaEvent {
  readonly type: 'content_block_delta';
  readonly index: number;
  readonly delta: {
    readonly type: 'text_delta';
    readonly text: string;
  };
}

export interface ModelThinkingBlockDeltaEvent {
  readonly type: 'content_block_delta';
  readonly index: number;
  readonly delta: {
    readonly type: 'thinking_delta';
    readonly thinking: string;
  };
}

export interface ModelSignatureBlockDeltaEvent {
  readonly type: 'content_block_delta';
  readonly index: number;
  readonly delta: {
    readonly type: 'signature_delta';
    /** Opaque integrity data associated with a thinking block. */
    readonly signature: string;
  };
}

export interface ModelToolInputBlockDeltaEvent {
  readonly type: 'content_block_delta';
  readonly index: number;
  readonly delta: {
    readonly type: 'input_json_delta';
    /** A JSON fragment; consumers parse it only after the block closes. */
    readonly partial_json: string;
  };
}

export type ModelContentBlockDeltaEvent =
  | ModelTextBlockDeltaEvent
  | ModelThinkingBlockDeltaEvent
  | ModelSignatureBlockDeltaEvent
  | ModelToolInputBlockDeltaEvent;

export interface ModelContentBlockStopEvent {
  readonly type: 'content_block_stop';
  readonly index: number;
  /** 思考记录元数据可晚于文本到达，在关块时并入完整思考块。 */
  readonly reasoning?: ModelReasoningMetadata;
}

/**
 * Final message-level state. This is emitted once after all content blocks,
 * not after each `content_block_stop`.
 */
export interface ModelMessageDeltaEvent {
  readonly type: 'message_delta';
  readonly delta: {
    readonly stopReason: ModelStopReason;
  };
  readonly usage?: ModelStreamUsage;
}

export interface ModelMessageStopEvent {
  readonly type: 'message_stop';
}

/**
 * Protocol-neutral model output stream.
 *
 * Provider errors and cancellation are iterator failures rather than members
 * of this union. Provider billing, routing, and account metadata are excluded.
 */
export type ModelStreamEvent =
  | ModelMessageStartEvent
  | ModelContentBlockStartEvent
  | ModelContentBlockDeltaEvent
  | ModelContentBlockStopEvent
  | ModelMessageDeltaEvent
  | ModelMessageStopEvent;
