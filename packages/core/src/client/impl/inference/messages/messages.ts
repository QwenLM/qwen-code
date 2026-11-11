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
import type { Pipeline } from '../../../pipeline/pipeline.js';
import type { CustomInferenceMessagesApi } from '../../../api/inference/messages/messages.js';
import type { CustomInferenceStreamOptions } from '../../../api/inference/customInferenceStreamOptions.js';
import { streamInferenceSse } from '../inferenceSse.js';

/** Messages 协议版本标头，与旧链路默认值一致。 */
const ANTHROPIC_VERSION = '2023-06-01';

export class CustomInferenceMessagesApiImpl
  implements CustomInferenceMessagesApi
{
  constructor(protected readonly pipeline: Pipeline) {}

  stream(
    input: MessageCreateParamsStreaming,
    options: CustomInferenceStreamOptions = {},
  ): AsyncIterable<RawMessageStreamEvent> {
    return streamInferenceSse<RawMessageStreamEvent>(this.pipeline, {
      operation: 'inference.messages.stream',
      path: '/v1/messages',
      body: input,
      headers: { 'anthropic-version': ANTHROPIC_VERSION },
      signal: options.signal,
    });
  }
}
