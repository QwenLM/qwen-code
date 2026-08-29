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
  shortcut: 'Command+E',
  requirements: {
    host: 'ready' as const,
    microphone: 'ready' as const,
    accessibility: 'ready' as const,
    screenRecording: 'ready' as const,
    provider: 'ready' as const,
  },
};

const setupStatus = {
  v: 1 as const,
  enabled: false,
  keyConfigured: false,
  model: 'qwen3.5-omni-plus-realtime',
  shortcut: 'Command+E',
  install: { state: 'missing' as const },
  live: readyStatus,
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
    await client.setLiveShortcut('Command+E', 'client-6');

    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: 'http://daemon/live/status', method: 'GET' },
      { url: 'http://daemon/live/start', method: 'POST' },
      { url: 'http://daemon/live/new', method: 'POST' },
      { url: 'http://daemon/live/stop', method: 'POST' },
      { url: 'http://daemon/live/mute', method: 'POST' },
      { url: 'http://daemon/live/shortcut', method: 'POST' },
    ]);
    expect(calls.map((call) => call.headers['authorization'])).toEqual(
      new Array(6).fill('Bearer daemon-token'),
    );
    expect(calls.map((call) => call.headers['x-qwen-client-id'])).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-4',
      'client-5',
      'client-6',
    ]);
    expect(JSON.parse(String(calls[4]?.body))).toEqual({
      inputMuted: true,
      outputMuted: false,
    });
    expect(JSON.parse(String(calls[5]?.body))).toEqual({
      shortcut: 'Command+E',
    });
  });

  it('keeps Live process-global through a workspace client', async () => {
    const { fetch, calls } = recordingFetch(readyStatus);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const workspace = client.workspaceByCwd('/work with space');

    await expect(workspace.liveStatus()).resolves.toEqual(readyStatus);
    await workspace.startLive('new');
    await workspace.setLiveShortcut('Command+K');

    expect(calls.map((call) => call.url)).toEqual([
      'http://daemon/live/status',
      'http://daemon/live/new',
      'http://daemon/live/shortcut',
    ]);
  });

  it('uses the dedicated process-global setup routes without reading a key', async () => {
    const { fetch, calls } = recordingFetch(setupStatus);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const workspace = client.workspaceByCwd('/work');

    await workspace.liveSetupStatus('client-setup-1');
    await workspace.updateLiveSetup(
      {
        shortcut: 'Command+K',
        apiKey: { operation: 'replace', value: 'test-dashscope-key' },
      },
      'client-setup-2',
    );
    await workspace.retryLiveHostInstall('client-setup-3');
    await workspace.launchLiveHost('client-setup-4');

    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: 'http://daemon/live/setup', method: 'GET' },
      { url: 'http://daemon/live/setup', method: 'POST' },
      { url: 'http://daemon/live/setup/install', method: 'POST' },
      { url: 'http://daemon/live/setup/launch', method: 'POST' },
    ]);
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      shortcut: 'Command+K',
      apiKey: { operation: 'replace', value: 'test-dashscope-key' },
    });
    expect(calls.map((call) => call.headers['x-qwen-client-id'])).toEqual([
      'client-setup-1',
      'client-setup-2',
      'client-setup-3',
      'client-setup-4',
    ]);
  });
});
