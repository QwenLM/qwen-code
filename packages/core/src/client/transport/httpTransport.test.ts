/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomRequest } from '../request/customRequest.js';
import { CustomResponse } from '../response/customResponse.js';
import { HttpTransport } from './httpTransport.js';
import {
  bindModelRequestPhysicalObservation,
  registerModelRequestPhysicalObservation,
} from './modelRequestPhysicalObservation.js';
import { onModelRequestObservation } from '../../model-request/request-scope.js';
import type { ModelRequestObserver } from '../../model-request/types.js';

const fetches = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../utils/fetch.js', () => ({
  proxiedFetch: fetches.send,
  fetchWithResolvedIp: fetches.send,
  withFetchTimeouts: (init: RequestInit) => init,
}));

function request(
  options: Partial<ConstructorParameters<typeof CustomRequest>[0]> = {},
) {
  return new CustomRequest({
    url: 'https://example.test/resource',
    method: 'GET',
    headers: {},
    streamResponse: false,
    establishmentTimeoutMs: 10,
    connectTimeoutMs: 3_000,
    responseHeadersTimeoutMs: 30_000,
    ...options,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetches.send.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('HttpTransport establishment deadline', () => {
  it.each([{}, { ip: '203.0.113.1' }, { proxy: 'http://proxy.test' }])(
    '中止在途发送，不等待更长的连接/响应头超时：%j',
    async (route) => {
      fetches.send.mockImplementation(
        async (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener(
              'abort',
              () => reject(init.signal!.reason),
              { once: true },
            );
          }),
      );
      const pending = new HttpTransport()
        .invoke(request(route), CustomResponse.initial())
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toMatchObject({ name: 'TimeoutError' });
      expect(fetches.send).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('响应头已返回就释放 establishment 定时器，调用方仍可取消响应体', async () => {
    const caller = new AbortController();
    let signal: AbortSignal;
    fetches.send.mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Response('ok');
    });
    await new HttpTransport().invoke(
      request({ signal: caller.signal }),
      CustomResponse.initial(),
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(signal!.aborted).toBe(false);
    caller.abort(new Error('cancel body'));
    expect(signal!.reason).toBe(caller.signal.reason);
  });

  it('调用方取消原因原样保留，清理定时器', async () => {
    const caller = new AbortController();
    fetches.send.mockImplementation(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    );
    const pending = new HttpTransport()
      .invoke(request({ signal: caller.signal }), CustomResponse.initial())
      .catch((error: unknown) => error);
    const reason = new Error('caller cancelled');
    caller.abort(reason);
    expect(await pending).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('没有 establishment 时限时直接传递调用方信号，不新建定时器', async () => {
    fetches.send.mockResolvedValue(new Response('ok'));
    const caller = new AbortController();
    await new HttpTransport().invoke(
      request({ signal: caller.signal, establishmentTimeoutMs: undefined }),
      CustomResponse.initial(),
    );
    expect(fetches.send.mock.calls[0][1].signal).toBe(caller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('HttpTransport passive physical observations', () => {
  const identity = {
    sessionId: 'physical-session',
    requestSetId: 'physical-task',
    requestId: 'initial-request',
  };
  const actualIdentity = { ...identity, requestId: 'retry-request' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the initial scope and records every same-ID Client replay with actual duration', async () => {
    const observe = vi.fn<ModelRequestObserver>();
    const stop = onModelRequestObservation(identity, observe);
    const unregister = registerModelRequestPhysicalObservation(actualIdentity, {
      identity,
      model: 'test-model',
      attempt: 2,
    });
    const input = request({
      requestId: actualIdentity.requestId,
      establishmentTimeoutMs: undefined,
      headers: { Authorization: 'private-token' },
      body: 'private prompt body',
    });
    bindModelRequestPhysicalObservation(input, actualIdentity);
    // A bound send retains its fixed scope after Provider registration ends.
    unregister();
    fetches.send.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response('ok', { status: 200 });
    });
    try {
      const transport = new HttpTransport();
      for (let attempt = 1; attempt <= 2; attempt++) {
        const output = CustomResponse.initial();
        const pending = transport.invoke(input, output);
        await vi.advanceTimersByTimeAsync(15);
        await pending;
        expect(output.status).toBe(200);
      }
      expect(fetches.send).toHaveBeenCalledTimes(2);
      expect(observe.mock.calls.map(([record]) => record.data['stage'])).toEqual([
        'physical_send',
        'physical_response_headers',
        'physical_send',
        'physical_response_headers',
      ]);
      expect(
        observe.mock.calls.map(([record]) => record.data['attempt_index']),
      ).toEqual([1, 1, 2, 2]);
      for (const [record] of observe.mock.calls) {
        expect(record).toMatchObject({
          kind: 'physical',
          request_id: 'retry-request',
          initial_request_id: 'initial-request',
          model: 'test-model',
          attempt: 2,
        });
        if (record.data['stage'] === 'physical_response_headers') {
          expect(record.data).toMatchObject({
            duration_ms: 15,
            status_code: 200,
          });
        }
      }
      expect(JSON.stringify(observe.mock.calls)).not.toContain('private-token');
      expect(JSON.stringify(observe.mock.calls)).not.toContain(
        'private prompt',
      );
      expect(fetches.send.mock.calls[0][1]).toMatchObject({
        headers: { Authorization: 'private-token' },
        body: 'private prompt body',
      });
    } finally {
      stop();
      unregister();
    }
  });

  it('records send-error duration while preserving the original fetch rejection', async () => {
    const observe = vi.fn<ModelRequestObserver>();
    const stop = onModelRequestObservation(identity, observe);
    const unregister = registerModelRequestPhysicalObservation(actualIdentity, {
      identity,
      model: 'test-model',
    });
    const input = request({ establishmentTimeoutMs: undefined });
    bindModelRequestPhysicalObservation(input, actualIdentity);
    const original = Object.assign(new Error('socket failed'), {
      code: 'ECONNRESET',
    });
    fetches.send.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      throw original;
    });
    try {
      const pending = new HttpTransport().invoke(
        input,
        CustomResponse.initial(),
      );
      const rejected = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(12);
      expect(await rejected).toBe(original);
      expect(observe).toHaveBeenLastCalledWith(
        expect.objectContaining({
          request_id: 'retry-request',
          initial_request_id: 'initial-request',
          data: expect.objectContaining({
            stage: 'physical_send_error',
            duration_ms: 12,
            error_code: 'ECONNRESET',
          }),
        }),
      );
    } finally {
      stop();
      unregister();
    }
  });

  it.each(['sync-observer', 'async-observer', 'clock'] as const)(
    'preserves the response when the %s fails',
    async (failure) => {
      const observe: ModelRequestObserver =
        failure === 'async-observer'
          ? async () => {
              throw new Error('async observer failed');
            }
          : () => {
              if (failure === 'sync-observer')
                throw new Error('observer failed');
            };
      const stop = onModelRequestObservation(identity, observe);
      const unregister = registerModelRequestPhysicalObservation(
        actualIdentity,
        {
          identity,
          model: 'test-model',
        },
      );
      const input = request();
      bindModelRequestPhysicalObservation(input, actualIdentity);
      if (failure === 'clock') {
        vi.spyOn(performance, 'now').mockImplementation(() => {
          throw new Error('clock failed');
        });
      }
      const response = new Response('original response');
      fetches.send.mockResolvedValue(response);
      try {
        const output = CustomResponse.initial();
        await new HttpTransport().invoke(input, output);
        expect(output.raw).toBe(response);
        expect(fetches.send).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        stop();
        unregister();
      }
    },
  );

  it('does not read a diagnostic clock without a listener', async () => {
    const clock = vi.spyOn(performance, 'now');
    const response = new Response('ok');
    fetches.send.mockResolvedValue(response);
    const input = request();
    const unregister = registerModelRequestPhysicalObservation(actualIdentity, {
      identity,
      model: 'test-model',
    });
    bindModelRequestPhysicalObservation(input, actualIdentity);
    await new HttpTransport().invoke(input, CustomResponse.initial());
    unregister();
    expect(clock).not.toHaveBeenCalled();
  });
});
