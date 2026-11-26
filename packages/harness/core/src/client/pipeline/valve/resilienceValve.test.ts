/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ClientError } from '../../clientError.js';
import {
  CustomRequest,
  type CreateCustomRequestOptions,
} from '../../request/customRequest.js';
import { CustomResponse } from '../../response/customResponse.js';
import { ResilienceValve, type StreamTimeouts } from './resilienceValve.js';
import { BaseValve } from './valve.js';

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const PIPELINE_BUDGET: StreamTimeouts = {
  firstPayloadTimeoutMs: 3_600_000,
  bodyIdleTimeoutMs: 900_000,
};

/** Records how often the settled contract reaches the send stage. */
class TerminalValve extends BaseValve {
  calls = 0;

  invoke(): Promise<void> {
    this.calls++;
    return Promise.resolve();
  }
}

function declaration(
  overrides: Partial<CreateCustomRequestOptions> = {},
): CustomRequest {
  return new CustomRequest({
    url: 'https://api.example.test/v1/chat',
    method: 'POST',
    headers: {},
    streamResponse: false,
    ...overrides,
  });
}

async function run(
  request: CustomRequest,
  streamTimeouts?: StreamTimeouts,
): Promise<{
  response: CustomResponse;
  terminal: TerminalValve;
}> {
  const valve = new ResilienceValve(streamTimeouts);
  const terminal = new TerminalValve();
  valve.setNext(terminal);
  const response = CustomResponse.initial();
  await valve.invoke(request, response);
  return { response, terminal };
}

