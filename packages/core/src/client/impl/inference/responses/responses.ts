/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { Pipeline } from '../../../pipeline/pipeline.js';
import type { CustomInferenceResponsesApi } from '../../../api/inference/responses/responses.js';
import type { CustomInferenceStreamOptions } from '../../../api/inference/customInferenceStreamOptions.js';
import { streamInferenceSse } from '../inferenceSse.js';

export class CustomInferenceResponsesApiImpl
  implements CustomInferenceResponsesApi
{
  constructor(protected readonly pipeline: Pipeline) {}

  stream(
    input: ResponseCreateParamsStreaming,
    options: CustomInferenceStreamOptions = {},
  ): AsyncIterable<ResponseStreamEvent> {
    return streamInferenceSse<ResponseStreamEvent>(this.pipeline, {
      operation: 'inference.responses.stream',
      path: '/v1/responses',
      body: input,
      signal: options.signal,
    });
  }
}
