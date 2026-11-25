/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamRequest } from '../../modelStreamRequest.js';
import type { ModelStreamEvent } from '../../event/modelStreamEvent.js';
import type { ModelTransport } from '../modelTransport.js';
import {
  OPENAI_CHAT_COMPLETIONS,
  type ModelProtocol,
} from '../modelProtocol.js';
import type { CustomClient } from '../../../client/customClient.js';
import { buildChatCompletionsStreamReq } from './chat-completions-factory/request/chatCompletionsStreamReqFactory.js';
import { buildChatCompletionsStreamEvents } from './chat-completions-factory/response/chatCompletionsStreamRespFactory.js';

/**
 * OpenAI Chat Completions 协议的 ModelTransport：编码 → 调用 Client API → 解码。
 *
 * stream() 内部固定流水线：buildChatCompletionsStreamReq 编码 SDK 请求体，
 * 经 client.api.inference.chatCompletions.stream 发起 SSE 调用（网络由
 * CustomClient 持有的 pipeline 执行），逐帧经 buildChatCompletionsStreamEvents
 * 解码为中立事件流。
 */
export class ChatCompletionsTransport implements ModelTransport {
  readonly protocol: ModelProtocol = OPENAI_CHAT_COMPLETIONS;

  async *stream(
    client: CustomClient,
    request: ModelStreamRequest,
  ): AsyncGenerator<ModelStreamEvent> {
    const req = buildChatCompletionsStreamReq(request);
    const frames = client.api.inference.chatCompletions.stream(req, {
      signal: request.control?.signal,
    });
    for await (const event of buildChatCompletionsStreamEvents(frames)) {
      yield event;
    }
  }
}