describe('ResilienceValve', () => {
  it('settles the SSE preset for a declared stream', async () => {
    const request = declaration({ streamResponse: true });

    const { response } = await run(request);

    expect(request.idempotent).toBe(false);
    expect(request.maxAttempts).toBe(1);
    expect(request.connectTimeoutMs).toBe(3_000);
    expect(request.firstPayloadTimeoutMs).toBe(60_000);
    // SSE 预设不设响应头与 body idle 预算，结算不应凭空补值。
    expect(request.responseHeadersTimeoutMs).toBeUndefined();
    expect(request.bodyIdleTimeoutMs).toBeUndefined();
    expect(request.bodyReplayable).toBe(true);
    expect(response.streamResponse).toBe(true);
    expect(response.firstPayloadTimeoutMs).toBe(60_000);
    expect(response.bodyIdleTimeoutMs).toBeUndefined();
  });

  it('settles a stream from the pipeline budget, with headers following first payload', async () => {
    const request = declaration({ streamResponse: true });

    const { response } = await run(request, PIPELINE_BUDGET);

    expect(request.firstPayloadTimeoutMs).toBe(3_600_000);
    // 响应头期限不得早于首包预算，否则首包预算永远等不到。
    expect(request.responseHeadersTimeoutMs).toBe(3_600_000);
    expect(request.bodyIdleTimeoutMs).toBe(900_000);
    expect(response.firstPayloadTimeoutMs).toBe(3_600_000);
    expect(response.bodyIdleTimeoutMs).toBe(900_000);
  });

  it('lets a stream declaration override the pipeline budget', async () => {
    const request = declaration({
      streamResponse: true,
      firstPayloadTimeoutMs: 20_000,
      responseHeadersTimeoutMs: 5_000,
      bodyIdleTimeoutMs: 4_000,
    });

    await run(request, PIPELINE_BUDGET);

    expect(request.firstPayloadTimeoutMs).toBe(20_000);
    expect(request.responseHeadersTimeoutMs).toBe(5_000);
    expect(request.bodyIdleTimeoutMs).toBe(4_000);
  });

  it('derives stream headers from the declared first payload under a pipeline budget', async () => {
    const request = declaration({
      streamResponse: true,
      firstPayloadTimeoutMs: 20_000,
    });

    await run(request, { firstPayloadTimeoutMs: 3_600_000 });

    expect(request.responseHeadersTimeoutMs).toBe(20_000);
  });

  it('keeps the pipeline stream budget away from finite responses', async () => {
    const request = declaration({ method: 'POST' });

    await run(request, PIPELINE_BUDGET);

    expect(request.responseHeadersTimeoutMs).toBe(300_000);
    expect(request.bodyIdleTimeoutMs).toBe(60_000);
    expect(request.firstPayloadTimeoutMs).toBeUndefined();
  });

  it('applies pipeline stream defaults and lets request fields win', async () => {
    const inherited = declaration({ streamResponse: true });
    const { response: inheritedResponse } = await run(inherited, {
      firstPayloadTimeoutMs: 120_000,
      bodyIdleTimeoutMs: 300_000,
      resetTimeoutOnStreamActivity: true,
    });
    expect(inherited.firstPayloadTimeoutMs).toBe(120_000);
    expect(inherited.bodyIdleTimeoutMs).toBe(300_000);
    expect(inherited.resetTimeoutOnStreamActivity).toBe(true);
    expect(inheritedResponse.bodyIdleTimeoutMs).toBe(300_000);

    const overridden = declaration({
      streamResponse: true,
      firstPayloadTimeoutMs: 5_000,
      bodyIdleTimeoutMs: 1_000,
      resetTimeoutOnStreamActivity: false,
    });
    await run(overridden, {
      firstPayloadTimeoutMs: 120_000,
      bodyIdleTimeoutMs: 300_000,
      resetTimeoutOnStreamActivity: true,
    });
    expect(overridden.firstPayloadTimeoutMs).toBe(5_000);
    expect(overridden.bodyIdleTimeoutMs).toBe(1_000);
    expect(overridden.resetTimeoutOnStreamActivity).toBe(false);
  });

  it('treats a GET read as idempotent under the safe-read preset', async () => {
    const request = declaration({ method: 'GET' });

    await run(request);

    expect(request.idempotent).toBe(true);
    expect(request.maxAttempts).toBe(3);
    expect(request.connectTimeoutMs).toBe(3_000);
    expect(request.responseHeadersTimeoutMs).toBe(30_000);
    expect(request.bodyIdleTimeoutMs).toBe(30_000);
    expect(request.firstPayloadTimeoutMs).toBeUndefined();
    expect(request.resetTimeoutOnStreamActivity).toBe(false);
  });

  it('keeps a write non-idempotent under the unary preset', async () => {
    const request = declaration({ method: 'POST' });

    await run(request);

    expect(request.idempotent).toBe(false);
    expect(request.responseHeadersTimeoutMs).toBe(300_000);
  });

  it('lets every declaration override its preset', async () => {
    const request = declaration({
      method: 'GET',
      idempotent: false,
      maxAttempts: 5,
      connectTimeoutMs: 7_000,
      responseHeadersTimeoutMs: 9_000,
      bodyIdleTimeoutMs: 4_000,
      firstPayloadTimeoutMs: 11_000,
      resetTimeoutOnStreamActivity: true,
    });

    await run(request);

    expect(request.idempotent).toBe(false);
    expect(request.maxAttempts).toBe(5);
    expect(request.connectTimeoutMs).toBe(7_000);
    expect(request.responseHeadersTimeoutMs).toBe(9_000);
    expect(request.bodyIdleTimeoutMs).toBe(4_000);
    expect(request.firstPayloadTimeoutMs).toBe(11_000);
    expect(request.resetTimeoutOnStreamActivity).toBe(true);
  });

  it('accepts a legacy request timeout as the header budget', async () => {
    const request = declaration({ method: 'GET', requestTimeoutMs: 1_234 });

    await run(request);

    // 声明值优先，不再补成 300s 的预设值。
    expect(request.responseHeadersTimeoutMs).toBe(1_234);
  });

  it('never settles a header budget below its connect budget', async () => {
    const request = declaration({ method: 'GET', connectTimeoutMs: 400_000 });

    await run(request);

    expect(request.responseHeadersTimeoutMs).toBe(400_000);
  });

  it('downgrades an unreplayable body to a single attempt', async () => {
    const request = declaration({
      method: 'POST',
      maxAttempts: 5,
      body: new ReadableStream<Uint8Array>(),
    });

    await run(request);

    expect(request.bodyReplayable).toBe(false);
    expect(request.maxAttempts).toBe(1);
  });

  it('caps a stream to a single attempt even when more are declared', async () => {
    const request = declaration({
      method: 'POST',
      streamResponse: true,
      maxAttempts: 5,
      body: JSON.stringify({ prompt: 'hi' }),
    });

    await run(request);

    expect(request.bodyReplayable).toBe(true);
    expect(request.maxAttempts).toBe(1);
  });

  it('keeps the declared budget when the body can be replayed', async () => {
    const request = declaration({
      method: 'POST',
      maxAttempts: 5,
      body: JSON.stringify({ prompt: 'hi' }),
    });

    await run(request);

    expect(request.bodyReplayable).toBe(true);
    expect(request.maxAttempts).toBe(5);
  });

  it('mirrors the settled streaming budgets onto the response', async () => {
    const request = declaration({
      streamResponse: true,
      maxResponseBytes: 1_024,
      firstPayloadTimeoutMs: 2_000,
      bodyIdleTimeoutMs: 3_000,
      resetTimeoutOnStreamActivity: true,
    });

    const { response } = await run(request);

    expect(response.streamResponse).toBe(true);
    expect(response.maxBytes).toBe(1_024);
    expect(response.firstPayloadTimeoutMs).toBe(2_000);
    expect(response.bodyIdleTimeoutMs).toBe(3_000);
    expect(response.resetTimeoutOnStreamActivity).toBe(true);
  });

  it('keeps the default byte limit when none is declared', async () => {
    const { response } = await run(declaration());

    expect(response.maxBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it('rejects a non-positive-integer attempt budget', async () => {
    await expect(run(declaration({ maxAttempts: 0 }))).rejects.toThrow(
      'maxAttempts must be a positive integer',
    );
    await expect(run(declaration({ maxAttempts: 1.5 }))).rejects.toThrow(
      'maxAttempts must be a positive integer',
    );
  });

  it('rejects a missing or non-positive connect budget', async () => {
    const zero = run(declaration({ connectTimeoutMs: 0 }));

    await expect(zero).rejects.toBeInstanceOf(ClientError);
    await expect(zero).rejects.toThrow(
      'connectTimeoutMs must be a positive integer',
    );
    await expect(run(declaration({ connectTimeoutMs: 1.5 }))).rejects.toThrow(
      'connectTimeoutMs must be a positive integer',
    );
  });

  it('rejects a non-positive or fractional optional budget', async () => {
    await expect(run(declaration({ firstPayloadTimeoutMs: 0 }))).rejects.toThrow(
      'firstPayloadTimeoutMs must be a positive integer',
    );
    await expect(run(declaration({ bodyIdleTimeoutMs: -1 }))).rejects.toThrow(
      'bodyIdleTimeoutMs must be a positive integer',
    );
    await expect(run(declaration({ bodyIdleTimeoutMs: 1_500.5 }))).rejects.toThrow(
      'bodyIdleTimeoutMs must be a positive integer',
    );
  });

  it('settles once and passes control to the next valve once', async () => {
    const request = declaration({ maxAttempts: 3 });

    const { terminal } = await run(request);

    expect(terminal.calls).toBe(1);
    // 结算发生在上游，尝试预算不会再被本阀改写。
    expect(request.maxAttempts).toBe(3);
  });
});
