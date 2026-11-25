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

/** What an error gate below throws when a send returns non-2xx. */
function statusError(statusCode: number): Error {
  return Object.assign(new Error(`op failed: HTTP ${statusCode}`), {
    statusCode,
  });
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
  it.each([undefined, 'CERT_HAS_EXPIRED'])(
    'does not replay a certificate rejection (code=%s)',
    async (code) => {
      const error = Object.assign(new Error('certificate has expired'), { code });
      const transport = new ScriptedTransport([{ throws: error }]);
      await expect(run(settled(), transport)).rejects.toBe(error);
      expect(transport.sendCount).toBe(1);
    },
  );

  it('re-issues a folded 429 and returns the recovered response', async () => {
    const transport = new ScriptedTransport([
      { throws: statusError(429) },
      { status: 200 },
    ]);
    const response = await run(settled(), transport);
    expect(transport.sendCount).toBe(2);
    expect(response.status).toBe(200);
  });

  it('keeps every re-issue on the same URL', async () => {
    const transport = new ScriptedTransport([
      { throws: statusError(429) },
      { throws: statusError(429) },
      { status: 200 },
    ]);
    await run(settled(), transport);
    expect(new Set(transport.seenUrls).size).toBe(1);
    expect(transport.seenUrls).toHaveLength(3);
  });

  it('stops at maxAttempts and surfaces the last failure', async () => {
    const error = statusError(429);
    const transport = new ScriptedTransport([{ throws: error }]);
    await expect(run(settled({ maxAttempts: 3 }), transport)).rejects.toBe(
      error,
    );
    expect(transport.sendCount).toBe(3);
  });

  it('re-issues a status an error gate folded into a thrown error', async () => {
    const transport = new ScriptedTransport([
      { throws: statusError(503) },
      { status: 200 },
    ]);
    const response = await run(settled({ idempotent: false }), transport);
    expect(transport.sendCount).toBe(2);
    expect(response.status).toBe(200);
  });

  it('surfaces a thrown 400 without re-issuing', async () => {
    const error = statusError(400);
    const transport = new ScriptedTransport([{ throws: error }]);
    await expect(run(settled(), transport)).rejects.toBe(error);
    expect(transport.sendCount).toBe(1);
  });

  it('withholds an undecided 500 from a non-idempotent request', async () => {
    const error = statusError(500);
    const transport = new ScriptedTransport([{ throws: error }]);
    await expect(run(settled({ idempotent: false }), transport)).rejects.toBe(
      error,
    );
    expect(transport.sendCount).toBe(1);
  });

  it('re-issues an undecided 500 for an idempotent request', async () => {
    const transport = new ScriptedTransport([
      { throws: statusError(500) },
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
    const error = statusError(429);
    const transport = new ScriptedTransport([{ throws: error }]);
    await expect(
      run(settled({ bodyReplayable: false }), transport),
    ).rejects.toBe(error);
    expect(transport.sendCount).toBe(1);
  });

  it('honours a single attempt', async () => {
    const error = statusError(429);
    const transport = new ScriptedTransport([{ throws: error }]);
    await expect(run(settled({ maxAttempts: 1 }), transport)).rejects.toBe(
      error,
    );
    expect(transport.sendCount).toBe(1);
  });

  it('counts pre-request failures against maxAttempts', async () => {
    // Connect failures never reach the peer, but each one is still a send, so
    // the loop stops at the declared count instead of retrying forever.
    const transport = new ScriptedTransport([
      { throws: netError('ECONNREFUSED') },
    ]);
    await expect(run(settled({ maxAttempts: 3 }), transport)).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(transport.sendCount).toBe(3);
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
        invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
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

  it('sends once without replay when maxAttempts was never settled', async () => {
    const request = new CustomRequest({
      url: 'https://api.example.test/v1/chat',
      method: 'POST',
      headers: {},
      streamResponse: false,
      body: '{}',
    });
    const error = statusError(429);
    const transport = new ScriptedTransport([
      { throws: error },
      { status: 200 },
    ]);
    await expect(run(request, transport)).rejects.toBe(error);
    expect(transport.sendCount).toBe(1);
  });
});
