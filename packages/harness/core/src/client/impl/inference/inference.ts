/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Pipeline } from '../../pipeline/pipeline.js';
import type { CustomInferenceApi } from '../../api/inference/inference.js';
import { CustomInferenceChatCompletionsApiImpl } from './chat-completions/chatCompletions.js';
import { CustomInferenceMessagesApiImpl } from './messages/messages.js';
import { CustomInferenceResponsesApiImpl } from './responses/responses.js';
import { CustomInferenceGeminiApiImpl } from './gemini/gemini.js';

/** Streaming inference APIs for supported public model protocols. */
export class CustomInferenceApiImpl implements CustomInferenceApi {
  readonly chatCompletions: CustomInferenceChatCompletionsApiImpl;
  readonly responses: CustomInferenceResponsesApiImpl;
  readonly messages: CustomInferenceMessagesApiImpl;
  readonly gemini: CustomInferenceGeminiApiImpl;

  constructor(pipeline: Pipeline) {
    this.chatCompletions = new CustomInferenceChatCompletionsApiImpl(pipeline);
    this.responses = new CustomInferenceResponsesApiImpl(pipeline);
    this.messages = new CustomInferenceMessagesApiImpl(pipeline);
    this.gemini = new CustomInferenceGeminiApiImpl(pipeline);
  }
}
