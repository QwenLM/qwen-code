/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it, vi } from 'vitest';
import { McpManager } from '../mcpManager.js';
import type { McpConnectOutcome } from './types.js';

it('cancels connector preparation, allows same-key re-enable and closes a late transport', async () => {
  let release!: (value: McpConnectOutcome) => void;
  let signal!: AbortSignal;
  const connector = { connect: vi.fn(async (_request, context) => {
    signal = context.signal;
    return new Promise<McpConnectOutcome>(resolve => { release = resolve; });
  }) };
  const pool = new McpManager({} as never, new Map([['http', connector]]), 'test', false,
    { enableEnvironmentVariableRedaction: false, allowedEnvironmentVariables: [], blockedEnvironmentVariables: [] });
  const item = { key: { source: 'managed-admin:org:1' as const, name: 'docs' }, config: { type: 'http' as const, url: 'http://127.0.0.1/mcp' }, rootsDir: '/tmp' };
  const close = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  try {
    const connecting = pool.reloadUserMcpServers([item]);
    await vi.waitFor(() => expect(release).toBeDefined());
    await pool.reloadUserMcpServers([], undefined, undefined, new Set());
    expect(signal.aborted).toBe(true);
    await connecting;
    connector.connect.mockRejectedValueOnce(new Error('second attempt'));
    await pool.reloadUserMcpServers([item]);
    expect(connector.connect).toHaveBeenCalledTimes(2);
    release({ transport: { close, start } as never });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(start).not.toHaveBeenCalled();
  } finally { await pool.dispose(); }
});
