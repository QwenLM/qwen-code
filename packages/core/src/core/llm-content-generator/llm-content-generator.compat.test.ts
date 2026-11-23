/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmContentGenerator } from './llm-content-generator.js';

const PROXY_URL = 'https://proxy.example.test';
const OFFICIAL_URL = 'https://generativelanguage.googleapis.com';

type GeneratorOptions = {
  apiKey?: string;
  vertexai?: boolean;
  baseUrl?: string | null;
  customHeaders?: Record<string, string>;
  httpHeaders?: Record<string, string>;
  requestBaseUrl?: string;
  requestHeaders?: Record<string, string>;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function makeGenerator({
  apiKey = 'fallback-key',
  vertexai,
  baseUrl = PROXY_URL,
  customHeaders,
  httpHeaders,
}: GeneratorOptions = {}) {
  return new LlmContentGenerator(
    {
      apiKey,
      vertexai,
      httpOptions: {
        baseUrl: baseUrl ?? undefined,
        headers: { ...httpHeaders, ...customHeaders },
      },
    },
    { model: 'gemini-test', customHeaders },
  );
}

function requestConfig(options: GeneratorOptions) {
  if (!options.requestBaseUrl && !options.requestHeaders) return undefined;
  return {
    httpOptions: {
      baseUrl: options.requestBaseUrl,
      headers: options.requestHeaders,
    },
  };
}

async function captureRequestHeaders(
  options: GeneratorOptions,
): Promise<Headers> {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      candidates: [{ content: { parts: [{ text: 'answer' }], role: 'model' } }],
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await makeGenerator(options).generateContent(
    {
      model: 'gemini-test',
      contents: 'hello',
      config: requestConfig(options),
    },
    'prompt-id',
  );
  return new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
}

describe('proxy and Vertex authentication routing', () => {
  it('adds Bearer auth from the existing credential on a Gemini proxy', async () => {
    const headers = await captureRequestHeaders({});
    expect(headers.get('authorization')).toBe('Bearer fallback-key');
    expect(headers.get('x-goog-api-key')).toBe('fallback-key');
  });

  it('does not add Bearer auth on the official Gemini route', async () => {
    const headers = await captureRequestHeaders({ baseUrl: OFFICIAL_URL });
    expect(headers.has('authorization')).toBe(false);
  });

  it('does not add Bearer auth when the SDK config selects Vertex', async () => {
    const headers = await captureRequestHeaders({ vertexai: true });
    expect(headers.has('authorization')).toBe(false);
  });

  it('does not add Bearer auth when the SDK environment selects Vertex', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'TRUE');
    const headers = await captureRequestHeaders({ vertexai: undefined });
    expect(headers.has('authorization')).toBe(false);
  });

  it('honors an explicit native proxy key without adding the fallback key', async () => {
    const headers = await captureRequestHeaders({
      customHeaders: { 'X-Goog-Api-Key': 'proxy-key' },
    });
    expect(headers.get('x-goog-api-key')).toBe('proxy-key');
    expect(headers.has('authorization')).toBe(false);
  });

  it('preserves an explicit Authorization header without duplicating it', async () => {
    const headers = await captureRequestHeaders({
      customHeaders: { authorization: 'Bearer proxy-key' },
    });
    expect(headers.get('authorization')).toBe('Bearer proxy-key');
  });

  it('honors a native key supplied only at request level', async () => {
    const headers = await captureRequestHeaders({
      requestHeaders: { 'x-goog-api-key': 'request-key' },
    });
    expect(headers.get('x-goog-api-key')).toBe('request-key');
    expect(headers.has('authorization')).toBe(false);
  });

  it('honors a native key supplied only at SDK-construction level', async () => {
    const headers = await captureRequestHeaders({
      httpHeaders: { 'x-goog-api-key': 'constructor-key' },
    });
    expect(headers.get('x-goog-api-key')).toBe('constructor-key');
    expect(headers.has('authorization')).toBe(false);
  });

  it.each(['requestHeaders', 'httpHeaders'])(
    'does not add Bearer for an explicit equal-value native key in %s',
    async (source) => {
      const definition: GeneratorOptions = {
        apiKey: 'cred-key',
        [source]: { 'x-goog-api-key': 'cred-key' },
      };
      const headers = await captureRequestHeaders(definition);
      expect(headers.get('x-goog-api-key')).toBe('cred-key');
      expect(headers.has('authorization')).toBe(false);
    },
  );

  it('uses an ambient Gemini proxy URL for destination-aware auth', async () => {
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', PROXY_URL);
    const headers = await captureRequestHeaders({ baseUrl: null });
    expect(headers.get('authorization')).toBe('Bearer fallback-key');
    expect(headers.get('x-goog-api-key')).toBe('fallback-key');
  });

  it('classifies Bearer auth by request destination rather than constructor URL', async () => {
    const official = await captureRequestHeaders({
      requestBaseUrl: OFFICIAL_URL,
    });
    expect(official.has('authorization')).toBe(false);

    const proxy = await captureRequestHeaders({
      baseUrl: OFFICIAL_URL,
      requestBaseUrl: PROXY_URL,
    });
    expect(proxy.get('authorization')).toBe('Bearer fallback-key');
  });
});

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function readStreamText(
  response: Response,
  options: GeneratorOptions = {},
): Promise<string> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const stream = await makeGenerator(options).generateContentStream(
    {
      model: 'gemini-test',
      contents: 'hello',
      config: requestConfig(options),
    },
    'prompt-id',
  );
  let text = '';
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) text += part.text;
    }
  }
  return text;
}

