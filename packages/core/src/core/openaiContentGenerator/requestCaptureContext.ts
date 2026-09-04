/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type OpenAI from 'openai';

/**
 * Lets the `LoggingContentGenerator` decorator observe the exact OpenAI
 * request that `ContentGenerationPipeline` built and handed to the SDK,
 * including provider-injected fields (`extra_body`, `metadata`,
 * `stream_options`, `samplingParams` pass-through keys, etc.) — without
 * which the logger would have to reconstruct a parallel request and
 * silently miss those fields.
 */
export type OpenAIRequestCapture = (
  request: OpenAI.Chat.ChatCompletionCreateParams,
) => void;

export const openaiRequestCaptureContext =
  new AsyncLocalStorage<OpenAIRequestCapture>();
