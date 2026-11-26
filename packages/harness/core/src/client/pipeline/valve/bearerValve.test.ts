/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { BearerResolver } from '../../../auth/bearerResolver.js';
import { CustomRequest } from '../../request/customRequest.js';
import { CustomResponse } from '../../response/customResponse.js';
import { BearerValve } from './bearerValve.js';
import { BaseValve } from './valve.js';

class RespondingValve extends BaseValve {
  readonly seen: Array<string | null> = [];

  constructor(private readonly statuses: readonly number[]) {
    super();
  }

  async invoke(
    input: CustomRequest,
    output: CustomResponse,
  ): Promise<void> {
    this.seen.push(input.headers['Authorization'] ?? null);
    const status = this.statuses[Math.min(this.seen.length - 1, this.statuses.length - 1)];
    output.raw = new Response(null, { status });
  }
}

function request(): CustomRequest {
  return new CustomRequest({
    url: 'https://example.test/chat/completions',
    method: 'POST',
    headers: {},
    streamResponse: false,
  });
}

function chain(resolver: BearerResolver, statuses: readonly number[]) {
  const responder = new RespondingValve(statuses);
  const valve = new BearerValve(resolver);
  valve.setNext(responder);
  return { valve, responder };
}

describe('BearerValve', () => {
  it('prefers the asynchronous bearer read', async () => {
    const resolver: BearerResolver = {
      getBearer: () => 'sync-token',
      getBearerAsync: async () => 'rotating-token',
    };
    const { valve, responder } = chain(resolver, [200]);

    await valve.invoke(request(), CustomResponse.initial());

    expect(responder.seen).toEqual(['Bearer rotating-token']);
  });

  it('falls back to the synchronous bearer read', async () => {
    const { valve, responder } = chain({ getBearer: () => 'sync-token' }, [200]);

    await valve.invoke(request(), CustomResponse.initial());

    expect(responder.seen).toEqual(['Bearer sync-token']);
  });

  it('renews the credential once after HTTP 401', async () => {
    const refreshBearer = vi.fn(async () => 'fresh-token');
    const resolver: BearerResolver = {
      getBearer: () => undefined,
      getBearerAsync: async () => 'stale-token',
      refreshBearer,
    };
    const { valve, responder } = chain(resolver, [401, 200]);

    const output = CustomResponse.initial();
    await valve.invoke(request(), output);

    expect(refreshBearer).toHaveBeenCalledWith('stale-token');
    expect(responder.seen).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
    expect(output.raw?.status).toBe(200);
  });

  it('does not retry a second 401', async () => {
    const refreshBearer = vi.fn(async () => 'fresh-token');
    const { valve, responder } = chain(
      {
        getBearer: () => undefined,
        getBearerAsync: async () => 'stale-token',
        refreshBearer,
      },
      [401, 401],
    );

    const output = CustomResponse.initial();
    await valve.invoke(request(), output);

    expect(refreshBearer).toHaveBeenCalledTimes(1);
    expect(responder.seen).toHaveLength(2);
    expect(output.raw?.status).toBe(401);
  });

  it('leaves 401 untouched without a refresh hook', async () => {
    const { valve, responder } = chain(
      { getBearer: () => undefined, getBearerAsync: async () => 'stale-token' },
      [401],
    );

    const output = CustomResponse.initial();
    await valve.invoke(request(), output);

    expect(responder.seen).toHaveLength(1);
    expect(output.raw?.status).toBe(401);
  });
});
