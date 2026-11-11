/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../test-utils/mock-undici-fetch-with-global.js';
import {
  createMcpTransportFetch,
  createTransportRequestInit,
  registerMcpTransportFetchDecorator,
  registerReservedMcpHeader,
} from '../mcp/connector/transport/support.js';
import type { MCPServerConfig } from '../mcp/mcpServerConfig.js';

describe('MCP transport fetch decorators', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function captureHeaders(): Headers {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit | undefined;
    return new Headers(init?.headers);
  }

  it('applies registered decorators to every transport fetch', async () => {
    const dispose = registerMcpTransportFetchDecorator(
      (inner) => (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('X-Decorated', 'yes');
        return inner(url, { ...init, headers });
      },
    );
    try {
      const transportFetch = createMcpTransportFetch({
        command: 'server',
      } as MCPServerConfig);
      await transportFetch('https://example.test/mcp');
      expect(captureHeaders().get('X-Decorated')).toBe('yes');
    } finally {
      dispose();
    }
  });

  it('skips a decorator that throws instead of failing transport creation', async () => {
    const dispose = registerMcpTransportFetchDecorator(() => {
      throw new Error('boom');
    });
    try {
      const transportFetch = createMcpTransportFetch({
        command: 'server',
      } as MCPServerConfig);
      await transportFetch('https://example.test/mcp');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('strips product-declared reserved headers from connection-level config', () => {
    const dispose = registerReservedMcpHeader('X-Qwen-Model-Safety-Tag');
    try {
      const init = createTransportRequestInit(
        {
          command: 'server',
          headers: {
            'x-qwen-model-safety-tag': 'forged',
            'X-Other': 'keep',
          },
        } as MCPServerConfig,
        {},
        {
          allowedEnvironmentVariables: [],
          blockedEnvironmentVariables: [],
          enableEnvironmentVariableRedaction: false,
        },
      );
      const headers = new Headers(init.headers);
      expect(headers.get('X-Qwen-Model-Safety-Tag')).toBeNull();
      expect(headers.get('X-Other')).toBe('keep');
    } finally {
      dispose();
    }
  });
});
