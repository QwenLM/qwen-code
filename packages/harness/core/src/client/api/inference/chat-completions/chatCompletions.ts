/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type { CustomInferenceStreamOptions } from '../customInferenceStreamOptions.js';

/** OpenAI Chat Completions streaming API. */
export interface CustomInferenceChatCompletionsApi {
  stream(
    input: ChatCompletionCreateParamsStreaming,
    options?: CustomInferenceStreamOptions,
  ): AsyncIterable<ChatCompletionChunk>;
}

export type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
