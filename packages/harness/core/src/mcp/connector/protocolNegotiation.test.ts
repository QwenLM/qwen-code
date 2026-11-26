/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import { protocolNegotiationOptions } from './connectMcpServer.js';

function config(overrides: Record<string, unknown>): MCPServerConfig {
  return overrides as MCPServerConfig;
}

describe('protocolNegotiationOptions', () => {
  it('skips negotiation for SDK-hosted servers that still carry a command', () => {
    expect(
      protocolNegotiationOptions(
        config({ type: 'sdk', command: 'npx', args: ['-y', 'pkg'] }),
      ),
    ).toBeUndefined();
  });

  it('lets the SDK budget stdio probes from the connect timeout', () => {
    expect(protocolNegotiationOptions(config({ command: 'npx' }))).toEqual({
      mode: 'auto',
    });
  });

  it('keeps SSE and WebSocket servers on the legacy handshake by default', () => {
    expect(
      protocolNegotiationOptions(config({ type: 'sse', url: 'https://x/sse' })),
    ).toEqual({ mode: 'legacy' });
    expect(
      protocolNegotiationOptions(config({ type: 'ws', url: 'wss://x/ws' })),
    ).toEqual({ mode: 'legacy' });
  });

  it('probes streamable HTTP with the default budget', () => {
    expect(
      protocolNegotiationOptions(config({ httpUrl: 'https://x/mcp' })),
    ).toEqual({ mode: 'auto' });
  });
});
