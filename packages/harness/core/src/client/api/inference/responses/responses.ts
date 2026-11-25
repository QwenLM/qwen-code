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
import type { CustomInferenceStreamOptions } from '../customInferenceStreamOptions.js';

/** OpenAI Responses streaming API. */
export interface CustomInferenceResponsesApi {
  stream(
    input: ResponseCreateParamsStreaming,
    options?: CustomInferenceStreamOptions,
  ): AsyncIterable<ResponseStreamEvent>;
}

export type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
