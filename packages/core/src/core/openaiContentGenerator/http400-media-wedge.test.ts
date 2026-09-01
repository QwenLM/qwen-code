/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './provider/default.js';
import type {
  ContentGeneratorConfig,
  InputModalities,
} from '../contentGenerator.js';
import { AuthType } from '../../utils/auth-type.js';
import type { Config } from '../../config/config.js';
import { getErrorStatus } from '../../utils/errors.js';

/**
 * End-to-end repro for #10693: an OpenAI-compatible route that serves
 * text fine but 400s any request carrying an inline media part (the
 * idealab preset family rejecting `image_url` data URLs with
 * "用户没有正确设置模型参数"). A real local HTTP server plays the gateway:
 * bodies containing an `image_url` part get a 400, everything else gets
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
      content.some(
        (part) =>
          (part as { type?: unknown }).type === 'image_url' ||
          (part as { type?: unknown }).type === 'input_audio' ||
          (part as { type?: unknown }).type === 'video_url' ||
          (part as { type?: unknown }).type === 'file',
      )
    );
  });
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
      if (
        requestHasInlineMedia(body as Record<string, unknown>) ||
        JSON.stringify(body).includes('REJECT_ALWAYS_MARKER')
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(GATEWAY_REJECTION);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'qwen3.8-max-dogfooding',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1,
            total_tokens: 11,
          },
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
    model: 'qwen3.8-max-dogfooding',
    apiKey: 'test-key',
    baseUrl,
    authType: AuthType.USE_OPENAI,
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

function imageBearingContents(): Content[] {
  return [
    {
      role: 'user',
      parts: [
        { text: 'what is in this image?' },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: TINY_JPEG_BASE64,
            displayName: 'screenshot.png',
          },
        },
      ],
    },
  ];
}

function bodyHasPlaceholder(body: Record<string, unknown>): boolean {
  return JSON.stringify(body).includes('Unsupported image file');
}

describe('issue #10693: gateway 400 on image-bearing OpenAI-compatible requests', () => {
  it('recovers by retrying once with the media degraded to the placeholder', async () => {
    receivedBodies.length = 0;
    const generator = createGenerator({ image: true });

    const response = await generator.generateContent(
      { model: 'qwen3.8-max-dogfooding', contents: imageBearingContents() },
      'prompt-10693-wedge',
    );

    // The turn is no longer lost: the degraded retry gets a real response.
    expect(
      response.candidates?.[0]?.content?.parts?.some(
        (part) => part.text === 'ok',
      ),
    ).toBe(true);
    // Exactly one degradation retry; the first attempt carried the image.
    expect(receivedBodies).toHaveLength(2);
    expect(requestHasInlineMedia(receivedBodies[0]!)).toBe(true);
    expect(requestHasInlineMedia(receivedBodies[1]!)).toBe(false);
    expect(bodyHasPlaceholder(receivedBodies[1]!)).toBe(true);
  });

  it('keeps text-only requests on the single-attempt path', async () => {
    receivedBodies.length = 0;
    const generator = createGenerator({ image: true });

    const response = await generator.generateContent(
      {
        model: 'qwen3.8-max-dogfooding',
        contents: [{ role: 'user', parts: [{ text: 'plain text turn' }] }],
      },
      'prompt-10693-text',
    );

    expect(
      response.candidates?.[0]?.content?.parts?.some(
        (part) => part.text === 'ok',
      ),
    ).toBe(true);
    expect(receivedBodies).toHaveLength(1);
  });

  it('leaves the explicit modality-off placeholder path unchanged', async () => {
    receivedBodies.length = 0;
    // No modalities set → the converter's existing placeholder path fires
    // on the first attempt; the gateway never sees an image part.
    const generator = createGenerator();

    const response = await generator.generateContent(
      { model: 'qwen3.8-max-dogfooding', contents: imageBearingContents() },
      'prompt-10693-off',
    );

    expect(
      response.candidates?.[0]?.content?.parts?.some(
        (part) => part.text === 'ok',
      ),
    ).toBe(true);
    expect(receivedBodies).toHaveLength(1);
    expect(requestHasInlineMedia(receivedBodies[0]!)).toBe(false);
    expect(bodyHasPlaceholder(receivedBodies[0]!)).toBe(true);
  });

  it('surfaces non-media 400s unchanged, without a degradation retry', async () => {
    receivedBodies.length = 0;
    const generator = createGenerator({ image: true });

    let caught: unknown;
    try {
      await generator.generateContent(
        {
          model: 'qwen3.8-max-dogfooding',
          // No media in this request, so the gateway's 400 cannot be the
          // media shape and must reach the user as before.
          contents: [
            {
              role: 'user',
              parts: [{ text: 'some REJECT_ALWAYS_MARKER request' }],
            },
          ],
        },
        'prompt-10693-non-media',
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(getErrorStatus(caught)).toBe(400);
    expect(receivedBodies).toHaveLength(1);
  });
});
