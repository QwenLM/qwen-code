/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';
import type { ModelStreamRequest } from '../../modelStreamRequest.js';
import type { ModelStreamEvent } from '../../event/modelStreamEvent.js';
import type { ModelTransport } from '../modelTransport.js';
import { GOOGLE_GEMINI, type ModelProtocol } from '../modelProtocol.js';
import type { CustomClient } from '../../../client/customClient.js';
import { buildGeminiStreamReq } from './gemini-factory/request/geminiStreamReqFactory.js';
import { buildGeminiStreamEvents } from './gemini-factory/response/geminiStreamRespFactory.js';
import { ModelWireUtils } from '../../utils/modelWireUtils.js';

/** Gemini `generateContent` 协议的 ModelTransport。 */
export class GeminiTransport implements ModelTransport {
  readonly protocol: ModelProtocol = GOOGLE_GEMINI;

  async *stream(
    client: CustomClient,
    request: ModelStreamRequest,
  ): AsyncGenerator<ModelStreamEvent> {
    const gemini = client.api.inference.gemini;
    if (!gemini) {
      throw new Error('This client does not support the Gemini protocol.');
    }
    const req = buildGeminiStreamReq(request);
    const frames = gemini.stream(req, {
      signal: request.control?.signal,
    }) as AsyncIterable<GenerateContentResponse>;
    yield* buildGeminiStreamEvents(
      frames,
      ModelWireUtils.modelId(request.resolution.model),
    );
  }
}
