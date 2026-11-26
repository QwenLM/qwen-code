/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamRequest } from '../../modelStreamRequest.js';
import type { ModelStreamEvent } from '../../event/modelStreamEvent.js';
import type { ModelTransport } from '../modelTransport.js';
import { ANTHROPIC_MESSAGES, type ModelProtocol } from '../modelProtocol.js';
import type { CustomClient } from '../../../client/customClient.js';
import { buildMessagesStreamReq } from './messages-factory/request/messagesStreamReqFactory.js';
import { buildMessagesStreamEvents } from './messages-factory/response/messagesStreamRespFactory.js';

/**
 * Anthropic Messages 协议的 ModelTransport：编码 → 调用 Client API → 解码。
 *
 * stream() 内部固定流水线：buildMessagesStreamReq 编码 SDK 请求体，
 * 经 client.api.inference.messages.stream 发起 SSE 调用（网络由
 * CustomClient 持有的 pipeline 执行），逐帧经 buildMessagesStreamEvents
 * 解码为中立事件流。
 */
export class MessagesTransport implements ModelTransport {
  readonly protocol: ModelProtocol = ANTHROPIC_MESSAGES;

  async *stream(
    client: CustomClient,
    request: ModelStreamRequest,
  ): AsyncGenerator<ModelStreamEvent> {
    const req = buildMessagesStreamReq(request);
    const frames = client.api.inference.messages.stream(req, {
      signal: request.control?.signal,
    });
    for await (const event of buildMessagesStreamEvents(frames)) {
      yield event;
    }
  }
}
