/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamRequest } from '../../modelStreamRequest.js';
import type { ModelStreamEvent } from '../../event/modelStreamEvent.js';
import type { ModelTransport } from '../modelTransport.js';
import { OPENAI_RESPONSES, type ModelProtocol } from '../modelProtocol.js';
import type { CustomClient } from '../../../client/customClient.js';
import { buildResponsesStreamReq } from './responses-factory/request/responsesStreamReqFactory.js';
import { buildResponsesStreamEvents } from './responses-factory/response/responsesStreamRespFactory.js';

/**
 * OpenAI Responses 协议的 ModelTransport：编码 → 调用 Client API → 解码。
 *
 * stream() 内部固定流水线：buildResponsesStreamReq 编码 SDK 请求体，
 * 经 client.api.inference.responses.stream 发起 SSE 调用（网络由
 * CustomClient 持有的 pipeline 执行），逐帧经 buildResponsesStreamEvents
 * 解码为中立事件流。
 */
export class ResponsesTransport implements ModelTransport {
  readonly protocol: ModelProtocol = OPENAI_RESPONSES;

  async *stream(
    client: CustomClient,
    request: ModelStreamRequest,
  ): AsyncGenerator<ModelStreamEvent> {
    const req = buildResponsesStreamReq(request);
    const frames = client.api.inference.responses.stream(req, {
      signal: request.control?.signal,
    });
    for await (const event of buildResponsesStreamEvents(frames)) {
      yield event;
    }
  }
}
