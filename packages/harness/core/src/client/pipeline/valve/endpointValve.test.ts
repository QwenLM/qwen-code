/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { ClientError, NETWORK_FAILURE_CODE } from '../../clientError.js';
import type {
  EndpointResolver,
  ResolvedEndpoint,
} from '../../endpoint/endpointResolver.js';
import {
  INFERENCE,
  PUBLIC,
  type EndpointSource,
} from '../../endpoint/endpoint.js';
import { CustomRequest } from '../../request/customRequest.js';
import type { IpSource, ResolvedIp } from '../../ip/ipResolver.js';
import { CustomResponse } from '../../response/customResponse.js';
import { EndpointValve } from './endpointValve.js';
import { IpValveError } from './ipValve.js';
import { BaseValve } from './valve.js';
import { ValveError } from './valveError.js';

/** Terminal valve standing in for the rest of the chain. */
class NextValve extends BaseValve {
  constructor(
    private readonly run: (output: CustomResponse) => Promise<void> | void,
  ) {
    super();
  }

  async invoke(_input: CustomRequest, output: CustomResponse): Promise<void> {
    await this.run(output);
  }
}

function endpoint(
  report: (options: { outcome: 'success' | 'failure' }) => void = vi.fn(),
): ResolvedEndpoint {
  return {
    origin: 'https://elected.test',
    type: INFERENCE,
    scope: PUBLIC,
    source: 'elected' as EndpointSource,
    report,
  };
}

function resolverOf(resolved: ResolvedEndpoint | undefined) {
  const resolve = vi.fn(async () => resolved);
  const resolver: EndpointResolver = { resolve };
  return { resolver, resolve };
}

function request(
  options: { origin?: string; signal?: AbortSignal } = {},
): CustomRequest {
  return new CustomRequest({
    path: '/chat/completions',
    method: 'POST',
    headers: {},
    streamResponse: false,
    origin: options.origin,
    signal: options.signal,
  });
}

function chain(
  resolver: EndpointResolver,
  run: (output: CustomResponse) => Promise<void> | void,
): EndpointValve {
  const valve = new EndpointValve(resolver);
  valve.setNext(new NextValve(run));
  return valve;
}

describe('EndpointValve', () => {
  it('resolves a request without an origin and reports success', async () => {
    const report = vi.fn();
    const { resolver, resolve } = resolverOf(endpoint(report));
    const input = request();
    let seenOrigin: string | undefined;
    const valve = chain(resolver, (output) => {
      seenOrigin = input.origin;
      output.raw = new Response(null, { status: 200 });
    });

    await valve.invoke(input, CustomResponse.initial());

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(seenOrigin).toBe('https://elected.test');
    expect(input.origin).toBeUndefined();
    expect(report).toHaveBeenCalledWith({ outcome: 'success' });
  });

  it('restores the origin so an outer retry resolves again', async () => {
    const first = endpoint();
    const second: ResolvedEndpoint = {
      ...endpoint(),
      origin: 'https://next.test',
    };
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const valve = chain({ resolve }, (output) => {
      output.raw = new Response(null, { status: 200 });
    });
    const input = request();

    await valve.invoke(input, CustomResponse.initial());
    await valve.invoke(input, CustomResponse.initial());

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(input.origin).toBeUndefined();
  });

  it('keeps a pinned origin and casts no vote', async () => {
    const report = vi.fn();
    const { resolver, resolve } = resolverOf(endpoint(report));
    const valve = chain(resolver, () => {});

    await valve.invoke(
      request({ origin: 'https://pinned.test' }),
      CustomResponse.initial(),
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('fails hard when the endpoint cannot be resolved', async () => {
    const { resolver } = resolverOf(undefined);
    const valve = chain(resolver, () => {});

    await expect(
      valve.invoke(request(), CustomResponse.initial()),
    ).rejects.toThrow(ValveError);
  });

  it('reports an unreachable route as failure', async () => {
    const report = vi.fn();
    const valve = chain(resolverOf(endpoint(report)).resolver, () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
    });

    await expect(
      valve.invoke(request(), CustomResponse.initial()),
    ).rejects.toThrow('ECONNREFUSED');
    expect(report).toHaveBeenCalledWith({ outcome: 'failure' });
  });

  it('keeps the endpoint when a served status is thrown directly', async () => {
    const report = vi.fn();
    const valve = chain(resolverOf(endpoint(report)).resolver, () => {
      throw new ClientError('unavailable', { statusCode: 503 });
    });

    await expect(
      valve.invoke(request(), CustomResponse.initial()),
    ).rejects.toThrow(ClientError);
    expect(report).toHaveBeenCalledWith({ outcome: 'success' });
  });

  it('keeps the endpoint while the failure still has an IP to swap', async () => {
    const report = vi.fn();
    const resolvedIp: ResolvedIp = {
      ip: '203.0.113.5',
      source: 'http-dns' as IpSource,
      report: vi.fn(),
    };
    const wireError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const ipError = new IpValveError(wireError, { resolvedIp });
    const valve = chain(resolverOf(endpoint(report)).resolver, () => {
      throw ipError;
    });

    await expect(
      valve.invoke(request(), CustomResponse.initial()),
    ).rejects.toBe(wireError);
    expect(report).toHaveBeenCalledWith({ outcome: 'success' });
  });

  it('reports a failure without IP evidence as failure', async () => {
    const report = vi.fn();
    const wireError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const ipError = new IpValveError(wireError);
    const valve = chain(resolverOf(endpoint(report)).resolver, () => {
      throw ipError;
    });

    await expect(
      valve.invoke(request(), CustomResponse.initial()),
    ).rejects.toBe(wireError);
    expect(report).toHaveBeenCalledWith({ outcome: 'failure' });
  });

  it('keeps the endpoint when the failure carries a status code', async () => {
    const report = vi.fn();
    const clientError = new ClientError('too many requests', {
      statusCode: 429,
    });
    const ipError = new IpValveError(clientError);
    const valve = chain(resolverOf(endpoint(report)).resolver, () => {
      throw ipError;
    });

    await expect(
      valve.invoke(request(), CustomResponse.initial()),
    ).rejects.toBe(clientError);
    expect(report).toHaveBeenCalledWith({ outcome: 'success' });
  });

  it('reports a cancelled request as success', async () => {
    const report = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const valve = chain(resolverOf(endpoint(report)).resolver, () => {
      throw new Error('aborted');
    });

    await expect(
      valve.invoke(
        request({ signal: controller.signal }),
        CustomResponse.initial(),
      ),
    ).rejects.toThrow('aborted');
    expect(report).toHaveBeenCalledWith({ outcome: 'success' });
  });

  it('reports a first-payload timeout abort as failure', async () => {
    const report = vi.fn();
    const controller = new AbortController();
    const timeout = new ClientError('first payload timeout', {
      code: NETWORK_FAILURE_CODE,
    });
    controller.abort(timeout);
    const valve = chain(resolverOf(endpoint(report)).resolver, () => {
      throw timeout;
    });

    await expect(
      valve.invoke(
        request({ signal: controller.signal }),
        CustomResponse.initial(),
      ),
    ).rejects.toThrow('first payload timeout');
    expect(report).toHaveBeenCalledWith({ outcome: 'failure' });
  });
});
