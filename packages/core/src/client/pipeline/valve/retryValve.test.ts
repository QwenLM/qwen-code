/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { CustomRequest } from '../../request/customRequest.js';
import { CustomResponse } from '../../response/customResponse.js';
import { RetryValve } from './retryValve.js';
import { BaseValve } from './valve.js';
import { ValveError } from './valveError.js';

/** One scripted transport outcome per send. */
type Outcome = { status: number } | { throws: unknown };

class ScriptedTransport extends BaseValve {
  readonly seenUrls: string[] = [];
  private index = 0;

  constructor(private readonly outcomes: readonly Outcome[]) {
    super();
  }

  get sendCount(): number {
    return this.index;
  }

  invoke(request: CustomRequest, response: CustomResponse): Promise<void> {
    const outcome =
      this.outcomes[Math.min(this.index, this.outcomes.length - 1)];
    this.index++;
    this.seenUrls.push(request.url);
    if ('throws' in outcome) return Promise.reject(outcome.throws);
    // `status` is derived from `raw`, so the raw response is the only writable
    // surface a transport has.
    response.raw = new Response(null, { status: outcome.status });
    return Promise.resolve();
  }
}

function settled(
  overrides: Partial<{
    idempotent: boolean;
    maxAttempts: number;
    bodyReplayable: boolean;
    method: string;
    signal: AbortSignal;
  }> = {},
): CustomRequest {
  const request = new CustomRequest({
    url: 'https://api.example.test/v1/chat',
    method: overrides.method ?? 'POST',
    headers: {},
    streamResponse: false,
    body: '{}',
    signal: overrides.signal,
  });
  // Mirrors what ResilienceValve writes back before the retry stage runs.
  request.idempotent = overrides.idempotent ?? false;
  request.maxAttempts = overrides.maxAttempts ?? 3;
  request.bodyReplayable = overrides.bodyReplayable ?? true;
  return request;
}

function netError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function run(
  request: CustomRequest,
  transport: ScriptedTransport,
): Promise<CustomResponse> {
  const valve = new RetryValve();
  valve.setNext(transport);
  const response = CustomResponse.initial();
  await valve.invoke(request, response);
  return response;
}

