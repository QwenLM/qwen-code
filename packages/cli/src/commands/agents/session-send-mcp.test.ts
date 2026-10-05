/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { postSessionSend, sessionSendMcpCommand } from './session-send-mcp.js';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('session-send-mcp', () => {
  it('is a hidden command', () => {
    expect(sessionSendMcpCommand.command).toBe('session-send-mcp');
    expect(sessionSendMcpCommand.describe).toBe(false);
  });

  it('posts the text with the run token and answers "sent"', async () => {
    const { impl, calls } = fakeFetch(200, { sent: true });
    await expect(
      postSessionSend(
        'http://127.0.0.1:4170/x/send',
        'tok',
        '@Bob please review',
        impl,
      ),
    ).resolves.toBe('sent');
    expect(calls[0]!.url).toBe('http://127.0.0.1:4170/x/send');
    expect(calls[0]!.init.method).toBe('POST');
    expect(
      (calls[0]!.init.headers as Record<string, string>)['Authorization'],
    ).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      text: '@Bob please review',
    });
  });

  it('reports the daemon refusal to the model', async () => {
    const { impl } = fakeFetch(409, {
      error: 'run_not_running',
      message: 'The run is not running.',
    });
    await expect(
      postSessionSend('http://127.0.0.1:1/s', 'tok', 'hi', impl),
    ).rejects.toThrow('HTTP 409: The run is not running.');
  });

  it('refuses without a token', async () => {
    const { impl, calls } = fakeFetch(200, {});
    await expect(
      postSessionSend('http://127.0.0.1:1/s', undefined, 'hi', impl),
    ).rejects.toThrow('QWEN_SESSION_SEND_TOKEN');
    expect(calls).toHaveLength(0);
  });
});
