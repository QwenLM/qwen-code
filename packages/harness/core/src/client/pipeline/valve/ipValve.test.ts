/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { ClientError, NETWORK_FAILURE_CODE } from '../../clientError.js';
import { INFERENCE } from '../../endpoint/endpoint.js';
import type { IpResolver, IpSource, ResolvedIp } from '../../ip/ipResolver.js';
import {
  CustomRequest,
  type CreateCustomRequestOptions,
} from '../../request/customRequest.js';
import { CustomResponse } from '../../response/customResponse.js';
import { IpValve } from './ipValve.js';
import { BaseValve } from './valve.js';
import { runLogger } from '../../../utils/runLogger.js';

const SOURCE = 'http-dns' as IpSource;
const warnSpy = vi.spyOn(runLogger, 'warn');

class CaptureValve extends BaseValve {
  received?: CustomRequest;
  seenIp?: string;

  async invoke(request: CustomRequest, output: CustomResponse): Promise<void> {
    this.received = request;
    this.seenIp = request.ip;
    output.raw = new Response('ok');
  }
}

class ThrowingValve extends BaseValve {
  constructor(private readonly error: unknown) {
    super();
  }

  async invoke(): Promise<void> {
    throw this.error;
  }
}

function phaseError(phase: string): Error {
  return Object.assign(new Error(`wire down: ${phase}`), { phase });
}

function createRequest(
  options: Partial<CreateCustomRequestOptions> = {},
): CustomRequest {
  return new CustomRequest({
    operation: 'op',
    endpointType: INFERENCE,
    method: 'GET',
    origin: 'https://api.example.com',
    path: '/p',
    headers: {},
    streamResponse: false,
    idempotent: true,
    ...options,
  });
}

function resolverReturning(
  result: ResolvedIp | undefined,
): IpResolver & { resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn().mockResolvedValue(result) };
}

function wire(valve: IpValve): CaptureValve {
  const next = new CaptureValve();
  valve.setNext(next);
  return next;
}

