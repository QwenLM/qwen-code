/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isSseDone } from '../../../protocol/provider/payload-parser.js';
import { streamSSE } from '../../../protocol/provider/sse-client.js';
import {
  ClientError,
  MALFORMED_RESPONSE_CODE,
  toClientError,
} from '../../clientError.js';
import type { Pipeline } from '../../pipeline/pipeline.js';
import { CustomRequestBuilder } from '../../request/customRequestBuilder.js';

/** 错误响应体写入异常消息时的截断长度；完整内容留在 responseBody。 */
const ERROR_BODY_PREVIEW_CHARS = 2000;

/** 一次流式推理调用：相对路径由端点阀补全为 baseUrl 下的完整 URL。 */
export interface InferenceSseCall {
  readonly operation: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * 三个开源协议共用的发送流程：JSON 请求体经出站管线发出，非 2xx 抛
 * ClientError，SSE 帧逐个解析为协议事件，遇 [DONE] 结束。发送与读流中的
 * 运行时失败统一收为 ClientError。
 */
export async function* streamInferenceSse<T>(
  pipeline: Pipeline,
  call: InferenceSseCall,
): AsyncGenerator<T> {
  try {
    yield* streamFrames<T>(pipeline, call);
  } catch (error) {
    throw toClientError(error, {
      operation: call.operation,
      signal: call.signal,
    });
  }
}

async function* streamFrames<T>(
  pipeline: Pipeline,
  call: InferenceSseCall,
): AsyncGenerator<T> {
  const { operation, signal } = call;
  signal?.throwIfAborted();
  const request = CustomRequestBuilder.builder()
    .post(call.path)
    .headers({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...call.headers,
    })
    .body(JSON.stringify(call.body))
    .signal(signal)
    .stream()
    .build();
  const raw = (await pipeline.execute(request)).raw;
  if (!raw) {
    throw new ClientError(`${operation}: no response`, { operation });
  }
  if (!raw.ok) {
    const text = await raw.text().catch(() => '');
    const preview = text.slice(0, ERROR_BODY_PREVIEW_CHARS);
    throw new ClientError(
      `${operation}: HTTP ${raw.status}${preview ? `: ${preview}` : ''}`,
      { operation, statusCode: raw.status, responseBody: text },
    );
  }
  for await (const frame of streamSSE(raw, signal)) {
    if (isSseDone(frame.data)) return;
    if (frame.data === '') continue;
    let event: T;
    try {
      event = JSON.parse(frame.data) as T;
    } catch (cause) {
      throw new ClientError(`${operation}: invalid SSE event`, {
        code: MALFORMED_RESPONSE_CODE,
        operation,
        statusCode: raw.status,
        cause,
      });
    }
    yield event;
  }
}
