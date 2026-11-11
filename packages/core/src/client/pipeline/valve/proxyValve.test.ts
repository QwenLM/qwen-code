/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ProxyInstance } from '../../proxy/proxyInstance.js';
import { CustomRequest } from '../../request/customRequest.js';
import { CustomResponse } from '../../response/customResponse.js';
import { ProxyValve } from './proxyValve.js';
import { BaseValve } from './valve.js';

class CapturingValve extends BaseValve {
  invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    void input;
    void output;
    return Promise.resolve();
  }
}

function routable(url?: string): CustomRequest {
  return new CustomRequest({
    url: url ?? '',
    method: 'GET',
    headers: {},
    streamResponse: false,
  });
}

describe('ProxyValve', () => {
  it('applies the proxy resolved for the input origin', async () => {
    const input = routable('https://api.example.test/v1');
    const proxyInstance = {
      resolve: () => 'http://proxy.test:8080',
      bypass: () => false,
      set: () => {},
    } as unknown as ProxyInstance;
    const valve = new ProxyValve(proxyInstance);
    valve.setNext(new CapturingValve());
    const output = CustomResponse.initial();

    await valve.invoke(input, output);
    expect(input.origin).toBe('https://api.example.test');
    expect(input.proxy).toBe('http://proxy.test:8080');
  });

  it('passes through an input without an origin', async () => {
    const input = routable('');
    const proxyInstance = {
      resolve: () => 'http://proxy.test:8080',
      bypass: () => false,
      set: () => {},
    } as unknown as ProxyInstance;
    const valve = new ProxyValve(proxyInstance);
    valve.setNext(new CapturingValve());
    const output = CustomResponse.initial();

    await valve.invoke(input, output);
    expect(input.origin).toBeUndefined();
    expect(input.proxy).toBeUndefined();
  });

  it('uses the origin only to evaluate bypass policy', async () => {
    const input = routable('https://direct.example.test/v1');
    let bypassOrigin: string | undefined;
    const proxyInstance = {
      resolve: () => 'http://proxy.test:8080',
      bypass: (origin: string) => {
        bypassOrigin = origin;
        return true;
      },
      set: () => {},
    } as unknown as ProxyInstance;
    const valve = new ProxyValve(proxyInstance);
    valve.setNext(new CapturingValve());

    await valve.invoke(input, CustomResponse.initial());
    expect(bypassOrigin).toBe('https://direct.example.test');
    expect(input.proxy).toBeUndefined();
  });
});
