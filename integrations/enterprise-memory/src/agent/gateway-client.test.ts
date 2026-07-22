/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { GatewayClient } from './gateway-client.js';

const baseOptions = {
  brokerUrl: 'https://broker.example.test',
  gatewayUrl: 'https://gateway.example.test',
  certificatePath: '/not-read-for-invalid-limits',
  privateKeyPath: '/not-read-for-invalid-limits',
  caPath: '/not-read-for-invalid-limits',
};

describe('GatewayClient', () => {
  it.each([
    { responseLimitBytes: Number.NaN },
    { responseLimitBytes: 1024 * 1024 + 1 },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 60_001 },
  ])(
    'rejects unsafe transport limits before reading credentials: %o',
    (override) => {
      expect(() => new GatewayClient({ ...baseOptions, ...override })).toThrow(
        'limits are invalid',
      );
    },
  );

  it('reuses the exact capability when retrying the gateway request', async () => {
    const client = new TestGatewayClient();

    await expect(
      client.post(
        '/v1/runtime/search',
        { query: 'retry' },
        crypto.randomUUID(),
      ),
    ).resolves.toEqual({ memories: [] });

    expect(client.gatewayAuthorizations).toEqual([
      'Bearer capability-1',
      'Bearer capability-1',
    ]);
    expect(client.capabilityCount).toBe(1);
  });
});

class TestGatewayClient extends GatewayClient {
  capabilityCount = 0;
  private gatewayCount = 0;
  readonly gatewayAuthorizations: string[] = [];

  constructor() {
    super({
      brokerUrl: 'https://broker.example.test',
      gatewayUrl: 'https://gateway.example.test',
      certificatePath: '/dev/null',
      privateKeyPath: '/dev/null',
      caPath: '/dev/null',
    });
  }

  protected override async requestJson<T>(
    url: URL,
    input: {
      method: string;
      body: Buffer;
      headers: Record<string, string>;
    },
  ): Promise<T> {
    if (url.hostname === 'broker.example.test') {
      this.capabilityCount += 1;
      return { token: `capability-${this.capabilityCount}` } as T;
    }
    this.gatewayAuthorizations.push(input.headers['authorization'] ?? '');
    this.gatewayCount += 1;
    if (this.gatewayCount === 1) {
      throw Object.assign(new Error('connection reset'), {
        code: 'ECONNRESET',
      });
    }
    return { memories: [] } as T;
  }
}
