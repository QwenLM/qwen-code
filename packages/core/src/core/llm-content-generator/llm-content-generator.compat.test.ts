/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Content, Part } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { runtimeFetchState } = vi.hoisted(() => ({
  runtimeFetchState: {
    overrideFetch: undefined as typeof fetch | undefined,
  },
}));

vi.mock('../../utils/runtimeFetchOptions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/runtimeFetchOptions.js')>();
  return {
    ...actual,
    buildRuntimeFetchOptions: (
      sdkType: 'openai' | 'anthropic' | 'gemini',
      proxyUrl?: string,
    ) => {
      if (runtimeFetchState.overrideFetch) {
        return { fetch: runtimeFetchState.overrideFetch };
      }
      return actual.buildRuntimeFetchOptions(sdkType as 'gemini', proxyUrl);
    },
  };
});

import {
  GeminiConnectTimeoutError,
  LlmContentGenerator,
} from './llm-content-generator.js';
import { StreamInactivityTimeoutError } from '../stream-guards.js';
import { slimCompactionInput } from '../../services/compactionInputSlimming.js';
import { applyOssMediaReplacements } from '../../omni/reactive-degrade.js';

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
  runtimeFetchState.overrideFetch = undefined;
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
  runtimeFetchState.overrideFetch = fetchMock;
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
  runtimeFetchState.overrideFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response);
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