describe('RetryValve', () => {
  it('re-issues a 429 and returns the recovered response', async () => {
    const transport = new ScriptedTransport([
      { status: 429 },
      { status: 200 },
    ]);
    const response = await run(settled(), transport);
    expect(transport.sendCount).toBe(2);
    expect(response.status).toBe(200);
  });

  it('re-issues a 503 even for a non-idempotent request', async () => {
    const transport = new ScriptedTransport([
      { status: 503 },
      { status: 200 },
    ]);
    const response = await run(settled({ idempotent: false }), transport);
    expect(transport.sendCount).toBe(2);
    expect(response.status).toBe(200);
  });

  it('keeps every re-issue on the same URL', async () => {
    const transport = new ScriptedTransport([
      { status: 429 },
      { status: 429 },
      { status: 200 },
    ]);
    await run(settled(), transport);
    expect(new Set(transport.seenUrls).size).toBe(1);
    expect(transport.seenUrls).toHaveLength(3);
  });

  it('stops at maxAttempts and surfaces the last status', async () => {
    const transport = new ScriptedTransport([{ status: 429 }]);
    const response = await run(settled({ maxAttempts: 3 }), transport);
    expect(transport.sendCount).toBe(3);
    expect(response.status).toBe(429);
  });

  it('surfaces a 400 without re-issuing', async () => {
    const transport = new ScriptedTransport([{ status: 400 }]);
    const response = await run(settled(), transport);
    expect(transport.sendCount).toBe(1);
    expect(response.status).toBe(400);
  });

  it('withholds an undecided 500 from a non-idempotent request', async () => {
    const transport = new ScriptedTransport([{ status: 500 }]);
    const response = await run(settled({ idempotent: false }), transport);
    expect(transport.sendCount).toBe(1);
    expect(response.status).toBe(500);
  });

  it('re-issues an undecided 500 for an idempotent request', async () => {
    const transport = new ScriptedTransport([
      { status: 500 },
      { status: 200 },
    ]);
    const response = await run(
      settled({ idempotent: true, method: 'GET' }),
      transport,
    );
    expect(transport.sendCount).toBe(2);
    expect(response.status).toBe(200);
  });

  it('re-issues a connect failure that never reached the peer', async () => {
    const transport = new ScriptedTransport([
      { throws: netError('ECONNREFUSED') },
      { status: 200 },
    ]);
    const response = await run(settled({ idempotent: false }), transport);
    expect(transport.sendCount).toBe(2);
    expect(response.status).toBe(200);
  });

  it('surfaces a mid-flight reset for a non-idempotent request', async () => {
    const error = netError('ECONNRESET');
    const transport = new ScriptedTransport([{ throws: error }]);
    await expect(run(settled({ idempotent: false }), transport)).rejects.toBe(
      error,
    );
    expect(transport.sendCount).toBe(1);
  });

  it('re-issues a mid-flight reset for an idempotent request', async () => {
    const transport = new ScriptedTransport([
      { throws: netError('ECONNRESET') },
      { status: 200 },
    ]);
    const response = await run(
      settled({ idempotent: true, method: 'GET' }),
      transport,
    );
    expect(transport.sendCount).toBe(2);
    expect(response.status).toBe(200);
  });

  it('refuses to re-issue when the body cannot be replayed', async () => {
    const transport = new ScriptedTransport([{ status: 429 }]);
    const response = await run(settled({ bodyReplayable: false }), transport);
    expect(transport.sendCount).toBe(1);
    expect(response.status).toBe(429);
  });

  it('honours a single-attempt budget', async () => {
    const transport = new ScriptedTransport([{ status: 429 }]);
    const response = await run(settled({ maxAttempts: 1 }), transport);
    expect(transport.sendCount).toBe(1);
    expect(response.status).toBe(429);
  });

  it('does not spend the logical budget on pre-request failures', async () => {
    // Four connect failures exceed a budget of 3 logical attempts, yet none of
    // them reached the peer, so the send after them must still happen.
    const transport = new ScriptedTransport([
      { throws: netError('ECONNREFUSED') },
      { throws: netError('ECONNREFUSED') },
      { throws: netError('ECONNREFUSED') },
      { throws: netError('ECONNREFUSED') },
      { status: 200 },
    ]);
    const response = await run(settled({ maxAttempts: 3 }), transport);
    expect(transport.sendCount).toBe(5);
    expect(response.status).toBe(200);
  });

  it('stops immediately once the caller aborts', async () => {
    const controller = new AbortController();
    const request = settled({ signal: controller.signal });
    const transport = new ScriptedTransport([
      { throws: netError('ECONNREFUSED') },
    ]);
    const valve = new RetryValve();
    valve.setNext(
      new (class extends BaseValve {
        invoke(
          input: CustomRequest,
          output: CustomResponse,
        ): Promise<void> {
          controller.abort();
          return transport.invoke(input, output);
        }
      })(),
    );
    await expect(
      valve.invoke(request, CustomResponse.initial()),
    ).rejects.toThrow();
    expect(transport.sendCount).toBe(1);
  });

  it('rejects when the retry budget was never settled', async () => {
    // A request that never passed through ResilienceValve carries no budget.
    const request = new CustomRequest({
      url: 'https://api.example.test/v1/chat',
      method: 'POST',
      headers: {},
      streamResponse: false,
      body: '{}',
    });
    const transport = new ScriptedTransport([{ status: 200 }]);
    await expect(run(request, transport)).rejects.toBeInstanceOf(ValveError);
    expect(transport.sendCount).toBe(0);
  });

  it('restores the establishment budget it narrowed per send', async () => {
    const request = settled();
    request.establishmentTimeoutMs = 300_000;
    const transport = new ScriptedTransport([
      { status: 429 },
      { status: 200 },
    ]);
    await run(request, transport);
    expect(request.establishmentTimeoutMs).toBe(300_000);
  });
});