const candidate = JSON.stringify({
  candidates: [
    {
      content: { parts: [{ text: 'answer' }], role: 'model' },
      finishReason: 'STOP',
    },
  ],
});
const chunkings: Array<['whole' | 'bytes', (body: string) => string[]]> = [
  ['whole', (body) => [body]],
  ['bytes', (body) => Array.from(body)],
];

describe('SSE sentinel compatibility', () => {
  it.each(chunkings)(
    'uses the real SDK stream parser with %s chunks',
    async (_label, chunks) => {
      for (const delimiter of ['\n\n', '\r\n\r\n', '\r\r']) {
        const body = `data: ${candidate}${delimiter}data: [DONE]${delimiter}`;
        await expect(readStreamText(sseResponse(chunks(body)))).resolves.toBe(
          'answer',
        );
      }
    },
  );

  it.each(['DONE', '[DONE]x'])(
    'rejects invalid data marker %s',
    async (marker) => {
      await expect(
        readStreamText(sseResponse([`data: ${marker}\n\n`])),
      ).rejects.toThrow(SyntaxError);
    },
  );

  it('applies sentinel handling by request destination only', async () => {
    const body = `data: ${candidate}\n\ndata: [DONE]\n\n`;
    await expect(
      readStreamText(sseResponse([body]), {
        baseUrl: PROXY_URL,
        requestBaseUrl: OFFICIAL_URL,
      }),
    ).rejects.toThrow(SyntaxError);
    await expect(
      readStreamText(sseResponse([body]), {
        baseUrl: OFFICIAL_URL,
        requestBaseUrl: PROXY_URL,
      }),
    ).resolves.toBe('answer');
  });

  it('cancels the original response body when the sentinel arrives', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${candidate}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );

    await expect(readStreamText(response)).resolves.toBe('answer');
    expect(cancelled).toBe(true);
  });

  it.each(['terminated', 'ECONNRESET'])(
    'returns a complete answer when body cancellation after the sentinel fails: %s',
    async (message) => {
      const response = new Response(`data: ${candidate}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
      Object.defineProperty(response.body, 'cancel', {
        value: () => Promise.reject(new Error(message)),
      });

      await expect(readStreamText(response)).resolves.toBe('answer');
    },
  );

  it('does not end on text that only mentions the sentinel', async () => {
    const body = `data: ${candidate.replace('answer', '[DONE]')}\n\n`;
    await expect(readStreamText(sseResponse([body]))).resolves.toBe('[DONE]');
  });

  it('rejects trailing data after the sentinel', async () => {
    await expect(
      readStreamText(sseResponse(['data: [DONE] trailing\n\n'])),
    ).rejects.toThrow(SyntaxError);
  });

  it('preserves the SDK incomplete-segment error at EOF', async () => {
    await expect(readStreamText(sseResponse(['data: [DONE]']))).rejects.toThrow(
      'Incomplete JSON segment at the end',
    );
  });
});
