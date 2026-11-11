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
import type { Pipeline } from '../../../pipeline/pipeline.js';
import type { CustomInferenceChatCompletionsApi } from '../../../api/inference/chat-completions/chatCompletions.js';
import type { CustomInferenceStreamOptions } from '../../../api/inference/customInferenceStreamOptions.js';
import { streamInferenceSse } from '../inferenceSse.js';

export class CustomInferenceChatCompletionsApiImpl
  implements CustomInferenceChatCompletionsApi
{
  constructor(protected readonly pipeline: Pipeline) {}

  stream(
    input: ChatCompletionCreateParamsStreaming,
    options: CustomInferenceStreamOptions = {},
  ): AsyncIterable<ChatCompletionChunk> {
    return streamInferenceSse<ChatCompletionChunk>(this.pipeline, {
      operation: 'inference.chatCompletions.stream',
      path: '/chat/completions',
      body: input,
      signal: options.signal,
    });
  }
}
