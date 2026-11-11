/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SSE_BODY_PREVIEW_CHARS,
  streamSSE,
  type SseStreamDiagnosticEvent,
} from './sse-client.js';

const encoder = new TextEncoder();

describe('streamSSE', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not install an idle deadline by default', async () => {
    vi.useFakeTimers();
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const controller = new AbortController();
    const iterator = streamSSE(createPendingResponse(), controller.signal, {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const pending = iterator.next();

    await vi.advanceTimersByTimeAsync(300_000);

    expect(diagnostics.some((event) => event.phase === 'timeout')).toBe(false);
    const reason = new Error('caller cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(diagnostics.at(-1)).toMatchObject({ phase: 'cancel' });
  });

  it('times out between raw chunks when idle detection is active', async () => {
    vi.useFakeTimers();
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const iterator = streamSSE(
      createOneChunkThenPendingResponse('data: hello\n\n'),
      undefined,
      {
        idleTimeoutMs: 2_000,
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: { data: 'hello' },
      done: false,
    });

    const nextError = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_001);

    await expect(nextError).resolves.toMatchObject({
      name: 'ModelStreamIdleTimeoutError',
      message: 'Model stream idle timeout after 2s without data',
      phase: 'stream_idle',
      timeoutMs: 2_000,
    });
    expect(diagnostics.at(-1)).toMatchObject({
      phase: 'timeout',
      timeoutKind: 'body_idle',
      timeoutMs: 2_000,
    });
  });

  it('activates idle detection only after the transport reports first payload', async () => {
    vi.useFakeTimers();
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    let active = false;
    const iterator = streamSSE(
      createDelayedChunkThenPendingResponse('data: hello\n\n', 2_000),
      undefined,
      {
        idleTimeoutMs: 1_000,
        isIdleTimeoutActive: () => active,
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );
    const first = iterator.next();

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toMatchObject({
      value: { data: 'hello' },
      done: false,
    });
    expect(diagnostics.some((event) => event.phase === 'timeout')).toBe(false);

    active = true;
    const nextError = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(nextError).resolves.toMatchObject({
      phase: 'stream_idle',
      timeoutMs: 1_000,
    });
  });

  it('treats incomplete comments and heartbeats as raw-chunk activity', async () => {
    vi.useFakeTimers();
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const controller = new AbortController();
    const iterator = streamSSE(
      createEventThenTrickleResponse('data: hello\n\n', ': ping\n', 100),
      controller.signal,
      {
        idleTimeoutMs: 500,
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: { data: 'hello' },
      done: false,
    });
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(diagnostics.some((event) => event.phase === 'timeout')).toBe(false);
    const reason = new Error('test complete');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(diagnostics.at(-1)).toMatchObject({ phase: 'cancel' });
  });

  it('reports clean consumer return as cancellation instead of a stream error', async () => {
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const iterator = streamSSE(
      createOneChunkThenPendingResponse('data: hello\n\n'),
      undefined,
      { onDiagnostic: (event) => diagnostics.push(event) },
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: { data: 'hello' },
      done: false,
    });
    await iterator.return(undefined);

    expect(diagnostics.at(-1)).toMatchObject({
      phase: 'cancel',
      done: false,
    });
    expect(diagnostics.some((event) => event.phase === 'error')).toBe(false);
  });

  it('reports an external first-payload deadline using the supplied abort reason', async () => {
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const controller = new AbortController();
    const iterator = streamSSE(createPendingResponse(), controller.signal, {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const pending = iterator.next();
    const timeout = Object.assign(
      new Error('Model stream timed out before first payload after 1s'),
      {
        name: 'ModelFirstPayloadTimeoutError',
        phase: 'first_payload',
        timeoutMs: 1_000,
      },
    );

    controller.abort(timeout);

    await expect(pending).rejects.toBe(timeout);
    expect(diagnostics.at(-1)).toMatchObject({
      phase: 'timeout',
      timeoutKind: 'first_payload',
      timeoutMs: 1_000,
    });
  });

  it('rejects on abort when reader cancellation does not settle the pending read', async () => {
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const controller = new AbortController();
    const { response, cancel } = createNonCooperativeResponse();
    const iterator = streamSSE(response, controller.signal, {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const pending = iterator.next();
    const reason = Object.assign(new Error('hard first-payload deadline'), {
      name: 'ModelFirstPayloadTimeoutError',
      phase: 'first_payload',
      timeoutMs: 60_000,
    });

    await Promise.resolve();
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      phase: 'timeout',
      timeoutKind: 'first_payload',
      timeoutMs: 60_000,
    });
  });

  it('classifies fetch body-idle errors as body_idle', async () => {
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const iterator = streamSSE(
      createErroredResponse(
        new DOMException(
          'Response body idle timeout after 120000ms',
          'TimeoutError',
        ),
      ),
      undefined,
      {
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    await expect(iterator.next()).rejects.toThrow(
      'Model stream idle timeout after 120s without data',
    );
    expect(diagnostics.at(-1)).toMatchObject({
      phase: 'timeout',
      timeoutKind: 'body_idle',
      timeoutMs: 120_000,
    });
  });

  it('includes reader timeout cause fields in diagnostics', async () => {
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const cause = Object.assign(new Error('Body Timeout Error'), {
      name: 'BodyTimeoutError',
      code: 'UND_ERR_BODY_TIMEOUT',
    });
    const iterator = streamSSE(
      createErroredResponse(new TypeError('terminated', { cause })),
      undefined,
      {
        idleTimeoutMs: 120_000,
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    await expect(iterator.next()).rejects.toThrow(
      'Model stream idle timeout after 120s without data',
    );
    expect(diagnostics.at(-1)).toMatchObject({
      phase: 'timeout',
      timeoutKind: 'body_idle',
      errorName: 'TypeError',
      errorMessage: 'Model stream idle timeout after 120s without data',
      errorCauseName: 'BodyTimeoutError',
      errorCauseMessage: 'Body Timeout Error',
      errorCauseCode: 'UND_ERR_BODY_TIMEOUT',
    });
  });

  it('rejects an unfinished SSE line above the configured bound', async () => {
    const iterator = streamSSE(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: 123456789'));
            controller.close();
          },
        }),
      ),
      undefined,
      { maxLineBytes: 8 },
    );

    await expect(iterator.next()).rejects.toMatchObject({
      name: 'ProtocolLimitError',
      code: 'protocol_limit',
      phase: 'protocol',
      limitKind: 'sse_line',
      limitBytes: 8,
    });
  });

  it('rejects a multi-line SSE event above the configured bound', async () => {
    const iterator = streamSSE(
      new Response('data: 1234\ndata: 5678\n\n'),
      undefined,
      { maxEventBytes: 8 },
    );

    await expect(iterator.next()).rejects.toMatchObject({
      name: 'ProtocolLimitError',
      code: 'protocol_limit',
      phase: 'protocol',
      limitKind: 'sse_event',
      limitBytes: 8,
    });
  });

  it('measures SSE line limits in UTF-8 bytes across input chunks', async () => {
    const encoded = encoder.encode('data: 你');
    const iterator = streamSSE(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded.subarray(0, encoded.length - 1));
            controller.enqueue(encoded.subarray(encoded.length - 1));
            controller.close();
          },
        }),
      ),
      undefined,
      { maxLineBytes: 8 },
    );

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'protocol_limit',
      limitKind: 'sse_line',
      limitBytes: 8,
      actualBytes: 9,
    });
  });

  it('samples the raw body of a stream that produced no SSE event', async () => {
    const diagnostics: SseStreamDiagnosticEvent[] = [];
    const body = '{"code":401,"message":"unauthorized"}';
    const onEventlessBodyPreview = vi.fn();
    const events = await collect(
      streamSSE(new Response(body), undefined, {
        onDiagnostic: (event) => diagnostics.push(event),
        onEventlessBodyPreview,
      }),
    );

    expect(events).toEqual([]);
    expect(diagnostics.at(-1)).toMatchObject({
      phase: 'end',
      sseEventCount: 0,
    });
    expect(onEventlessBodyPreview).toHaveBeenCalledWith(body);
    expect(diagnostics.at(-1)).not.toHaveProperty('bodyPreview');
  });

  it('bounds the sampled raw body to a fixed preview size', async () => {
    const onEventlessBodyPreview = vi.fn();
    await collect(
      streamSSE(
        new Response('x'.repeat(DEFAULT_SSE_BODY_PREVIEW_CHARS + 500)),
        undefined,
        { onEventlessBodyPreview },
      ),
    );

    expect(onEventlessBodyPreview).toHaveBeenCalledWith(
      'x'.repeat(DEFAULT_SSE_BODY_PREVIEW_CHARS),
    );
  });

  it('never samples the body of a stream that produced an SSE event', async () => {
    const onEventlessBodyPreview = vi.fn();
    const events = await collect(
      streamSSE(new Response('data: secret model output\n\n'), undefined, {
        onEventlessBodyPreview,
      }),
    );

    expect(events).toEqual([{ data: 'secret model output' }]);
    expect(onEventlessBodyPreview).not.toHaveBeenCalled();
  });

  it('never samples an unterminated SSE data frame at clean EOF', async () => {
    const onEventlessBodyPreview = vi.fn();

    await collect(
      streamSSE(new Response('data: secret model output'), undefined, {
        onEventlessBodyPreview,
      }),
    );

    expect(onEventlessBodyPreview).not.toHaveBeenCalled();
  });

  it('never samples a partial SSE data frame when the stream is cancelled', async () => {
    const controller = new AbortController();
    const onEventlessBodyPreview = vi.fn();
    const iterator = streamSSE(
      createOneChunkThenPendingResponse('data: secret model output'),
      controller.signal,
      { onEventlessBodyPreview },
    );
    const pending = iterator.next();
    await Promise.resolve();

    const reason = new Error('caller cancelled');
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(onEventlessBodyPreview).not.toHaveBeenCalled();
  });

  it('never samples a partial SSE data frame when the reader fails', async () => {
    const onEventlessBodyPreview = vi.fn();
    let readCount = 0;
    const iterator = streamSSE(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (readCount++ === 0) {
              controller.enqueue(encoder.encode('data: secret model output'));
              return;
            }
            controller.error(new Error('upstream reset'));
          },
        }),
      ),
      undefined,
      { onEventlessBodyPreview },
    );

    await expect(iterator.next()).rejects.toThrow('upstream reset');
    expect(onEventlessBodyPreview).not.toHaveBeenCalled();
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

function createPendingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
    }),
  );
}

function createNonCooperativeResponse(): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const reader = {
    read: () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
    cancel,
  };
  return {
    response: {
      body: {
        getReader: () => reader,
      },
    } as unknown as Response,
    cancel,
  };
}

function createOneChunkThenPendingResponse(chunk: string): Response {
  let readCount = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount === 0) {
          readCount++;
          controller.enqueue(encoder.encode(chunk));
          return;
        }
        return new Promise<void>(() => {});
      },
    }),
  );
}

function createDelayedChunkThenPendingResponse(
  chunk: string,
  delayMs: number,
): Response {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        timeout = setTimeout(() => {
          controller.enqueue(encoder.encode(chunk));
        }, delayMs);
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        clearTimeout(timeout);
      },
    }),
  );
}

function createEventThenTrickleResponse(
  event: string,
  chunk: string,
  intervalMs: number,
): Response {
  let interval: ReturnType<typeof setInterval> | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(event));
        interval = setInterval(() => {
          controller.enqueue(encoder.encode(chunk));
        }, intervalMs);
      },
      cancel() {
        clearInterval(interval);
      },
    }),
  );
}

function createErroredResponse(error: Error): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    }),
  );
}
