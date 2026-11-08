/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content, GenerateContentResponse } from '@google/genai';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './provider/default.js';
import type {
  ContentGeneratorConfig,
  InputModalities,
} from '../contentGenerator.js';
import { AuthType } from '../../utils/auth-type.js';
import type { Config } from '../../config/config.js';
import { getErrorStatus } from '../../utils/errors.js';
import { collect, userText } from '../../test-utils/model-fixtures.js';

/**
 * End-to-end repro for #10693: an OpenAI-compatible route that serves
 * text fine but 400s any request carrying an inline media part (the
 * idealab preset family rejecting `image_url` data URLs with
 * "用户没有正确设置模型参数"). A real local HTTP server plays the gateway:
 * bodies containing an inline media part get a 400, everything else gets
 * a valid chat completion. Drives the real OpenAI SDK + pipeline path.
 *
 * Pre-fix behaviour (the bug): the image-bearing request throws the 400
 * straight to the user, exactly one wire request is made, and the only
 * affordance is a retry that resends the identical history — the turn is
 * wedged until the user finds generationConfig.modalities.image=false.
 */

const GATEWAY_REJECTION = JSON.stringify({
  error: {
    message: '用户没有正确设置模型参数',
    type: 'invalid_request_error',
    code: 'invalid_parameter',
  },
});

// 1x1 JPEG, base64 — a fully valid, decodable image, like the re-encoded
// JPEG that image-view.ts puts on the wire in the report.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

const MODEL = 'qwen3.8-max-dogfooding';
const WIRE_MEDIA_TYPES = ['image_url', 'input_audio', 'video_url', 'file'];
type WireMediaType = 'image_url' | 'input_audio' | 'video_url' | 'file';

type MediaCase = {
  name: string;
  mimeType: string;
  modalities: InputModalities;
  wireType: WireMediaType;
};

const mediaCase = (
  name: string,
  mimeType: string,
  modalities: InputModalities,
  wireType: WireMediaType,
): MediaCase => ({ name, mimeType, modalities, wireType });

const MEDIA_CASES: MediaCase[] = [
  mediaCase('image', 'image/jpeg', { image: true }, 'image_url'),
  mediaCase('audio', 'audio/wav', { audio: true }, 'input_audio'),
  mediaCase('video', 'video/mp4', { video: true }, 'video_url'),
  mediaCase('pdf', 'application/pdf', { pdf: true }, 'file'),
];

let server: Server;
let baseUrl: string;
const receivedBodies: Array<Record<string, unknown>> = [];

function requestHasInlineMedia(body: Record<string, unknown>): boolean {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    const content = (message as { content?: unknown }).content;
    return (
      Array.isArray(content) &&
      content.some((part) =>
        WIRE_MEDIA_TYPES.includes((part as { type?: unknown }).type as string),
      )
    );
  });
}

/** A chat completion (or chunk) from the fake gateway answering `ok`. */
function completion(object: string, choice: Record<string, unknown>) {
  return {
    id: 'chatcmpl-test',
    object,
    created: 1,
    model: MODEL,
    choices: [{ index: 0, ...choice, finish_reason: 'stop' }],
  };
}

