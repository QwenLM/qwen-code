/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { CustomInferenceStreamOptions } from '../customInferenceStreamOptions.js';

/** Google Gemini `generateContent` streaming API. */
export interface CustomInferenceGeminiApi {
  stream(
    input: GenerateContentParameters,
    options?: CustomInferenceStreamOptions,
  ): AsyncIterable<GenerateContentResponse>;
}

export type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
