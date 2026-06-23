/**
 * @license
 * Copyright 2026 Qwen Team
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(
  reply: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      }
      const captured = {
        url,
        method: init?.method ?? 'GET',
        headers,
        body: init?.body ?? null,
      };
      calls.push(captured);
      return reply(captured);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe('DaemonClient voice helpers', () => {
  it('GETs workspace voice status', async () => {
    const body = {
      v: 1,
      workspaceCwd: '/work',
      enabled: false,
      mode: 'hold',
      language: '',
      voiceModel: null,
      availableVoiceModels: [],
    };
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, body));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(client.workspaceVoice()).resolves.toEqual(body);
    expect(calls[0]?.url).toBe('http://daemon/workspace/voice');
    expect(calls[0]?.method).toBe('GET');
  });

  it('POSTs workspace voice settings with client identity', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, {
        v: 1,
        workspaceCwd: '/work',
        enabled: true,
        mode: 'tap',
        language: 'english',
        voiceModel: 'qwen3-asr-flash',
        availableVoiceModels: [],
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await client.setWorkspaceVoice(
      { enabled: true, mode: 'tap', language: 'english' },
      'client-1',
    );

    expect(calls[0]?.url).toBe('http://daemon/workspace/voice');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      enabled: true,
      mode: 'tap',
      language: 'english',
    });
  });

  it('POSTs binary voice audio with content type and optional voice model', async () => {
    const response = {
      v: 1,
      text: 'hello',
      model: 'qwen3-asr-flash',
      transport: 'qwen-asr-chat',
    };
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, response));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const audio = new Uint8Array([1, 2, 3]);

    await expect(
      client.transcribeWorkspaceVoice(audio, {
        mimeType: 'audio/wav',
        voiceModel: 'qwen3-asr-flash',
        clientId: 'client-1',
      }),
    ).resolves.toEqual(response);

    expect(calls[0]?.url).toBe(
      'http://daemon/workspace/voice/transcribe?voiceModel=qwen3-asr-flash',
    );
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('audio/wav');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    expect(calls[0]?.body).toBe(audio);
  });
});
