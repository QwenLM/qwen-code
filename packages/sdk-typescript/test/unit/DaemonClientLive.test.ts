/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit | null;
}

function recordingFetch(body: unknown): {
  fetch: typeof globalThis.fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ?? null,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const readyStatus = {
  v: 1 as const,
  available: true,
  state: 'idle' as const,
  requirements: {
    host: 'ready' as const,
    microphone: 'ready' as const,
    inputMonitoring: 'ready' as const,
    accessibility: 'ready' as const,
    screenRecording: 'ready' as const,
    provider: 'ready' as const,
  },
};

describe('DaemonClient Live Voice helpers', () => {
  it('uses process-global Live routes with bearer and client identity', async () => {
    const { fetch, calls } = recordingFetch(readyStatus);
    const client = new DaemonClient({
      baseUrl: 'http://daemon/',
      token: 'daemon-token',
      fetch,
    });

    await client.liveStatus('client-1');
    await client.startLive('resume', 'client-2');
    await client.startLive('new', 'client-3');
    await client.stopLive('client-4');
    await client.setLiveMute(
      { inputMuted: true, outputMuted: false },
      'client-5',
    );

    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: 'http://daemon/live/status', method: 'GET' },
      { url: 'http://daemon/live/start', method: 'POST' },
      { url: 'http://daemon/live/new', method: 'POST' },
      { url: 'http://daemon/live/stop', method: 'POST' },
      { url: 'http://daemon/live/mute', method: 'POST' },
    ]);
    expect(calls.map((call) => call.headers['authorization'])).toEqual(
      new Array(5).fill('Bearer daemon-token'),
    );
    expect(calls.map((call) => call.headers['x-qwen-client-id'])).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-4',
      'client-5',
    ]);
    expect(JSON.parse(String(calls[4]?.body))).toEqual({
      inputMuted: true,
      outputMuted: false,
    });
  });

  it('keeps Live process-global through a workspace client', async () => {
    const { fetch, calls } = recordingFetch(readyStatus);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const workspace = client.workspaceByCwd('/work with space');

    await expect(workspace.liveStatus()).resolves.toEqual(readyStatus);
    await workspace.startLive('new');

    expect(calls.map((call) => call.url)).toEqual([
      'http://daemon/live/status',
      'http://daemon/live/new',
    ]);
  });
});
