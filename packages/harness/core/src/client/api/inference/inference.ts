/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomInferenceChatCompletionsApi } from './chat-completions/chatCompletions.js';
import type { CustomInferenceMessagesApi } from './messages/messages.js';
import type { CustomInferenceGeminiApi } from './gemini/gemini.js';
import type { CustomInferenceResponsesApi } from './responses/responses.js';

/** Streaming inference APIs for supported public model protocols. */
export interface CustomInferenceApi {
  readonly chatCompletions: CustomInferenceChatCompletionsApi;
  readonly responses: CustomInferenceResponsesApi;
  readonly messages: CustomInferenceMessagesApi;
  readonly gemini?: CustomInferenceGeminiApi;
}

export type { CustomInferenceStreamOptions } from './customInferenceStreamOptions.js';
export * from './chat-completions/chatCompletions.js';
export * from './messages/messages.js';
export * from './responses/responses.js';
export * from './gemini/gemini.js';
