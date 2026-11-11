/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
const storage = vi.hoisted(() => ({
  adoptLegacy: vi.fn(async () => {
    order.push('adopt');
  }),
}));
const forServer = vi.hoisted(() => vi.fn(() => storage));
const providers = vi.hoisted(() => [] as unknown[]);

vi.mock('../oauth-token-storage.js', () => ({
  MCPOAuthTokenStorage: { forServer },
}));
vi.mock('./oauth/token-provider.js', () => ({
  McpOAuthTokenProvider: class {
    constructor(_name: string, _oauth: unknown, tokenStorage: unknown) {
      order.push('provider');
      providers.push(tokenStorage);
    }
    async tokens() {
      return undefined;
    }
  },
}));
vi.mock('./transport/headers-helper.js', () => ({
  getMcpHeadersFromHelper: async () => ({}),
}));
vi.mock('./transport/support.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createTransportRequestInit: () => ({}),
  createMcpTransportFetch: () => undefined,
}));

import { prepareHttpConnection } from './httpPreparation.js';

describe('prepareHttpConnection', () => {
  it('moves legacy credentials to the server identity before any token is read', async () => {
    const config = { url: 'https://mcp.example.com/mcp', oauth: { enabled: true } };

    await prepareHttpConnection(
      { serverName: 'github', config },
      {
        cliConfig: { emitMcpDiagnostic: vi.fn(), sanitizationConfig: {} },
      } as never,
    );

    expect(forServer).toHaveBeenCalledWith('github', config);
    expect(order).toEqual(['adopt', 'provider']);
    // The token provider reads and refreshes through the same storage.
    expect(providers).toEqual([storage]);
  });
});
