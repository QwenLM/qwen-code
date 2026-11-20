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
  baseUrl?: string;
  customHeaders?: Record<string, string>;
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
}: GeneratorOptions = {}) {
  return new LlmContentGenerator(
    {
      apiKey,
      vertexai,
      httpOptions: { baseUrl, headers: customHeaders ?? {} },
    },
    { model: 'gemini-test', customHeaders },
  );
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
    { model: 'gemini-test', contents: 'hello' },
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

async function readStreamText(response: Response): Promise<string> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const stream = await makeGenerator().generateContentStream(
    { model: 'gemini-test', contents: 'hello' },
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