describe('IpValve', () => {
  it('未预设 IP 时解析一个并写入请求', async () => {
    const report = vi.fn();
    const resolver = resolverReturning({
      ip: '203.0.113.5',
      source: SOURCE,
      report,
    });
    const valve = new IpValve(resolver);
    const next = wire(valve);
    const request = createRequest();

    await valve.invoke(request, CustomResponse.initial());

    expect(resolver.resolve).toHaveBeenCalledExactlyOnceWith(
      'https://api.example.com',
    );
    expect(next.seenIp).toBe('203.0.113.5');
    expect(report).toHaveBeenCalledWith({ outcome: 'success' });
    expect(request.ip).toBeUndefined();
  });

  it('尝试结束后复原 IP，重入时重新解析', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        ip: '203.0.113.5',
        source: SOURCE,
        report: vi.fn(),
      })
      .mockResolvedValueOnce({
        ip: '203.0.113.6',
        source: SOURCE,
        report: vi.fn(),
      });
    const valve = new IpValve({ resolve });
    const next = wire(valve);
    const request = createRequest();

    await valve.invoke(request, CustomResponse.initial());
    expect(next.seenIp).toBe('203.0.113.5');
    expect(request.ip).toBeUndefined();

    await valve.invoke(request, CustomResponse.initial());

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(next.seenIp).toBe('203.0.113.6');
    expect(request.ip).toBeUndefined();
  });

  it('已预设 IP 时不再解析，也不复原该地址', async () => {
    const resolver = resolverReturning(undefined);
    const valve = new IpValve(resolver);
    const next = wire(valve);
    const request = createRequest({ ip: '198.51.100.7' });

    await valve.invoke(request, CustomResponse.initial());

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(next.seenIp).toBe('198.51.100.7');
    expect(request.ip).toBe('198.51.100.7');
  });

  it('解析无结果时以域名发送', async () => {
    const valve = new IpValve(resolverReturning(undefined));
    const next = wire(valve);

    await valve.invoke(createRequest(), CustomResponse.initial());

    expect(next.seenIp).toBeUndefined();
  });

  it('解析失败时只记日志，仍以域名发送', async () => {
    warnSpy.mockClear();
    const error = new Error('dns down');
    const resolver: IpResolver = { resolve: vi.fn().mockRejectedValue(error) };
    const valve = new IpValve(resolver);
    const next = wire(valve);

    await valve.invoke(createRequest(), CustomResponse.initial());

    expect(next.received).toBeDefined();
    expect(next.seenIp).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      '[ip] resolve failed; sending by hostname',
      { origin: 'https://api.example.com', error_type: 'Error' },
    );
  });

  it('连接阶段失败时向解析结果回投 failure', async () => {
    const report = vi.fn();
    const valve = new IpValve(
      resolverReturning({ ip: '203.0.113.5', source: SOURCE, report }),
    );
    valve.setNext(new ThrowingValve(phaseError('connect')));
    const request = createRequest();

    await expect(
      valve.invoke(request, CustomResponse.initial()),
    ).rejects.toThrow('wire down: connect');

    expect(report).toHaveBeenCalledExactlyOnceWith({ outcome: 'failure' });
    expect(request.ip).toBeUndefined();
  });

  it('收到服务端响应时回投 success 以清掉失败计数', async () => {
    const report = vi.fn();
    const valve = new IpValve(
      resolverReturning({ ip: '203.0.113.5', source: SOURCE, report }),
    );
    valve.setNext(
      new ThrowingValve(
        Object.assign(new Error('HTTP 429'), { statusCode: 429 }),
      ),
    );

    await expect(
      valve.invoke(createRequest(), CustomResponse.initial()),
    ).rejects.toThrow('HTTP 429');

    expect(report).toHaveBeenCalledExactlyOnceWith({ outcome: 'success' });
  });

  it('请求取消时回投 success', async () => {
    const report = vi.fn();
    const valve = new IpValve(
      resolverReturning({ ip: '203.0.113.5', source: SOURCE, report }),
    );
    const controller = new AbortController();
    controller.abort();
    valve.setNext(new ThrowingValve(new Error('aborted')));

    await expect(
      valve.invoke(
        createRequest({ signal: controller.signal }),
        CustomResponse.initial(),
      ),
    ).rejects.toThrow('aborted');

    expect(report).toHaveBeenCalledExactlyOnceWith({ outcome: 'success' });
  });

  it('首包超时以 abort 表达时回投 failure', async () => {
    const report = vi.fn();
    const valve = new IpValve(
      resolverReturning({ ip: '203.0.113.5', source: SOURCE, report }),
    );
    const controller = new AbortController();
    const timeout = new ClientError(
      'inference.custom.stream: first payload timeout',
      { code: NETWORK_FAILURE_CODE },
    );
    controller.abort(timeout);
    valve.setNext(new ThrowingValve(timeout));

    await expect(
      valve.invoke(
        createRequest({ signal: controller.signal }),
        CustomResponse.initial(),
      ),
    ).rejects.toThrow('first payload timeout');

    expect(report).toHaveBeenCalledExactlyOnceWith({ outcome: 'failure' });
  });

  it('超时也向解析结果回投 failure', async () => {
    const report = vi.fn();
    const valve = new IpValve(
      resolverReturning({ ip: '203.0.113.5', source: SOURCE, report }),
    );
    valve.setNext(new ThrowingValve(phaseError('timeout')));

    await expect(
      valve.invoke(createRequest(), CustomResponse.initial()),
    ).rejects.toThrow('wire down: timeout');

    expect(report).toHaveBeenCalledExactlyOnceWith({ outcome: 'failure' });
  });

  it('origin 缺失时不解析，以域名发送', async () => {
    const resolver = resolverReturning({
      ip: '203.0.113.5',
      source: SOURCE,
      report: vi.fn(),
    });
    const valve = new IpValve(resolver);
    const next = wire(valve);

    await valve.invoke(
      createRequest({ origin: undefined }),
      CustomResponse.initial(),
    );

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(next.seenIp).toBeUndefined();
  });
});
