/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelReasoningMetadata,
  ModelStopReason,
  ModelStreamUsage,
} from './modelStreamEvent.js';

/** A completed text block. */
export interface ModelTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** A completed thinking block with its integrity signature. */
export interface ModelThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature?: string;
  /** 随历史思考回传的记录身份、状态及原始摘要。 */
  readonly reasoning?: ModelReasoningMetadata;
}

/** A completed redacted thinking block. */
export interface ModelRedactedThinkingBlock {
  readonly type: 'redacted_thinking';
  /** Opaque provider data required to replay the reasoning context. */
  readonly data: string;
  /** 与 data 属于同一条思考记录，回放时一并保留。 */
  readonly reasoning?: ModelReasoningMetadata;
}

/** A completed tool invocation block with its parsed input object. */
export interface ModelToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  /** Parsed from the incremental `input_json_delta` fragments. */
  readonly input: Record<string, unknown>;
  /** Present only when the accumulated fragments failed to parse as JSON. */
  readonly inputJson?: string;
  /** Opaque provider data (Gemini thought signature) replayed with history. */
  readonly thoughtSignature?: string;
}

export type ModelContentBlock =
  | ModelTextBlock
  | ModelThinkingBlock
  | ModelRedactedThinkingBlock
  | ModelToolUseBlock;

/**
 * Protocol-neutral aggregated outcome of one model stream: the same content
 * the `ModelStreamEvent` leg produced, assembled into a single result.
 *
 * Deliberately excludes billing, routing, and account metadata, and does not
 * reuse the legacy BetaMessage-compatible assembler shape.
 */
export interface ModelMessage {
  readonly messageId: string;
  readonly model: string;
  readonly blocks: readonly ModelContentBlock[];
  readonly stopReason?: ModelStopReason;
  readonly usage?: ModelStreamUsage;
}

/**
 * Aggregate completion events, emitted by the stream aggregator into the
 * `events` leg as a supplement to the raw block-lifecycle primitives.
 *
 * Two completion dimensions:
 * - `content_block_complete`: one per finished content block, carried before
 *   the matching `content_block_stop` (mirroring the legacy assistant_block
 *   timing) so per-block consumers such as streaming tool execution can act
 *   immediately.
 * - `message_complete`: one per finished message, carried at end of stream
 *   with the fully aggregated outcome (same content `completed` resolves
 *   with) for consumers that read the whole message inline.
 *
 * Callers that only render incremental deltas can ignore this union
 * entirely.
 *
 * This is deliberately a separate union from `ModelStreamEvent`: the two
 * layers have different discriminant shapes (primitives carry `index`,
 * aggregate completions carry full content), and mixing them would force
 * every consumer to disambiguate layers before dispatching.
 */
export interface ModelBlockCompleteEvent {
  readonly type: 'content_block_complete';
  readonly index: number;
  /**
   * The fully assembled block. The `input` of a `tool_use` block is the
   * parsed object; when the accumulated fragments failed to parse, the raw
   * JSON string is kept in `inputJson` instead.
   */
  readonly block: ModelContentBlock;
}

export interface ModelMessageCompleteEvent {
  readonly type: 'message_complete';
  /** The fully aggregated message outcome, identical to `completed`. */
  readonly result: ModelMessage;
}

export type ModelCompleteEvent =
  | ModelBlockCompleteEvent
  | ModelMessageCompleteEvent;
