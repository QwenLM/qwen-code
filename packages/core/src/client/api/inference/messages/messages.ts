/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { CustomInferenceStreamOptions } from '../customInferenceStreamOptions.js';

/** Anthropic Messages streaming API. */
export interface CustomInferenceMessagesApi {
  stream(
    input: MessageCreateParamsStreaming,
    options?: CustomInferenceStreamOptions,
  ): AsyncIterable<RawMessageStreamEvent>;
}

export type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages/messages';
