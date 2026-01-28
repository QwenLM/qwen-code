/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { buildRuntimeFetchOptions } from './runtimeFetchOptions.js';

type UndiciOptions = Record<string, unknown>;

vi.mock('undici', () => {
  class MockAgent {
    options: UndiciOptions;
    constructor(options: UndiciOptions) {
      this.options = options;
    }
  }

  class MockProxyAgent {
    options: UndiciOptions;
    constructor(options: UndiciOptions) {
      this.options = options;
    }
  }

  return {
    Agent: MockAgent,
    ProxyAgent: MockProxyAgent,
  };
});

describe('buildRuntimeFetchOptions (node runtime)', () => {
  it('disables undici timeouts for Agent in OpenAI options', () => {
    const result = buildRuntimeFetchOptions('openai');

    expect(result).toBeDefined();
    expect(result && 'dispatcher' in result).toBe(true);

    const dispatcher = (result as { dispatcher?: { options?: UndiciOptions } })
      .dispatcher;
    expect(dispatcher?.options).toMatchObject({
      headersTimeout: 0,
      bodyTimeout: 0,
    });
  });

  it('uses ProxyAgent with disabled timeouts when proxy is set', () => {
    const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');

    expect(result).toBeDefined();
    expect(result && 'dispatcher' in result).toBe(true);

    const dispatcher = (result as { dispatcher?: { options?: UndiciOptions } })
      .dispatcher;
    expect(dispatcher?.options).toMatchObject({
      uri: 'http://proxy.local',
      headersTimeout: 0,
      bodyTimeout: 0,
    });
  });

  it('returns httpAgent with disabled timeouts for Anthropic options', () => {
    const result = buildRuntimeFetchOptions('anthropic');

    expect(result).toBeDefined();
    expect(result && 'httpAgent' in result).toBe(true);

    const httpAgent = (result as { httpAgent?: { options?: UndiciOptions } })
      .httpAgent;
    expect(httpAgent?.options).toMatchObject({
      headersTimeout: 0,
      bodyTimeout: 0,
    });
  });
});
