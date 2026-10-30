/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  postSessionSend,
  readSessionSendMcpUrl,
  sessionSendMcpCommand,
} from './session-send-mcp.js';

const { runSessionSendMcp } = vi.hoisted(() => ({
  runSessionSendMcp: vi.fn(async (_url: string) => {}),
}));
vi.mock('./session-send-mcp-server.js', () => ({ runSessionSendMcp }));

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

  it('loads the MCP server only when the command runs', async () => {
    // config.ts registers this command on every `qwen` start.
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'session-send-mcp.ts',
      ),
      'utf8',
    );
    expect(source).not.toMatch(/from '@modelcontextprotocol\//);
    expect(source).not.toMatch(/from 'zod'/);

    await (
      sessionSendMcpCommand.handler as (argv: { url: string }) => Promise<void>
    )({ url: 'http://127.0.0.1:1/send' });
    expect(runSessionSendMcp).toHaveBeenCalledWith('http://127.0.0.1:1/send');
  });

  it('reads the endpoint the daemon passes, and nothing else', () => {
    expect(readSessionSendMcpUrl(['--url', 'http://127.0.0.1:1/s'])).toBe(
      'http://127.0.0.1:1/s',
    );
    expect(readSessionSendMcpUrl(['--url=http://127.0.0.1:1/s'])).toBe(
      'http://127.0.0.1:1/s',
    );
    expect(readSessionSendMcpUrl([])).toBeUndefined();
    expect(readSessionSendMcpUrl(['--url'])).toBeUndefined();
    expect(readSessionSendMcpUrl(['--url='])).toBeUndefined();
    expect(
      readSessionSendMcpUrl(['--url', 'http://127.0.0.1:1/s', '--debug']),
    ).toBeUndefined();
  });
});
