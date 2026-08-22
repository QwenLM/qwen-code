/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentParameters, Part } from '@google/genai';
import type { Config } from '../../config/config.js';
import type {
  ContentGeneratorConfig,
  InputModalities,
} from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import type { OpenAIResponseParsingOptions } from './responseParsingOptions.js';
import type { StreamingToolCallParser } from './streamingToolCallParser.js';
import type { TaggedThinkingParser } from './taggedThinkingParser.js';

export interface StreamingTextDeltaState {
  /**
   * Rolling baseline used for prefix/exact-repeat detection. Once the stream
   * has been classified as incremental and the buffer reaches
   * CUMULATIVE_DETECTION_WINDOW_BYTES bytes it is frozen at the cap to bound
   * memory; the true emitted total is tracked separately in `emittedLength`.
   * In cumulative mode this always reflects the full accumulated text.
   */
  emittedText: string;
  /**
   * Monotonic count of user-visible bytes already emitted on this channel.
   * Diverges from `emittedText.length` only on long incremental streams where
   * `emittedText` is capped at CUMULATIVE_DETECTION_WINDOW_BYTES. Used to slice
   * the correct suffix when an incremental-then-cumulative hybrid stream
   * transitions into cumulative mode after the cap (otherwise the suffix would
   * re-include bytes between the cap and the true emitted length, producing
   * visible duplication).
   */
  emittedLength: number;
  /** Integer token-estimate units accumulated from normalized emitted text. */
  emittedTokenUnits?: number;
  cumulativeMode: boolean;
}

export interface RequestContext {
  model: string;
  modalities: InputModalities;
  startTime: number;
  toolCallParser?: StreamingToolCallParser;
  responseParsingOptions?: OpenAIResponseParsingOptions;
  taggedThinkingParser?: TaggedThinkingParser;
  // When true, media parts in tool-result messages are split into a follow-up
  // user message for strict OpenAI-compat servers. See ContentGeneratorConfig
  // for details.
  splitToolMedia?: boolean;
  // Default keeps tool result text as content parts; "string" is an opt-in
  // compatibility mode for older OpenAI-compatible tool templates.
  toolResultContentFormat?: ContentGeneratorConfig['toolResultContentFormat'];
  /**
   * Per-stream mutable state for cumulative-delta normalization on the visible
   * content channel. Initialised lazily on first use. Must NOT be shared or
   * reused across requests — stale state will silently corrupt text output.
   */
  textDeltaState?: StreamingTextDeltaState;
  /**
   * Same as textDeltaState but for the reasoning/thinking content channel.
   * The two channels are tracked independently so interleaved chunks on each
   * channel are deduplicated correctly.
   */
  reasoningDeltaState?: StreamingTextDeltaState;
  /**
   * Tracks whether tagged-thinking parsing has emitted a thought part in the
   * current stream. Once true, separate reasoning_content deltas are considered
   * duplicate reasoning and are suppressed.
   */
  hasTaggedThinkingThought?: boolean;
  /**
   * Buffered reasoning_content for tagged-thinking streams until we know
   * whether visible content will emit tagged thought parts.
   */
  pendingReasoningText?: string;
  /**
   * Visible content buffered behind pending reasoning_content so it can be
   * emitted after the reasoning thought if no tagged thought appears.
   */
  pendingContentParts?: Part[];
  /** Tool IDs whose preparing metadata has already been emitted in this stream. */
  preparedToolCallIds?: Set<string>;
  pendingUntrustedResponseParts?: Part[];
  hasStructuredReasoningContent?: boolean;
  hasThinkingTagInReasoning?: boolean;
  hasVisibleContent?: boolean;
  atVisibleLineStart?: boolean;
  /**
   * Set once the inline thinking parser demotes a balanced content block to
   * the thought channel (issue #9348). After a demotion any further complete
   * thinking tag in visible content is embedded/stray and fails closed;
   * literal tag references are only sanctioned before a demotion happens.
   */
  inlineThinkingBlockDemoted?: boolean;
  /**
   * Trailing suffix of emitted visible text held back after an inline
   * thinking block demotion (issue #9348). Once visible content exists the
   * candidate machinery is disengaged, so a thinking tag assembled across
   * chunk boundaries would never appear complete in any one chunk; any
   * trailing suffix that could still complete into a tag is held here, the
   * leak gate runs on tail + next chunk, and finish fails closed when the
   * held suffix already contains a full tag word (sub-word fragments are
   * released as literal text — they can no longer become a tag).
   */
  pendingPostDemotionTagTail?: string;
  /**
   * Full accepted content-channel sequence since the first inline thinking
   * demotion (issue #9348). Short cumulative replays can pass through
   * normalizeStreamingTextDelta verbatim, so this sequence provides exact
   * replay evidence: an equal sequence is dropped, a prefix-extending
   * sequence contributes only its new suffix, and a proper-prefix re-send
   * (rewind replay) carrying a full tag word is dropped. Individual suffix
   * equality is deliberately insufficient because genuine adjacent deltas
   * may repeat.
   */
  postDemotionReplayText?: string;
  /**
   * Set once a chunk carrying finish_reason has been converted (issue #9348).
   * The pipeline treats content arriving after the finish chunk as droppable
   * (finishYielded / pendingFinishResponse merging), so the converter must
   * not fail closed a completed turn on post-finish redelivered tag-shaped
   * text — visible content arriving after this point is dropped instead of
   * running through the replay and leaked-tag gates.
   */
  finishChunkConverted?: boolean;
  pendingThinkingTagCandidate?: {
    text: string;
    closingTagName?: 'think' | 'thinking';
  };
  protocolTagSanitized?: {
    tagName: 'think' | 'thinking';
    toolCallCount: number;
  };
}

export interface ErrorHandler {
  handle(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): never;
  shouldSuppressErrorLogging(
    error: unknown,
    request: GenerateContentParameters,
  ): boolean;
}

export interface PipelineConfig {
  cliConfig: Config;
  provider: OpenAICompatibleProvider;
  contentGeneratorConfig: ContentGeneratorConfig;
  errorHandler: ErrorHandler;
}
