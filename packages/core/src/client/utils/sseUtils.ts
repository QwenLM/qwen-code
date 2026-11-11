/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ClientError,
  MALFORMED_RESPONSE_CODE,
  NETWORK_FAILURE_CODE,
} from '../clientError.js';

/** SSE 首帧、帧间空闲及任意活动续期的超时声明。 */
export interface SseTimeouts {
  readonly firstPayloadTimeoutMs?: number;
  readonly bodyIdleTimeoutMs?: number;
  readonly resetTimeoutOnStreamActivity?: boolean;
}

import type { SseEvent } from '../../protocol/provider/sse-client.js';

export type { SseEvent } from '../../protocol/provider/sse-client.js';

export async function* streamSse(
  response: Response,
  operation: string,
  timeouts: SseTimeouts = {},
): AsyncGenerator<SseEvent> {
  if (!response.body) {
    throw new ClientError(`${operation}: missing response body`, {
      code: MALFORMED_RESPONSE_CODE,
      operation,
      statusCode: response.status,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventType: string | undefined;
  let eventId: string | undefined;
  let receivedEvent = false;
  let lastEventAt = performance.now();
  let lastActivityAt = lastEventAt;

  const emit = (): SseEvent | undefined => {
    if (
      dataLines.length === 0 &&
      eventType === undefined &&
      eventId === undefined
    ) {
      return undefined;
    }
    const frame: SseEvent = {
      data: dataLines.join('\n'),
      ...(eventType === undefined ? {} : { event: eventType }),
      ...(eventId === undefined ? {} : { id: eventId }),
    };
    dataLines = [];
    eventType = undefined;
    eventId = undefined;
    receivedEvent = true;
    lastEventAt = performance.now();
    return frame;
  };

  const acceptLine = (line: string): SseEvent | undefined => {
    if (line.length === 0) return emit();
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    } else if (line.startsWith('event:')) {
      eventType = line.slice(6).replace(/^ /, '');
    } else if (line.startsWith('id:')) {
      eventId = line.slice(3).replace(/^ /, '');
    }
    return undefined;
  };

  try {
    for (;;) {
      const timeoutMs = nextReadTimeoutMs(
        timeouts,
        receivedEvent,
        timeouts.resetTimeoutOnStreamActivity ? lastActivityAt : lastEventAt,
      );
      const { done, value } = await readWithTimeout(
        reader,
        timeoutMs,
        operation,
        response.status,
        receivedEvent ? 'stream idle timeout' : 'first payload timeout',
      );
      if (done) break;
      if (timeouts.resetTimeoutOnStreamActivity)
        lastActivityAt = performance.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const event = acceptLine(
          rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine,
        );
        if (event !== undefined) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const event = acceptLine(buffer.replace(/\r$/, ''));
      if (event !== undefined) yield event;
    }
    const trailingEvent = emit();
    if (trailingEvent !== undefined) yield trailingEvent;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function* streamJsonSse<T>(
  response: Response,
  operation: string,
  timeouts: SseTimeouts = {},
): AsyncGenerator<T> {
  for await (const frame of streamSse(response, operation, timeouts)) {
    try {
      yield JSON.parse(frame.data) as T;
    } catch (cause) {
      throw new ClientError(`${operation}: invalid SSE event`, {
        code: MALFORMED_RESPONSE_CODE,
        operation,
        statusCode: response.status,
        cause,
      });
    }
  }
}

function nextReadTimeoutMs(
  timeouts: SseTimeouts,
  receivedEvent: boolean,
  lastEventAt: number,
): number | undefined {
  const configuredMs = receivedEvent
    ? timeouts.bodyIdleTimeoutMs
    : timeouts.firstPayloadTimeoutMs;
  if (configuredMs === undefined) return undefined;
  return Math.max(
    1,
    Math.ceil(configuredMs - (performance.now() - lastEventAt)),
  );
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number | undefined,
  operation: string,
  status: number,
  timeoutKind: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (timeoutMs === undefined) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ClientError(`${operation}: ${timeoutKind}`, {
              code: NETWORK_FAILURE_CODE,
              operation,
              statusCode: status,
            }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
