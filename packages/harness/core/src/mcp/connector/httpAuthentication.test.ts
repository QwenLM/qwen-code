/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { authenticateHttpConnection } from './httpAuthentication.js';
import { McpAuthorizationRequiredError } from '../authorization.js';
import { UnauthorizedError } from '../../utils/errors.js';

describe('authenticateHttpConnection', () => {
  it('rethrows a managed authorization action instead of starting generic OAuth', async () => {
    const connectTransport = vi.fn(async () => {});
    const authorizationError = new McpAuthorizationRequiredError({
      type: 'open_url',
      serverId: 'user:apphub',
      connectionId: 'conn-1',
      authorizationRequestId: 'auth-1',
      url: new URL('https://auth.example.test/start'),
      expiresAtMs: Date.now() + 60_000,
    });
    const wrapped = new UnauthorizedError('MCP server requires authentication');
    (wrapped as Error & { cause?: unknown }).cause = authorizationError;

    await expect(
      authenticateHttpConnection(
        'srv',
        { url: 'https://mcp.example.com/mcp' },
        { emitMcpDiagnostic: vi.fn(), sanitizationConfig: {} } as never,
        { error: wrapped, httpReturned404: false },
        connectTransport,
      ),
    ).rejects.toBe(authorizationError);
    expect(connectTransport).not.toHaveBeenCalled();
  });

  it('does not turn a rejected static Authorization into an OAuth flow', async () => {
    const connectTransport = vi.fn(async () => {});

    await expect(
      authenticateHttpConnection(
        'srv',
        {
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer static' },
        },
        { emitMcpDiagnostic: vi.fn(), sanitizationConfig: {} } as never,
        { error: new Error('401'), httpReturned404: false },
        connectTransport,
      ),
    ).rejects.toThrow(/static Authorization/);
    expect(connectTransport).not.toHaveBeenCalled();
  });
});