beforeAll(async () => {
  // Same bootstrap as the app entrypoint: buildClient installs an undici
  // dispatcher, which requires the runtime fetch module to be preloaded.
  const { preloadRuntimeFetchModule } = await import(
    '../../utils/runtimeFetchOptions.js'
  );
  await preloadRuntimeFetchModule();

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      receivedBodies.push(body as Record<string, unknown>);
      const serializedBody = JSON.stringify(body);
      const respond = (status: number, contentType: string, text: string) => {
        res.writeHead(status, { 'Content-Type': contentType });
        res.end(text);
      };
      const hasInlineMedia = requestHasInlineMedia(
        body as Record<string, unknown>,
      );
      if (hasInlineMedia || serializedBody.includes('REJECT_ALWAYS_MARKER')) {
        return respond(400, 'application/json', GATEWAY_REJECTION);
      }
      if (serializedBody.includes('RETRY_429_MARKER')) {
        return respond(429, 'application/json', GATEWAY_REJECTION);
      }
      if (body['stream'] === true) {
        const chunk = completion('chat.completion.chunk', {
          delta: { role: 'assistant', content: 'ok' },
        });
        return respond(
          200,
          'text/event-stream',
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        );
      }
      respond(
        200,
        'application/json',
        JSON.stringify({
          ...completion('chat.completion', {
            message: { role: 'assistant', content: 'ok' },
          }),
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function createGenerator(modalities?: InputModalities): OpenAIContentGenerator {
  const contentGeneratorConfig: ContentGeneratorConfig = {
    model: MODEL,
    apiKey: 'test-key',
    baseUrl,
    authType: AuthType.USE_OPENAI,
    maxRetries: 0,
    ...(modalities ? { modalities } : {}),
  };
  const cliConfig = {
    getCliVersion: () => '0.0.0-test',
    getProxy: () => undefined,
    getSessionId: () => 'test-session',
  } as unknown as Config;
  const provider = new DefaultOpenAICompatibleProvider(
    contentGeneratorConfig,
    cliConfig,
  );
  return new OpenAIContentGenerator(
    contentGeneratorConfig,
    cliConfig,
    provider,
  );
}

/** Clears the wire log, then sends one non-streaming request. */
function generate(
  modalities: InputModalities | undefined,
  contents: Content[],
  promptId: string,
): Promise<GenerateContentResponse> {
  receivedBodies.length = 0;
  const generator = createGenerator(modalities);
  return generator.generateContent({ model: MODEL, contents }, promptId);
}

/** Like `generate`, but returns what the request rejected with. */
async function generateError(
  ...args: Parameters<typeof generate>
): Promise<unknown> {
  try {
    await generate(...args);
  } catch (error) {
    return error;
  }
  return undefined;
}

const hasOkText = (response: GenerateContentResponse) =>
  response.candidates?.[0]?.content?.parts?.some((part) => part.text === 'ok');

function mediaBearingContents(
  media: MediaCase = MEDIA_CASES[0]!,
  text = 'what is in this file?',
): Content[] {
  return [
    {
      role: 'user',
      parts: [
        { text },
        {
          inlineData: {
            mimeType: media.mimeType,
            data: media.name === 'image' ? TINY_JPEG_BASE64 : 'base64data',
            displayName: `${media.name}.bin`,
          },
        },
      ],
    },
  ];
}

function bodyHasPlaceholder(
  body: Record<string, unknown>,
  placeholder = 'Unsupported image file',
): boolean {
  return JSON.stringify(body).includes(placeholder);
}

function bodyHasPartType(
  body: Record<string, unknown>,
  type: WireMediaType,
): boolean {
  return JSON.stringify(body).includes(`"type":"${type}"`);
}

describe('issue #10693: gateway 400 on media-bearing OpenAI-compatible requests', () => {
  it.each(MEDIA_CASES)(
    'recovers $name by retrying once with the media degraded to a placeholder',
    async (media) => {
      const response = await generate(
        media.modalities,
        mediaBearingContents(media),
        `prompt-10693-${media.name}`,
      );

      expect(hasOkText(response)).toBe(true);
      expect(receivedBodies).toHaveLength(2);
      expect(bodyHasPartType(receivedBodies[0]!, media.wireType)).toBe(true);
      expect(requestHasInlineMedia(receivedBodies[1]!)).toBe(false);
      expect(
        bodyHasPlaceholder(
          receivedBodies[1]!,
          `Unsupported ${media.name} file`,
        ),
      ).toBe(true);
    },
  );

  it('recovers the streaming path after the media-bearing request is rejected', async () => {
    receivedBodies.length = 0;
    const generator = createGenerator({ image: true });

    const stream = await generator.generateContentStream(
      { model: MODEL, contents: mediaBearingContents() },
      'prompt-10693-stream',
    );
    const responses: GenerateContentResponse[] = await collect(stream);

    expect(responses.some(hasOkText)).toBe(true);
    expect(receivedBodies).toHaveLength(2);
    expect(requestHasInlineMedia(receivedBodies[0]!)).toBe(true);
    expect(requestHasInlineMedia(receivedBodies[1]!)).toBe(false);
    expect(bodyHasPlaceholder(receivedBodies[1]!)).toBe(true);
  });

  it.each([
    ['the same 400', 'REJECT_ALWAYS_MARKER', 400],
    ['a different 429', 'RETRY_429_MARKER', 429],
  ] as const)(
    'surfaces %s when the degraded retry fails',
    async (_, marker, status) => {
      const caught = await generateError(
        { image: true },
        mediaBearingContents(MEDIA_CASES[0]!, marker),
        'prompt-10693-retry-failure',
      );

      expect(getErrorStatus(caught)).toBe(status);
      expect(receivedBodies).toHaveLength(2);
      expect(requestHasInlineMedia(receivedBodies[1]!)).toBe(false);
      expect(bodyHasPlaceholder(receivedBodies[1]!)).toBe(true);
    },
  );

  it('keeps text-only requests on the single-attempt path', async () => {
    const response = await generate(
      { image: true },
      [{ role: 'user', parts: [{ text: 'plain text turn' }] }],
      'prompt-10693-text',
    );

    expect(hasOkText(response)).toBe(true);
    expect(receivedBodies).toHaveLength(1);
  });

  it('leaves the explicit modality-off placeholder path unchanged', async () => {
    // No modalities set → the converter's existing placeholder path fires
    // on the first attempt; the gateway never sees an image part.
    const response = await generate(
      undefined,
      mediaBearingContents(),
      'prompt-10693-off',
    );

    expect(hasOkText(response)).toBe(true);
    expect(receivedBodies).toHaveLength(1);
    expect(requestHasInlineMedia(receivedBodies[0]!)).toBe(false);
    expect(bodyHasPlaceholder(receivedBodies[0]!)).toBe(true);
  });

  it('surfaces non-media 400s unchanged, without a degradation retry', async () => {
    // No media in this request, so the gateway's 400 cannot be the media
    // shape and must reach the user as before.
    const caught = await generateError(
      { image: true },
      [userText('some REJECT_ALWAYS_MARKER request')],
      'prompt-10693-non-media',
    );

    expect(caught).toBeDefined();
    expect(getErrorStatus(caught)).toBe(400);
    expect(receivedBodies).toHaveLength(1);
  });
});
