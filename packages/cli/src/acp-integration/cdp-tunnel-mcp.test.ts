/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCdpTunnelMcpServer } from './acpAgent.js';

describe('buildCdpTunnelMcpServer — CDP tunnel auto-wiring (#5626)', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
  });
  afterEach(() => {
    process.env = saved;
  });

  it('returns undefined when the tunnel flag is off', () => {
    delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    process.env['QWEN_SERVE_CDP_TUNNEL_PORT'] = '4170';
    expect(buildCdpTunnelMcpServer()).toBeUndefined();
  });

  it('returns undefined when the forwarded port is missing or invalid', () => {
    process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = '1';
    delete process.env['QWEN_SERVE_CDP_TUNNEL_PORT'];
    expect(buildCdpTunnelMcpServer()).toBeUndefined();
    process.env['QWEN_SERVE_CDP_TUNNEL_PORT'] = '0';
    expect(buildCdpTunnelMcpServer()).toBeUndefined();
  });

  it('builds a stdio chrome-devtools-mcp server aimed at the daemon /cdp', () => {
    process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = '1';
    process.env['QWEN_SERVE_CDP_TUNNEL_PORT'] = '4170';
    const server = buildCdpTunnelMcpServer();
    expect(server).toBeDefined();
    expect(server?.command).toBe(process.execPath);
    expect(server?.args?.[0]).toMatch(/chrome-devtools-mcp/);
    expect(server?.args).toContain('--wsEndpoint');
    expect(server?.args).toContain('ws://127.0.0.1:4170/cdp');
    // trust unset → tools default to 'ask' (no silent auto-approval of
    // browser-driving tools), same as any project MCP server.
    expect(server?.trust).toBeUndefined();
  });
});