describe('real HTTP wire compliance for Gemini functionResponse.parts', () => {
  const PNG_1X1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  async function withLocalGeminiServer<T>(
    run: (
      baseUrl: string,
      capturedBodies: Array<{ url: string; body: Record<string, unknown> }>,
    ) => Promise<T>,
  ): Promise<T> {
    const capturedBodies: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        capturedBodies.push({
          url: req.url ?? '',
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [
              { content: { role: 'model', parts: [{ text: 'ok' }] } },
            ],
          }),
        );
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      return await run(`http://127.0.0.1:${port}`, capturedBodies);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  function assertFunctionResponsePartsWireSchema(
    body: Record<string, unknown>,
  ) {
    const contents = body['contents'] as Array<{
      parts?: Array<{
        functionResponse?: {
          parts?: Array<Record<string, unknown>>;
        };
      }>;
    }>;
    for (const content of contents) {
      for (const part of content.parts ?? []) {
        const frParts = part.functionResponse?.parts;
        if (!frParts) continue;
        expect(frParts.length).toBeGreaterThan(0);
        for (const frPart of frParts) {
          const keys = Object.keys(frPart);
          expect(keys).toHaveLength(1);
          expect(['inlineData', 'fileData']).toContain(keys[0]);
          if (keys[0] === 'inlineData') {
            const blobKeys = Object.keys(
              frPart['inlineData'] as Record<string, unknown>,
            );
            for (const key of blobKeys) {
              expect(['mimeType', 'data']).toContain(key);
            }
          } else {
            const fileKeys = Object.keys(
              frPart['fileData'] as Record<string, unknown>,
            );
            for (const key of fileKeys) {
              expect(['fileUri', 'mimeType']).toContain(key);
            }
          }
        }
      }
    }
  }

  it.each([false, true])(
    'serializes compliant wire JSON over real HTTP for both Developer API and Vertex (vertexai=%s)',
    async (vertexai) => {
      await withLocalGeminiServer(async (baseUrl, capturedBodies) => {
        const generator = new LlmContentGenerator(
          {
            apiKey: 'local-test-key',
            vertexai,
            httpOptions: { baseUrl },
          },
          { model: 'gemini-test' },
        );

        const contents: Content[] = [
          {
            role: 'user',
            parts: [
              {
                text: 'Reattached summary',
                partMetadata: { 'qwen-code:reattach-boundary': true },
              },
              {
                functionResponse: {
                  id: 'call-mixed',
                  name: 'read_file',
                  response: { output: '' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'VIDEO/WEBM',
                        data: 'GkXfo59C',
                        displayName: 'video.webm',
                      },
                    },
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: PNG_1X1,
                        displayName: 'shot.png',
                        extraKey: 'must-be-dropped',
                      } as Part['inlineData'],
                      partMetadata: { nested: true },
                    } as Part,
                  ] as NonNullable<
                    NonNullable<Part['functionResponse']>['parts']
                  >,
                },
              },
            ],
          },
        ];

        await generator.generateContent(
          { model: 'gemini-test', contents },
          'wire-test',
        );

        expect(capturedBodies).toHaveLength(1);
        const wireBody = capturedBodies[0]!.body;
        assertFunctionResponsePartsWireSchema(wireBody);

        const sentContents = wireBody['contents'] as Array<{
          role: string;
          parts: Array<{
            text?: string;
            inlineData?: Record<string, unknown>;
            functionResponse?: Record<string, unknown>;
          }>;
        }>;
        const sentFr = sentContents[0]!.parts[1]!.functionResponse!;
        expect(sentFr['response']).toEqual({
          output: 'Attached video/webm (video.webm) in following user message.',
        });
        expect(sentFr['parts']).toEqual([
          { inlineData: { mimeType: 'image/png', data: PNG_1X1 } },
        ]);
        expect(sentContents[1]).toEqual({
          role: 'user',
          parts: [
            { text: 'Attached media from tool output:' },
            { inlineData: { mimeType: 'video/webm', data: 'GkXfo59C' } },
          ],
        });
      });
    },
  );

  it.each([false, true])(
    'keeps nested audio/video inside functionResponse.parts over real HTTP for Gemini 3+ (vertexai=%s)',
    async (vertexai) => {
      await withLocalGeminiServer(async (baseUrl, capturedBodies) => {
        const generator = new LlmContentGenerator(
          { apiKey: 'local-test-key', vertexai, httpOptions: { baseUrl } },
          { model: 'gemini-3.0-flash' },
        );
        const contents: Content[] = [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-g3',
                  name: 'read_file',
                  response: { output: '' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'VIDEO/WEBM',
                        data: 'GkXfo59C',
                        displayName: 'video.webm',
                      },
                    },
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: PNG_1X1,
                        displayName: 'shot.png',
                      },
                    },
                  ] as NonNullable<
                    NonNullable<Part['functionResponse']>['parts']
                  >,
                },
              },
            ],
          },
        ];
        await generator.generateContent(
          { model: 'gemini-3.0-flash', contents },
          'wire-test-g3',
        );
        const wireBody = capturedBodies[0]!.body;
        assertFunctionResponsePartsWireSchema(wireBody);
        const sentContents = wireBody['contents'] as Array<{
          parts: Array<{ functionResponse?: Record<string, unknown> }>;
        }>;
        expect(sentContents).toHaveLength(1);
        expect(sentContents[0]!.parts[0]!.functionResponse).toMatchObject({
          response: { output: '' },
          parts: [
            { inlineData: { mimeType: 'video/webm', data: 'GkXfo59C' } },
            { inlineData: { mimeType: 'image/png', data: PNG_1X1 } },
          ],
        });
      });
    },
  );

  it('produces compliant wire JSON for real compactionInputSlimming and reactive-degrade outputs', async () => {
    await withLocalGeminiServer(async (baseUrl, capturedBodies) => {
      const generator = new LlmContentGenerator(
        {
          apiKey: 'local-test-key',
          vertexai: false,
          httpOptions: { baseUrl },
        },
        { model: 'gemini-test' },
      );

      // 1. Real compactionInputSlimming replaces nested image with `{ text }`.
      const { slimmedHistory } = slimCompactionInput(
        [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-slim',
                  name: 'read_file',
                  response: { output: 'Image overview: 1x1' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: PNG_1X1 } },
                  ],
                },
              },
            ],
          },
        ],
        { image: false },
      );

      await generator.generateContent(
        { model: 'gemini-test', contents: slimmedHistory },
        'wire-slim',
      );

      // 2. Real applyOssMediaReplacements inserts a disclosure `{ text }` in functionResponse.parts.
      const degradedHistory: Content[] = [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-oss',
                name: 'read_file',
                response: { output: 'ok' },
                parts: [
                  {
                    fileData: {
                      fileUri: 'oss://bucket/orig.jpg',
                      mimeType: 'image/jpeg',
                    },
                  },
                ],
              },
            },
          ],
        },
      ];
      applyOssMediaReplacements(
        degradedHistory,
        new Map([
          [
            'oss://bucket/orig.jpg',
            {
              fileUri: 'oss://bucket/degraded.jpg',
              mimeType: 'image/jpeg',
              disclosureText: '[Image degraded to lower resolution]',
            },
          ],
        ]),
      );

      await generator.generateContent(
        { model: 'gemini-test', contents: degradedHistory },
        'wire-oss',
      );

      expect(capturedBodies).toHaveLength(2);
      for (const entry of capturedBodies) {
        assertFunctionResponsePartsWireSchema(entry.body);
      }

      const slimFr = (
        capturedBodies[0]!.body['contents'] as Array<{
          parts: Array<{ functionResponse: Record<string, unknown> }>;
        }>
      )[0]!.parts[0]!.functionResponse;
      expect(slimFr['parts']).toBeUndefined();
      expect(slimFr['response']).toEqual({
        output: 'Image overview: 1x1\n[image: image/png]',
      });

      const ossFr = (
        capturedBodies[1]!.body['contents'] as Array<{
          parts: Array<{ functionResponse: Record<string, unknown> }>;
        }>
      )[0]!.parts[0]!.functionResponse;
      expect(ossFr['parts']).toEqual([
        {
          fileData: {
            fileUri: 'oss://bucket/degraded.jpg',
            mimeType: 'image/jpeg',
          },
        },
      ]);
      expect(ossFr['response']).toEqual({
        output: 'ok\n[Image degraded to lower resolution]',
      });
    });
  });

  async function withRawServer<T>(
    handler: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      timers: Array<ReturnType<typeof setTimeout>>,
    ) => void,
    run: (baseUrl: string) => Promise<T>,
  ): Promise<T> {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const server = http.createServer((req, res) => handler(req, res, timers));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      return await run(`http://127.0.0.1:${port}`);
    } finally {
      timers.forEach(clearTimeout);
      server.closeAllConnections?.();
      await new Promise<void>((res, rej) =>
        server.close((err) => (err ? rej(err) : res())),
      );
    }
  }

  const localGen = (baseUrl: string, cg: Record<string, unknown> = {}) =>
    new LlmContentGenerator(
      { apiKey: 'local-test-key', vertexai: false, httpOptions: { baseUrl } },
      { model: 'gemini-test', ...cg },
    );

  it('enforces connect-phase timeout (ETIMEDOUT) without synthesizing X-Server-Timeout over real bundled undici', async () => {
    const seenServerTimeouts: Array<string | string[] | undefined> = [];
    await withRawServer(
      (req, res, timers) => {
        seenServerTimeouts.push(req.headers['x-server-timeout']);
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(candidate);
            }
          }, 500),
        );
      },
      async (baseUrl) => {
        await expect(
          localGen(baseUrl, { timeout: 80 }).generateContent(
            { model: 'gemini-test', contents: 'hello' },
            'timeout-wire-test',
          ),
        ).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof GeminiConnectTimeoutError &&
            err.code === 'ETIMEDOUT' &&
            err.connectTimeoutMs === 80,
        );
        expect(seenServerTimeouts).toEqual([undefined]);
      },
    );
  });

  it('does not abort a healthy stream that runs longer than connect timeout once headers arrive', async () => {
    await withRawServer(
      (_req, res, timers) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${candidate}\n\n`);
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write(`data: ${candidate}\n\n`);
              res.end();
            }
          }, 140),
        );
      },
      async (baseUrl) => {
        const stream = await localGen(baseUrl, {
          timeout: 60,
          streamIdleTimeoutMs: 500,
        }).generateContentStream(
          { model: 'gemini-test', contents: 'hello' },
          'long-stream-wire-test',
        );
        const chunks: string[] = [];
        for await (const chunk of stream) {
          if (chunk.text) chunks.push(chunk.text);
        }
        expect(chunks).toEqual(['answer', 'answer']);
      },
    );
  });

  it('enforces shared stream-guards inactivity timeout and aborts socket on early consumer break', async () => {
    let closedCount = 0;
    await withRawServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${candidate}\n\n`);
        res.on('close', () => {
          closedCount += 1;
        });
      },
      async (baseUrl) => {
        const gen = localGen(baseUrl, {
          timeout: 5_000,
          streamIdleTimeoutMs: 80,
        });
        const stream1 = await gen.generateContentStream(
          { model: 'gemini-test', contents: 'hello' },
          'idle-wire-test',
        );
        const chunks1: string[] = [];
        let caught: unknown;
        try {
          for await (const chunk of stream1) {
            if (chunk.text) chunks1.push(chunk.text);
          }
        } catch (err) {
          caught = err;
        }
        expect(chunks1).toEqual(['answer']);
        expect(caught).toBeInstanceOf(StreamInactivityTimeoutError);
        expect((caught as StreamInactivityTimeoutError).code).toBe('ETIMEDOUT');
        expect((caught as StreamInactivityTimeoutError).chunksReceived).toBe(1);

        const stream2 = await gen.generateContentStream(
          { model: 'gemini-test', contents: 'hello' },
          'break-wire-test',
        );
        const chunks2: string[] = [];
        for await (const chunk of stream2) {
          if (chunk.text) chunks2.push(chunk.text);
          break;
        }
        expect(chunks2).toEqual(['answer']);
        await new Promise((r) => setTimeout(r, 40));
        expect(closedCount).toBe(2);
      },
    );
  });
});
