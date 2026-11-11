/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../../mcpServerConfig.js';
import { registerReservedMcpHeader } from '../transport/support.js';
import { createSSETransportWithAuth } from './transport.js';

const mocks = vi.hoisted(() => ({
  options: undefined as undefined | { requestInit?: RequestInit },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(
      readonly url: URL,
      options: { requestInit?: RequestInit },
    ) {
      mocks.options = options;
    }
  },
}));

function sseConfig(headers: Record<string, string>): MCPServerConfig {
  return {
    type: 'sse',
    url: 'https://example.test/sse',
    headers,
  } as MCPServerConfig;
}

function sentHeaders(): Headers {
  return new Headers(mocks.options?.requestInit?.headers);
}

beforeEach(() => {
  mocks.options = undefined;
  vi.unstubAllEnvs();
});

describe('createSSETransportWithAuth', () => {
  it('strips host-reserved headers from connection-level config', async () => {
    const dispose = registerReservedMcpHeader('X-Test-Reserved');
    try {
      await createSSETransportWithAuth(
        'sse-server',
        sseConfig({
          'X-Test-Reserved': 'forged',
          'X-Qoder-Model': 'forged-model',
          'X-Keep': 'keep',
        }),
        'token',
      );

      const headers = sentHeaders();
      expect(headers.get('X-Test-Reserved')).toBeNull();
      expect(headers.get('X-Qoder-Model')).toBeNull();
      expect(headers.get('X-Keep')).toBe('keep');
      expect(headers.get('Authorization')).toBe('Bearer token');
    } finally {
      dispose();
    }
  });

  it('expands env vars in configured headers like the other transports', async () => {
    vi.stubEnv('SSE_HEADER_VALUE', 'expanded');

    await createSSETransportWithAuth(
      'sse-server',
      sseConfig({ 'X-From-Env': '${SSE_HEADER_VALUE}' }),
    );

    expect(sentHeaders().get('X-From-Env')).toBe('expanded');
  });
});
